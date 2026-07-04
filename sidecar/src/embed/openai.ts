// OpenAI-compatible embedding adapter.
//
// Sends `{ model, input: texts }` to `POST {apiUrl}/embeddings` and parses
// `data: { embedding: number[] }[]`. The API key (`opts.apiKey`) is sent ONLY
// in the `Authorization` header — it is never persisted, embedded in the
// request body, or `console.log`ged, and is never cached in a module
// variable (read at call time). Provider error bodies are truncated to
// ≤500 chars before being thrown so a key-bearing payload can't leak through
// an error string. On any non-2xx the error is thrown as
// `Error("openai embed failed: <status> <body-truncated-500>")`.
//
// Provider notes: openai, z.ai (`https://api.z.ai/api/paas/v4`), Together,
// Mistral, Nomic, Ollama, and any OpenAI-compatible `/embeddings` endpoint
// work on this single path. This adapter is DECOUPLED from the chat provider
// — a Claude/DeepSeek chat user may embed via OpenAI.

import type { EmbedOptions, EmbedResult } from "./index.ts";

/** Default embedding model when `opts.model` is absent. */
const DEFAULT_MODEL = "text-embedding-3-small";

/** Default OpenAI-compatible base. */
const DEFAULT_API_URL = "https://api.openai.com/v1";

/** Cap on echoed provider error bodies — never let a key leak via an error. */
const ERR_BODY_CAP = 500;

/** Truncate a provider error body so it never echoes a key-bearing payload. */
function truncate(body: string): string {
  return body.length > ERR_BODY_CAP ? body.slice(0, ERR_BODY_CAP) : body;
}

/**
 * Run an OpenAI-compatible embedding batch. Throws
 * `Error("openai embed requires an api key")` if `opts.apiKey` is missing, or
 * `Error("openai embed failed: <status> <body-truncated-500>")` on a non-2xx
 * response. Returns `{ vectors, dimensions }` with one vector per input,
 * preserving input order; the dimension is taken from the first vector.
 */
export async function runOpenAIEmbed(
  texts: string[],
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("openai embed requires an api key");

  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_MODEL;

  const url = `${apiUrl}/embeddings`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Key is transmitted ONLY here; never logged or persisted.
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`openai embed failed: ${res.status} ${truncate(body)}`);
  }

  const data = (await res.json()) as {
    data?: { embedding?: number[] }[];
  };
  const vectors = (data?.data ?? []).map((d) => d.embedding ?? []);
  if (vectors.length === 0) {
    throw new Error("openai embed failed: empty response");
  }
  const dimensions = vectors[0].length;
  if (dimensions === 0) {
    throw new Error("openai embed failed: zero-dimension vector");
  }
  return { vectors, dimensions };
}
