// Chat provider dispatcher (P3, extended in P5 for the tool-using agent loop).
//
// Public entry point: `streamChat(opts)`. A single OpenAI-compatible adapter
// covers every bound chat provider (openai/zai/openrouter/deepseek/custom…)
// — the engine is OpenAI-style only, so there is no provider branching here.
//
// DECOUPLED FROM EMBEDDINGS (hard design rule, mirrors embed/): the chat
// endpoint target (apiUrl + model) comes from the resolved `chat` binding,
// and the API key flows in ONLY via `opts.apiKey` → the Authorization Bearer
// header. It is never stored, never logged, never cached in a module variable.
//
// Anthropic (claude) note: use it via OpenRouter (`anthropic/claude-3.5-…`),
// which is OpenAI-compatible; there is no native Anthropic wire path.

export {
  streamOpenAIChat,
} from "./openai.ts";
export type {
  ChatTurn,
  LoopMessage,
  StreamChatOptions,
  StreamResult,
  ToolCall,
  ToolSpec,
} from "./openai.ts";

import { streamOpenAIChat } from "./openai.ts";
import type { StreamChatOptions, StreamResult } from "./openai.ts";

/**
 * Stream a chat completion via the configured provider. Routes everything to
 * the OpenAI-compatible adapter (see openai.ts for the streaming protocol and
 * key-isolation discipline). Returns the assembled tool calls + finish reason
 * (empty toolCalls for plain text answers).
 */
export function streamChat(opts: StreamChatOptions): Promise<StreamResult> {
  return streamOpenAIChat(opts);
}
