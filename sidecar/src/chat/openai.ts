// OpenAI-compatible streaming chat adapter (P3).
//
// Streams a chat completion from `POST {apiUrl}/chat/completions` with
// `stream:true`, yielding incremental text deltas to `onDelta`. The API key
// (`opts.apiKey`) is sent ONLY in the `Authorization` header — it is never
// persisted, embedded in the request body, or logged, and is never cached in
// a module variable (read at call time). Provider error bodies are truncated
// to ≤500 chars before being thrown so a key-bearing payload can't leak
// through an error string.
//
// Provider notes: openai, z.ai (`https://api.z.ai/api/paas/v4`), openrouter,
// deepseek, and any OpenAI-compatible `/chat/completions` endpoint work on
// this single path. The engine is OpenAI-style only — no provider-specific
// branching, so no `provider` flavor field is needed on the config.
//
// STREAM PROTOCOL: the response is `text/event-stream` of `data: {json}\n\n`
// lines, terminated by `data: [DONE]`. Each chunk's `choices[0].delta.content`
// carries the incremental text. We parse line-by-line so we never buffer the
// whole transcript in memory; deltas are forwarded as soon as they arrive.
//
// ABORT: pass an `AbortSignal` via `opts.signal` to cancel a stream mid-flight
// (e.g. user clicks Stop). The in-flight fetch is aborted and the error is
// swallowed (`onAbort` callback fires instead of `onError`).

import type { ChatEndpointConfig } from "@dissertator/shared";

/** Cap on echoed provider error bodies — never let a key leak via an error. */
const ERR_BODY_CAP = 500;

/** An OpenAI function-tool spec (`tools[]` entry in the request body). */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>; // JSON Schema
  };
}

/** A fully-assembled tool call (post-stream-accumulation). */
export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * A chat message in the richer shape the agent loop needs. Strictly wider
 * than the P3 `ChatTurn` (system/user text turns): assistant turns may carry
 * `tool_calls`, and `tool`-role result messages carry `tool_call_id` + `name`.
 * The body is JSON-stringified verbatim, so providers receive the OpenAI-native
 * shape without further mapping.
 */
export type LoopMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string; name: string };

/** P3-era flat text turn (subset of {@link LoopMessage}). Kept as an alias. */
export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamResult {
  /** Tool calls the model issued this turn (empty when it answered in text). */
  toolCalls: ToolCall[];
  /** Provider finish reason (`stop` | `tool_calls` | `length` | …). */
  finishReason: string | null;
}

export interface StreamChatOptions {
  /** Chat API key. Sent ONLY as a Bearer header; never stored or logged. */
  apiKey: string;
  /** Resolved chat endpoint target (apiUrl + model). */
  config: ChatEndpointConfig;
  /** Conversation turns (system + history + new user message). */
  messages: LoopMessage[];
  /** Max output tokens. Provider default if omitted. */
  maxTokens?: number;
  /** Function tools to expose (P5 agent loop). Omitted = plain chat. */
  tools?: ToolSpec[];
  /** Tool choice: `auto` (default) lets the model decide; `none` forbids. */
  toolChoice?: "auto" | "none";
  /** Aborts the in-flight fetch when signaled. */
  signal?: AbortSignal;
  /** Called for each incremental text delta. */
  onDelta: (text: string) => void;
  /** Called if the stream is aborted via `signal` (no error thrown). */
  onAbort?: () => void;
  /** Called with the final total token usage, if the provider reports it. */
  onUsage?: (prompt: number, completion: number) => void;
}

function truncate(body: string): string {
  return body.length > ERR_BODY_CAP ? body.slice(0, ERR_BODY_CAP) : body;
}

/**
 * Stream an OpenAI-compatible chat completion. Throws
 * `Error("chat adapter requires an api key")` (caller guards this), or
 * `Error("chat adapter failed: <status> <body-truncated>")` on a non-2xx
 * response. Network/abort errors are rethrown verbatim unless the signal
 * aborted, in which case `onAbort` fires and the function returns an empty
 * result.
 *
 * Returns the assembled tool calls + finish reason so the agent loop can
 * decide whether to execute tools and re-stream, or treat the turn as final.
 */
export async function streamOpenAIChat(
  opts: StreamChatOptions
): Promise<StreamResult> {
  const {
    apiKey,
    config,
    messages,
    signal,
    onDelta,
    onAbort,
    onUsage,
    tools,
    toolChoice,
  } = opts;
  // Sentinel returned when the stream was aborted (no tool calls, no finish).
  const ABORTED: StreamResult = { toolCalls: [], finishReason: null };
  if (!apiKey) throw new Error("chat adapter requires an api key");

  const apiUrl = config.apiUrl.replace(/\/+$/, "");
  const url = `${apiUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    stream: true,
    messages,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? "auto";
  }
  if (opts.maxTokens && opts.maxTokens > 0) {
    body.stream_options = { include_usage: true };
    body.max_tokens = opts.maxTokens;
  } else if (opts.onUsage) {
    // Usage only arrives when we ask for it via stream_options.
    body.stream_options = { include_usage: true };
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // Key transmitted ONLY here; never logged or persisted.
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (signal?.aborted) {
      onAbort?.();
      return ABORTED;
    }
    throw e;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`chat adapter failed: ${res.status} ${truncate(errBody)}`);
  }
  if (!res.body) {
    throw new Error("chat adapter failed: no response body");
  }

  // Parse the SSE stream line-by-line. A complete `data:` line is JSON; an
  // empty line is the event delimiter; `data: [DONE]` ends the stream.
  //
  // Tool-call deltas arrive fragmented across chunks, keyed by `index`. We
  // accumulate them into `toolCallsByIndex` so a multi-call response
  // reassembles correctly regardless of fragmentation. Text deltas
  // (`delta.content`) are forwarded immediately.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const toolCallsByIndex = new Map<number, ToolCall>();
  let finishReason: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          return finalize(toolCallsByIndex, finishReason);
        }
        try {
          const chunk = JSON.parse(payload) as {
            choices?: Array<{
              delta?: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) onDelta(delta.content);
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallsByIndex.get(tc.index);
              const name =
                tc.function?.name ?? existing?.function.name ?? "";
              const args =
                (existing?.function.arguments ?? "") +
                (tc.function?.arguments ?? "");
              toolCallsByIndex.set(tc.index, {
                id: tc.id ?? existing?.id ?? "",
                type: "function",
                function: { name, arguments: args },
              });
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const u = chunk.usage;
          if (u && onUsage) {
            onUsage(u.prompt_tokens ?? 0, u.completion_tokens ?? 0);
          }
        } catch {
          // Partial JSON mid-chunk or a keep-alive comment — skip.
        }
      }
    }
  } catch (e) {
    if (signal?.aborted) {
      onAbort?.();
      return ABORTED;
    }
    throw e;
  }
  return finalize(toolCallsByIndex, finishReason);
}

/** Emit accumulated tool calls in index order (stable across fragmentation). */
function finalize(
  byIndex: Map<number, ToolCall>,
  finishReason: string | null
): StreamResult {
  const toolCalls = [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => v);
  return { toolCalls, finishReason };
}
