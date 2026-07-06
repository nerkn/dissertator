// PDF → text via `unpdf` (a serverless build of pdf.js).
//
// `extractText(buf, { mergePages: false })` returns `{ totalPages, text }`
// where `text` is an array of per-page strings. Each page becomes one
// `ExtractedPage` (1-based physicalPage). A scanned-PDF heuristic flags
// `needsOcr` when the average recoverable text is below a threshold — typical
// of image-only scans where pdf.js finds little/no real text.

import { extractText } from "unpdf";
import type { ExtractResult } from "./index";
import {
  looksLikeBrokenTurkishPdf,
  repairTurkishPdfText,
} from "./turkish";

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

    // Old Turkish PDFs often embed a broken Type1 font whose glyph-name table
    // corrupts the 6 Turkish-only letters (ğ Ğ ı İ ş Ş) on extraction. Detect
    // it once for the whole document, then repair every page so chunks/embeddings
    // are stored clean. Clean/English/properly-encoded PDFs are untouched.
    const joinedRaw = pagesText.join("\n\n");
    const broken = looksLikeBrokenTurkishPdf(joinedRaw);

    const pages = pagesText.map((t, i) => ({
      physicalPage: i + 1,
      text: broken ? repairTurkishPdfText(t ?? "") : t ?? "",
    }));

    const pageCount = totalPages && totalPages > 0 ? totalPages : pages.length;
    const totalChars = pages.reduce((sum, p) => sum + p.text.length, 0);
    const avgCharsPerPage = totalChars / Math.max(pageCount, 1);
    const needsOcr = avgCharsPerPage < SCANNED_AVG_CHARS_PER_PAGE;

    return {
      text: broken ? repairTurkishPdfText(joinedRaw) : joinedRaw,
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
