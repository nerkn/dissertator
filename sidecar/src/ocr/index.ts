// OCR dispatcher (Track C).
//
// Public entry point: `runOcr(absPath, engine, opts)`. Routes to the local
// tesseract.js engine (`"tesseract"`) or to the provider vision endpoint
// (`"vision"`). Any error raised by the underlying engine is wrapped and
// rethrown as `Error("ocr failed: <orig>")`.
//
// The API key (for vision) flows in only via `opts.apiKey`; it is sourced by
// the HTTP layer from the OS keychain at call time and is never stored or
// logged in this module (see vision.ts).

import type { Provider } from "@dissertator/shared";
import { runTesseract } from "./tesseract";
import { runVision } from "./vision";

export type OcrEngine = "tesseract" | "vision";

export interface OcrOptions {
  /** Required for vision; ignored by tesseract. Never stored or logged. */
  apiKey?: string;
  provider?: Provider;
  apiUrl?: string;
  /** Vision-capable chat model id. */
  model?: string;
}

export interface OcrResult {
  text: string;
  /** Best-effort; tesseract returns 1 for a single image. */
  pageCount: number;
}

/**
 * Run OCR on the image at `absPath` using `engine`. Tesseract runs locally
 * (no key); vision calls an OpenAI-compatible endpoint and requires
 * `opts.apiKey`. Errors are normalized to `Error("ocr failed: …")`.
 */
export async function runOcr(
  absPath: string,
  engine: OcrEngine,
  opts?: OcrOptions
): Promise<OcrResult> {
  try {
    if (engine === "tesseract") {
      return await runTesseract(absPath);
    }
    if (engine === "vision") {
      return await runVision(absPath, opts ?? {});
    }
    throw new Error(`unknown ocr engine: ${engine}`);
  } catch (e) {
    throw new Error(`ocr failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
