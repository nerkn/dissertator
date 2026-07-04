// Local OCR via `tesseract.js` (WASM). No system binary, no API key.
//
// Reads the image bytes with `Bun.file(absPath).arrayBuffer()`, hands a
// `Buffer` to a short-lived worker trained on English (`"eng"`), and returns
// the recognized text. The worker script, WASM core, and language traineddata
// are all resolved from the npm package / its CDN fallback at runtime — this
// module never shells out to a system `tesseract` binary.
//
// Multi-page TIFFs are OCR'd at page 1 only for v1, so `pageCount` is always
// `1` here. On any failure the error is rethrown with a descriptive prefix.

import * as Tesseract from "tesseract.js";

/**
 * Run tesseract.js OCR on the image at `absPath` and return its text.
 * Returns `{ text, pageCount: 1 }`. Throws `Error("tesseract ocr failed: …")`
 * on any failure (file read, worker init, recognition).
 */
export async function runTesseract(absPath: string): Promise<{
  text: string;
  pageCount: number;
}> {
  let worker: Tesseract.Worker | null = null;
  try {
    const buf = await Bun.file(absPath).arrayBuffer();
    // `1` == OEM.LSTM_ONLY (the modern default); logger silenced to keep
    // stdout clean for callers.
    worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
    const { data } = await worker.recognize(Buffer.from(buf));
    return { text: data?.text ?? "", pageCount: 1 };
  } catch (e) {
    throw new Error(
      `tesseract ocr failed: ${(e as Error)?.message ?? String(e)}`
    );
  } finally {
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        /* swallow termination errors */
      }
    }
  }
}
