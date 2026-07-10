// Speech-to-text dispatcher (audio ingestion).
//
// Public entry point: `runTranscribe(absPath, opts)`. Routes the audio file at
// `absPath` to the Whisper-compatible engine (`sidecar/src/transcribe/whisper.ts`)
// which POSTs multipart/form-data to `{apiUrl}/audio/transcriptions`. The
// returned transcript replaces the source's "text" for chunking + embedding,
// mirroring how OCR populates text for images.
//
// Key discipline (identical to OCR-vision): the provider API key flows in ONLY
// via `opts.apiKey`, sourced by the HTTP layer from the OS keychain at call
// time. It is never stored or logged in this module.

import { runWhisper } from "./whisper";

export interface TranscribeOptions {
  /** Required. Never stored or logged. */
  apiKey?: string;
  /** OpenAI-compatible base URL (e.g. https://api.openai.com/v1). */
  apiUrl?: string;
  /** Whisper-compatible model id (default whisper-1). */
  model?: string;
}

export interface TranscribeResult {
  text: string;
}

/**
 * Transcribe the audio at `absPath`. Calls an OpenAI-compatible
 * `/audio/transcriptions` endpoint and requires `opts.apiKey`. Errors are
 * normalized to `Error("transcribe failed: …")`.
 */
export async function runTranscribe(
  absPath: string,
  opts: TranscribeOptions = {}
): Promise<TranscribeResult> {
  try {
    return await runWhisper(absPath, opts);
  } catch (e) {
    throw new Error(`transcribe failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
