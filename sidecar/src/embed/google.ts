// Google embedding adapter (Generative Language API v1beta).
//
// Sends a batch to `POST {apiUrl}/models/{model}:batchEmbedContents` with the
// API key in the `x-goog-api-key` HEADER — never as a `?key=` query param,
// because query strings land in server access logs / proxy caches. Parses
// `embeddings: { values: number[] }[]`, one vector per input text.
//
// API-KEY ISOLATION (hard invariant — mirrors ocr/vision.ts): the key
// (`opts.apiKey`) is read at call time, sent ONLY in the header above, and is
// never persisted, never embedded in the request body, never cached in a
// module variable, and never `console.log`ged. Provider error bodies are
// truncated to ≤500 chars before being thrown so a key-bearing payload can't
// leak through an error string. On any non-2xx the error is thrown as
// `Error("google embed failed: <status> <body-truncated-500>")`.
//
// Why `batchEmbedContents` (not a per-text loop): Google's `embedContent` is
// single-input; `batchEmbedContents` accepts up to 100 requests in one POST,
// turning a 64-text batch into 1 round-trip instead of 64.

import type { EmbedOptions, EmbedResult } from "./index.ts";

/** Default embedding model when `opts.model` is absent. */
const DEFAULT_MODEL = "text-embedding-004";

/** Default Generative Language API base. */
const DEFAULT_API_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Cap on echoed provider error bodies — never let a key leak via an error. */
const ERR_BODY_CAP = 500;

/** Truncate a provider error body so it never echoes a key-bearing payload. */
function truncate(body: string): string {
  return body.length > ERR_BODY_CAP ? body.slice(0, ERR_BODY_CAP) : body;
}

/**
 * Run a Google embedding batch. Throws
 * `Error("google embed requires an api key")` if `opts.apiKey` is missing, or
 * `Error("google embed failed: <status> <body-truncated-500>")` on a non-2xx
 * response. Returns `{ vectors, dimensions }` with one vector per input,
 * preserving input order.
 */
export async function runGoogleEmbed(
  texts: string[],
  opts: EmbedOptions = {}
): Promise<EmbedResult> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("google embed requires an api key");

  const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_MODEL;

  const url = `${apiUrl}/models/${encodeURIComponent(model)}:batchEmbedContents`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Key is transmitted ONLY here; never in the URL, never logged.
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify({
      requests: texts.map((t) => ({
        // Google requires the fully-qualified model id per request.
        model: `models/${model}`,
        content: { parts: [{ text: t }] },
      })),
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`google embed failed: ${res.status} ${truncate(body)}`);
  }

  const data = (await res.json()) as {
    embeddings?: { values?: number[] }[];
  };
  const vectors = (data?.embeddings ?? []).map((e) => e.values ?? []);
  if (vectors.length === 0) {
    throw new Error("google embed failed: empty response");
  }
  const dimensions = vectors[0].length;
  if (dimensions === 0) {
    throw new Error("google embed failed: zero-dimension vector");
  }
  return { vectors, dimensions };
}
