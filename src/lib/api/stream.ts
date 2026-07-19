import type { GuiEvent } from "@dissertator/shared";
import { base } from "./_client";
import type {
  DebugEvent,
  EditEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "./events";

/** Stream a chat completion from `POST /chat` (P5 agent loop).
 *
 *  `chatId` is REQUIRED (the turn is scoped to that chat). The chat API key
 *  travels as a Bearer header; the EMBEDDING key (for the agent's corpus_*
 *  vector tools) travels as `X-Embedding-Key`. The stream is an agent loop,
 *  not a single round-trip: alongside `delta` (text) you may receive
 *  `tool_call` / `tool_result` (narration), `edit` (the agent wrote a
 *  document — pass to the editor for a live reload), and `gui` (open a
 *  viewer, offer option chips, show a non-blocking beat). The stream ends
 *  with `done` (ids + usage + toolCalls + capped) or `error`.
 *
 *  `onDelta` is called per text fragment; the granular callbacks fire for
 *  the other event types. `signal` aborts the run. Returns the parsed
 *  `done`/`error` payload — never throws: aborts and network failures are
 *  normalized into `{ aborted: true }` / `{ error: msg }` so callers can
 *  always clean up UI state in a single code path. */
export async function streamChat(
  chatId: string,
  message: string,
  apiKey: string,
  opts: {
    openFiles?: string[];
    /** Document the user is currently editing (transient UI state, not a
     *  binding — chats stay document-unbound). P5: the agent uses this as the
     *  default target for `p_read`/`p_write`/`p_insert` when the tool's `id`
     *  is omitted, and mentions it in the system prompt so the model knows
     *  which manuscript it is co-authoring. */
    activeDocumentId?: string;
    /** OPENER: auto-greet a new/empty chat (no user message persisted). */
    opener?: boolean;
    /** RETRY: re-run the last user turn (no new user row; failed assistant
     *  row is deleted server-side). */
    retry?: boolean;
    /** Embedding key for the agent's corpus_* vector tools (`X-Embedding-Key`). */
    embeddingApiKey?: string;
    onDelta?: (text: string) => void;
    onToolCall?: (e: ToolCallEvent) => void;
    onToolResult?: (e: ToolResultEvent) => void;
    onEdit?: (e: EditEvent) => void;
    onGui?: (e: GuiEvent) => void;
    /** Dev: the exact payload sent to the LLM each agent step (config +
     *  messages + tool list). Surfaced so a dev panel can show "what we sent". */
    onDebug?: (e: DebugEvent) => void;
    signal?: AbortSignal;
  },
): Promise<{
  userMessageId?: string;
  assistantMessageId?: string;
  aborted?: boolean;
  error?: string;
  toolCalls?: number;
  capped?: boolean;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (opts.embeddingApiKey) headers["X-Embedding-Key"] = opts.embeddingApiKey;

  // Never throw out of this function: normalize aborts and network errors
  // into the result shape so callers don't need their own try/catch around
  // UI cleanup (a thrown promise here would leave `streaming` true and the
  // composer locked — the original Stop-button freeze bug).
  const isAbort = (e: unknown): boolean =>
    e instanceof Error && e.name === "AbortError";

  let res: Response;
  try {
    res = await fetch(`${base()}/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        chatId,
        message,
        openFiles: opts.openFiles ?? [],
        ...(opts.activeDocumentId ? { activeDocumentId: opts.activeDocumentId } : {}),
        ...(opts.opener ? { opener: true } : {}),
        ...(opts.retry ? { retry: true } : {}),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    if (isAbort(e)) return { aborted: true };
    return { error: e instanceof Error ? e.message : String(e) };
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status} ${text}`.trim() };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Record<string, unknown> = {};

  // SSE events may carry multiple `data:` lines (per spec, a payload
  // containing `\n` is split into one `data:` line per line, to be rejoined
  // with `\n` by the consumer). Hono's writeSSE does exactly this for any
  // delta whose text contains a newline. Accumulate data lines per event
  // and dispatch only on the blank-line boundary — otherwise a single delta
  // like "a\nb" is emitted as two deltas "a" and "b" and the newline is
  // silently dropped (corrupting code/markdown-heavy replies).
  let currentEvent = "message";
  let dataLines: string[] = [];

  const dispatch = (event: string, data: string) => {
    if (event === "delta") {
      // If the fragment happens to be a JSON-quoted string, unwrap it.
      let text = data;
      try {
        const parsed = JSON.parse(data);
        if (typeof parsed === "string") text = parsed;
      } catch {
        /* not JSON — use raw payload */
      }
      opts.onDelta?.(text);
    } else if (event === "tool_call") {
      try {
        opts.onToolCall?.(JSON.parse(data) as ToolCallEvent);
      } catch {
        /* ignore malformed */
      }
    } else if (event === "tool_result") {
      try {
        opts.onToolResult?.(JSON.parse(data) as ToolResultEvent);
      } catch {
        /* ignore malformed */
      }
    } else if (event === "edit") {
      try {
        opts.onEdit?.(JSON.parse(data) as EditEvent);
      } catch {
        /* ignore malformed */
      }
    } else if (event === "gui") {
      try {
        opts.onGui?.(JSON.parse(data) as GuiEvent);
      } catch {
        /* ignore malformed */
      }
    } else if (event === "debug") {
      try {
        opts.onDebug?.(JSON.parse(data) as DebugEvent);
      } catch {
        /* ignore malformed */
      }
    } else if (event === "done" || event === "error") {
      try {
        result = JSON.parse(data);
      } catch {
        /* ignore */
      }
    }
  };

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch (e) {
      if (isAbort(e)) return { aborted: true };
      return { error: e instanceof Error ? e.message : String(e) };
    }
    const { done, value } = chunk;
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line === "") {
        if (dataLines.length) {
          dispatch(currentEvent, dataLines.join("\n"));
          dataLines = [];
        }
        currentEvent = "message";
      } else if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Hono emits `data: <value>` with a space after the colon and does
        // NOT JSON-encode string data. Strip both `data:` and the optional
        // separating space (slice(5) alone left the leading space, injecting
        // one space per delta — invisible for chunky text but it broke
        // token-by-token reasoning with tiny BPE tokens).
        dataLines.push(line.replace(/^data:\s?/, ""));
      }
      // `id:` and `retry:` lines are ignored.
    }
  }
  // Flush a trailing event without a final blank line (defensive — Hono
  // always terminates with `\n\n`, but be resilient to partial writes).
  if (dataLines.length) dispatch(currentEvent, dataLines.join("\n"));

  // The server's `error` event ships the message under `message` (not `error`).
  // Normalize so callers can always read `.error`. The catch block in chats.ts
  // emits `{ message }`; older paths used `{ error }` — accept both.
  const out = result as {
    userMessageId?: string;
    assistantMessageId?: string;
    aborted?: boolean;
    error?: string;
    message?: string;
  };
  if (!out.error && out.message) out.error = out.message;
  return out;
}
