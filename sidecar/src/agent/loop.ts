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
      sourceId: string;
      title: string;
      bodyMd: string;
    }
  | { type: "gui"; gui: GuiEvent };

export interface RunAgentOptions {
  apiKey: string;
  config: ChatEndpointConfig;
  messages: LoopMessage[];
  tools?: ToolSpec[];
  toolContext: ToolContext;
  signal?: AbortSignal;
  onEvent: (e: AgentStreamEvent) => Promise<void> | void;
  maxSteps?: number;
  stepTimeoutMs?: number;
  streamFn?: (opts: StreamChatOptions) => Promise<StreamResult>;
}

export interface RunAgentResult {
  content: string;
  toolCalls: number;
  aborted: boolean;
  usage: { prompt: number; completion: number };
  capped: boolean;
}

export async function runAgentLoop(
  opts: RunAgentOptions
): Promise<RunAgentResult> {
  const tools = opts.tools ?? TOOL_SPECS;
  const maxSteps = opts.maxSteps ?? 12;
  const stepTimeoutMs = opts.stepTimeoutMs ?? 600_000;
  const stream = opts.streamFn ?? streamOpenAIChat;
  const messages: LoopMessage[] = [...opts.messages];

  let content = "";
  let toolCallCount = 0;
  let aborted = false;
  let capped = false;
  let finalAnswer = false;
  let suggestedReplies = false;
  let nudged = false;
  const usage = { prompt: 0, completion: 0 };

  const ephemeralIds = new Set<string>();
  let prevStepIds = new Set<string>();

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) {
      aborted = true;
      break;
    }

    for (const m of messages) {
      if (
        m.role === "tool" &&
        ephemeralIds.has(m.tool_call_id) &&
        !prevStepIds.has(m.tool_call_id)
      ) {
        m.content = "ok";
      }
    }

    let stepText = "";
    const stepCtl = new AbortController();
    const onOuterAbort = () => stepCtl.abort();
    opts.signal?.addEventListener("abort", onOuterAbort);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const armWatchdog = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        stepCtl.abort();
      }, stepTimeoutMs);
    };
    armWatchdog();
    const res = await stream({
      apiKey: opts.apiKey,
      config: opts.config,
      messages,
      tools,
      signal: stepCtl.signal,
      onDelta: async (d) => {
        armWatchdog();
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
    clearTimeout(watchdog);
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (timedOut) {
      throw new Error(
        `model step timed out after ${Math.round(stepTimeoutMs / 1000)}s with no output — provider ${opts.config.apiUrl} may be down or stalling`,
      );
    }
    if (aborted) break;

    if (res.toolCalls.length === 0) {
      if (!suggestedReplies && !nudged) {
        nudged = true;
        if (stepText) {
          messages.push({ role: "assistant", content: stepText });
        }
        messages.push({
          role: "user",
          content:
            "You ended this turn without calling suggest. Do not re-explain or re-state your answer in prose. Reply with ONLY a single suggest tool call offering 2–4 concrete next-step buttons ({short, prompt}).",
        });
        continue;
      }
      finalAnswer = true;
      break;
    }

    messages.push({
      role: "assistant",
      content: stepText || null,
      tool_calls: res.toolCalls,
    });

    const currentStepIds = new Set<string>();
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

      if (tc.function.name === "suggest") suggestedReplies = true;

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

      if (result.source) {
        await opts.onEvent({
          type: "edit",
          sourceId: result.source.id,
          title: result.source.title,
          bodyMd: result.source.bodyMd,
        });
      }

      if (result.retention === "ephemeral") ephemeralIds.add(tc.id);
      currentStepIds.add(tc.id);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        name: tc.function.name,
        content:
          result.ok && result.rawContent !== undefined
            ? result.rawContent
            : JSON.stringify(
                result.ok
                  ? result.data ?? { ok: true }
                  : { ok: false, error: result.error }
              ),
      });
    }
    prevStepIds = currentStepIds;
  }
  if (!aborted && !finalAnswer) capped = true;
  return { content, toolCalls: toolCallCount, aborted, usage, capped };
}
