// PDF → text via `unpdf` (a serverless build of pdf.js).
//
// `extractText(buf, { mergePages: false })` returns `{ totalPages, text }`
// where `text` is an array of per-page strings. Each page becomes one
// `ExtractedPage` (1-based physicalPage). A scanned-PDF heuristic flags
// `needsOcr` when the average recoverable text is below a threshold — typical
// of image-only scans where pdf.js finds little/no real text.

import { extractText } from "unpdf";
import type { ExtractResult } from "./index";

const MIME_TYPE = "application/pdf";

/** Below this many chars/page on average, the PDF is treated as scanned. */
const SCANNED_AVG_CHARS_PER_PAGE = 100;

export async function extractPdf(absPath: string): Promise<ExtractResult> {
  try {
    const buf = await Bun.file(absPath).arrayBuffer();
    const { totalPages, text } = await extractText(buf, {
      mergePages: false,
    });

    const pagesText: readonly string[] = Array.isArray(text)
      ? text
      : text == null
        ? []
        : [String(text)];

    const pages = pagesText.map((t, i) => ({
      physicalPage: i + 1,
      text: t ?? "",
    }));

    const pageCount = totalPages && totalPages > 0 ? totalPages : pages.length;
    const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
    const avgCharsPerPage = totalChars / Math.max(pageCount, 1);
    const needsOcr = avgCharsPerPage < SCANNED_AVG_CHARS_PER_PAGE;

    return {
      text: pages.map((p) => p.text).join("\n\n"),
      pages,
      pageCount,
      needsOcr,
      mimeType: MIME_TYPE,
    };
  } catch (e) {
    throw new Error(
      `pdf extract failed: ${(e as Error)?.message ?? String(e)}`
    );
  }
}
