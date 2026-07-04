// Embedding provider dispatcher (P2 Track 1).
//
// Public entry point: `embedBatch(texts, engine, opts)`. Routes to the
// OpenAI-compatible adapter (`"openai"`, covers openai/zai/custom/Together/
// Mistral/Nomic/Ollama) or the Google adapter (`"google"`). Any error raised
// by the underlying adapter is wrapped and rethrown as
// `Error("embed failed: <orig>")`.
//
// DECOUPLED FROM CHAT PROVIDER (hard design rule): the embedding backend and
// its API key are independent of the chat `provider`. A DeepSeek or Claude
// chat user may embed via OpenAI. The key flows in ONLY via `opts.apiKey`,
// sourced by the HTTP layer at call time — it is never stored, never cached
// in a module variable, and never logged here (see openai.ts / google.ts for
// the per-adapter isolation discipline, which mirrors ocr/vision.ts).

import { runOpenAIEmbed } from "./openai.ts";
import { runGoogleEmbed } from "./google.ts";

/** Backend wire format. Resolved from `EMBEDDING_DEFAULTS[provider].adapter`. */
export type EmbedEngine = "openai" | "google";

export interface EmbedOptions {
  /**
   * Embedding API key. Required by both adapters; sent only as a request
   * header. Never stored or logged. Sourced from the OS keychain by the HTTP
   * layer (its own slot, separate from the chat key).
   */
  apiKey?: string;
  /** Base API URL (no trailing slash). Defaults per adapter. */
  apiUrl?: string;
  /** Embedding model id. Defaults per adapter. */
  model?: string;
}

export interface EmbedResult {
  /** One vector per input text, same order as the input. */
  vectors: number[][];
  /** Dimensionality of every vector (all equal for a given model). */
  dimensions: number;
}

/**
 * Embed a batch of texts using `engine`. The OpenAI adapter sends all inputs
 * in one POST; the Google adapter uses `batchEmbedContents` (also one POST).
 * Errors are normalized to `Error("embed failed: …")` and never crash the
 * process — callers (embedPending) catch and mark chunks `failed`.
 */
export async function embedBatch(
  texts: string[],
  engine: EmbedEngine,
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  try {
    if (engine === "openai") {
      return await runOpenAIEmbed(texts, opts);
    }
    if (engine === "google") {
      return await runGoogleEmbed(texts, opts);
    }
    throw new Error(`unknown embed engine: ${engine}`);
  } catch (e) {
    throw new Error(`embed failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
