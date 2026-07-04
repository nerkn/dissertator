// Chat provider dispatcher (P3, extended in P5 for the tool-using agent loop).
//
// Public entry point: `streamChat(opts)`. Currently a single OpenAI-compatible
// adapter (covers openai/zai/openrouter/custom). Anthropic (claude) is NOT
// supported here and throws a clean error from the adapter (see openai.ts);
// a native Anthropic adapter can be added later by routing on
// `config.provider` here without changing call sites.
//
// DECOUPLED FROM EMBEDDINGS (hard design rule, mirrors embed/): the chat
// provider/model/url come from `Settings` (optionally overridden by the P3
// `chatProvider`/`chatApiUrl`/`chatModel` block), and the API key flows in
// ONLY via `opts.apiKey` → the Authorization Bearer header. It is never
// stored, never logged, never cached in a module variable.

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
 * Stream a chat completion via the configured provider. Currently routes
 * everything to the OpenAI-compatible adapter; throws
 * `Error("chat adapter: <provider> provider is not OpenAI-compatible")` for
 * Anthropic (clean error, not a crash). See openai.ts for the streaming
 * protocol and key-isolation discipline. Returns the assembled tool calls +
 * finish reason (empty toolCalls for plain text answers).
 */
export function streamChat(opts: StreamChatOptions): Promise<StreamResult> {
  return streamOpenAIChat(opts);
}
