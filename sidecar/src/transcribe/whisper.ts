// Whisper-compatible speech-to-text via an OpenAI-compatible
// `/audio/transcriptions` POST.
//
// Sends `multipart/form-data` with the audio file plus `model=whisper-1` to
// `POST {apiUrl}/audio/transcriptions`. The API key (`opts.apiKey`) is sent
// ONLY in the `Authorization` header — it is never persisted, embedded in the
// form fields, or logged. On any non-2xx response the error is thrown as
// `Error("whisper stt failed: <status> <body>")`.
//
// Provider notes: works on OpenAI (`https://api.openai.com/v1`), Groq, and any
// OpenAI-compatible host that exposes `/audio/transcriptions`. Providers
// without an audio endpoint surface as a clear error — acceptable for v1.

import { TranscribeOptions, TranscribeResult } from "./index";

/** Default Whisper model when `opts.model` is absent. */
const DEFAULT_MODEL = "whisper-1";

/**
 * Run Whisper STT against an OpenAI-compatible endpoint. Throws
 * `Error("whisper stt requires an api key")` if `opts.apiKey` is missing, or
 * `Error("whisper stt failed: <status> <body>")` on a non-2xx response.
 */
export async function runWhisper(
  absPath: string,
  opts: TranscribeOptions = {}
): Promise<TranscribeResult> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("whisper stt requires an api key");

  const apiUrl = (opts.apiUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_MODEL;

  const form = new FormData();
  // `file` must be the original audio bytes; Bun.file streams from disk.
  form.append("file", Bun.file(absPath));
  form.append("model", model);
  form.append("response_format", "json");

  const url = `${apiUrl}/audio/transcriptions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      // Key is transmitted ONLY here; never logged or persisted.
      // NOTE: do NOT set Content-Type — fetch derives the multipart boundary.
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`whisper stt failed: ${res.status} ${body}`);
  }

  // `response_format: json` → `{ "text": "..." }`. Some hosts ignore the hint
  // and return plain text; handle both.
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const data = (await res.json()) as { text?: string };
    return { text: data.text ?? "" };
  }
  const text = await res.text();
  return { text: text.trim() };
}
