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

import { runTesseract } from "./tesseract";
import { runVision } from "./vision";

export type OcrEngine = "tesseract" | "vision";

export interface OcrOptions {
  /** Required for vision; ignored by tesseract. Never stored or logged. */
  apiKey?: string;
  apiUrl?: string;
  /** Vision-capable chat model id. */
  model?: string;
  /** Override the vision prompt (describe instead of OCR). */
  instruction?: string;
}

export interface OcrResult {
  text: string;
  /** Best-effort; tesseract returns 1 for a single image. */
  pageCount: number;
}

/** Vision DESCRIBE prompt (vision_image function): understand a standalone
 *  image and return a textual description for search (vs runOcr's extraction). */
const DESCRIBE_INSTRUCTION =
  "Describe this image in detail for later search: the subjects, scene, any visible text, charts/figures, and context. Write clear flowing prose.";

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

/**
 * Vision DESCRIBE (vision_image function): understand a standalone image and
 * return a textual description. Same wire path as vision OCR, different
 * prompt. Requires `opts.apiKey`. Errors normalize to `Error("describe
 * failed: …")`.
 */
export async function runDescribe(
  absPath: string,
  opts: OcrOptions = {}
): Promise<OcrResult> {
  try {
    return await runVision(absPath, { ...opts, instruction: DESCRIBE_INSTRUCTION });
  } catch (e) {
    throw new Error(`describe failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
