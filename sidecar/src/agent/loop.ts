// P5 agent loop — the tool-using LLM loop that powers `POST /chat`.
//
// Replaces the P3 single round-trip with an iterate-until-text loop:
//   stream(model with tools)
//     → if it returned tool_calls: execute each, feed results back, re-stream
//     → if it returned text: that's the final answer (already streamed), done
//
// Capped at `maxSteps` (default 12) so a tool-happy model can't loop forever.
// Every interesting beat is surfaced via {@link onEvent} so the route can fan
// it into the SSE stream: text deltas, tool calls + results, live manuscript
// edits (the editor refreshes), and gui_* side-effects.
//
// The loop is provider-agnostic: it only depends on the OpenAI-compatible
// streaming adapter (`streamOpenAIChat`) which assembles fragmented tool-call
// deltas. Persistence (user msg up-front, final assistant msg on completion)
// lives in the route, not here — the loop is pure orchestration.

import type { GuiEvent, ChatEndpointConfig } from "@dissertator/shared";
import {
  streamOpenAIChat,
  type LoopMessage,
  type StreamChatOptions,
  type StreamResult,
  type ToolSpec,
} from "../chat/openai.ts";
import {
  TOOL_SPECS,
  dispatchTool,
  type ToolContext,
  type ToolResult,
} from "./tools.ts";

/** Events the loop emits; the route fans each into a named SSE event. */
export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      args: unknown;
    }
  | {
      type: "tool_result";
      id: string;
      name: string;
      ok: boolean;
      summary: string;
      error?: string;
    }
  | {
      type: "edit";
      documentId: string;
      title: string;
      bodyMd: string;
    }
  | { type: "gui"; gui: GuiEvent };

export interface RunAgentOptions {
  apiKey: string;
  config: ChatEndpointConfig;
  /** Initial messages (system + replayed history + new user message). */
  messages: LoopMessage[];
  /** Tool advertisements; defaults to the full P5 {@link TOOL_SPECS}. */
  tools?: ToolSpec[];
  /** Per-run context for tool execution (embedding key, active doc, gui emit). */
  toolContext: ToolContext;
  /** Aborts the whole run (in-flight fetch + further steps). */
  signal?: AbortSignal;
  /** Fan-in for all stream events (text, tool calls, edits, gui). */
  onEvent: (e: AgentStreamEvent) => Promise<void> | void;
  /** Step cap (default 12). One step = one model round-trip. */
  maxSteps?: number;
  /**
   * Injectable streaming primitive (test seam). Defaults to the real
   * {@link streamOpenAIChat}; tests pass a fake that returns canned tool_calls
   * + text without touching the network.
   */
  streamFn?: (opts: StreamChatOptions) => Promise<StreamResult>;
}

export interface RunAgentResult {
  /** Full assembled assistant text across all steps this run. */
  content: string;
  /** Tool calls executed. */
  toolCalls: number;
  /** True if aborted via signal. */
  aborted: boolean;
  /** Cumulative token usage across steps (provider-reported; may be partial). */
  usage: { prompt: number; completion: number };
  /** True if the loop hit the step cap with tool calls still pending. */
  capped: boolean;
}

/**
 * Run the agent loop to completion (or abort / step cap). Text deltas, tool
 * calls/results, manuscript edits, and gui events flow through `onEvent` as
 * they happen; the final assistant text is returned for persistence.
 */
export async function runAgentLoop(
  opts: RunAgentOptions
): Promise<RunAgentResult> {
  const tools = opts.tools ?? TOOL_SPECS;
  const maxSteps = opts.maxSteps ?? 12;
  const stream = opts.streamFn ?? streamOpenAIChat;
  const messages: LoopMessage[] = [...opts.messages];

  let content = "";
  let toolCallCount = 0;
  let aborted = false;
  let capped = false;
  let finalAnswer = false;
  const usage = { prompt: 0, completion: 0 };

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }
    let stepText = "";
    const res = await stream({
      apiKey: opts.apiKey,
      config: opts.config,
      messages,
      tools,
      signal: opts.signal,
      onDelta: async (d) => {
        stepText += d;
        content += d;
        await opts.onEvent({ type: "delta", text: d });
      },
      onUsage: (p, c) => {
        usage.prompt += p;
        usage.completion += c;
      },
      onAbort: () => {
        aborted = true;
      },
    });
    if (aborted) break;

    if (res.toolCalls.length === 0) {
      // Final answer — text already streamed. Done.
      finalAnswer = true;
      break;
    }

    // Record the assistant turn WITH its tool calls (content may be empty).
    messages.push({
      role: "assistant",
      content: stepText || null,
      tool_calls: res.toolCalls,
    });

    for (const tc of res.toolCalls) {
      toolCallCount++;
      let parsed: Record<string, unknown> | null = null;
      let parseError: string | undefined;
      try {
        parsed = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch (e) {
        parseError = (e as Error).message;
      }
      await opts.onEvent({
        type: "tool_call",
        id: tc.id,
        name: tc.function.name,
        args: parsed,
      });

      let result: ToolResult;
      if (parseError) {
        result = {
          ok: false,
          summary: `⚠️ ${tc.function.name}: bad arguments`,
          error: `invalid JSON arguments: ${parseError}`,
        };
      } else {
        result = await dispatchTool(tc.function.name, parsed, opts.toolContext);
      }

      await opts.onEvent({
        type: "tool_result",
        id: tc.id,
        name: tc.function.name,
        ok: result.ok,
        summary: result.summary,
        ...(result.error ? { error: result.error } : {}),
      });

      if (result.document) {
        await opts.onEvent({
          type: "edit",
          documentId: result.document.id,
          title: result.document.title,
          bodyMd: result.document.bodyMd,
        });
      }

      // The observation the model receives: success payload or {ok,error}.
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content: JSON.stringify(
          result.ok
            ? result.data ?? { ok: true }
            : { ok: false, error: result.error }
        ),
      });
    }
    // Loop: the model now sees the tool results and continues. The for-
    // condition `step < maxSteps` caps total round-trips; if we exit there
    // with tool calls still live (no final text answer, not aborted), the
    // flag below tells the caller the run was truncated.
  }
  if (!aborted && !finalAnswer) capped = true;
  return { content, toolCalls: toolCallCount, aborted, usage, capped };
}
