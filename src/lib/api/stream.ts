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
 *  `done`/`error` payload. */
export async function streamChat(
  chatId: string,
  message: string,
  apiKey: string,
  opts: {
    openFiles?: string[];
    /** Document the user is editing (default target for p_read/p_write/p_insert). */
    activeDocumentId?: string;
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
  const res = await fetch(`${base()}/chat`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      chatId,
      message,
      openFiles: opts.openFiles ?? [],
      ...(opts.activeDocumentId ? { activeDocumentId: opts.activeDocumentId } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    return { error: `${res.status} ${text}`.trim() };
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: Record<string, unknown> = {};
  let currentEvent = "message";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        // Hono's `writeSSE` emits `data: <value>` — a space AFTER the colon
        // — and does NOT JSON-encode string data (objects only). So we must
        // strip both `data:` and the single separating space. Using slice(5)
        // alone left the leading space, injecting one space per delta —
        // invisible for chunky final-answer text, but with token-by-token
        // reasoning (esp. Turkish's tiny BPE tokens) it put spaces INSIDE
        // every word (e.g. "dos yas ını").
        const payload = line.replace(/^data:\s?/, "");
        if (currentEvent === "delta") {
          // If the fragment happens to be a JSON-quoted string, unwrap it.
          let text = payload;
          try {
            const parsed = JSON.parse(payload);
            if (typeof parsed === "string") text = parsed;
          } catch {
            /* not JSON — use raw payload */
          }
          opts.onDelta?.(text);
        } else if (currentEvent === "tool_call") {
          try {
            const e = JSON.parse(payload) as ToolCallEvent;
            opts.onToolCall?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "tool_result") {
          try {
            const e = JSON.parse(payload) as ToolResultEvent;
            opts.onToolResult?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "edit") {
          try {
            const e = JSON.parse(payload) as EditEvent;
            opts.onEdit?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "gui") {
          try {
            const e = JSON.parse(payload) as GuiEvent;
            opts.onGui?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "debug") {
          try {
            const e = JSON.parse(payload) as DebugEvent;
            opts.onDebug?.(e);
          } catch {
            /* ignore malformed */
          }
        } else if (currentEvent === "done" || currentEvent === "error") {
          try {
            result = JSON.parse(payload);
          } catch {
            /* ignore */
          }
        }
      }
      currentEvent = line === "" ? "message" : currentEvent;
    }
  }
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
