// DOCX → raw text via `mammoth` (`extractRawText`). DOCX has no inherent
// pagination, so the whole document is returned as a single page
// (physicalPage=1, pageCount=1).

import mammoth from "mammoth";
import type { ExtractResult } from "./index";

const MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export async function extractDocx(absPath: string): Promise<ExtractResult> {
  try {
    const result = await mammoth.extractRawText({ path: absPath });
    const text = result.value ?? "";
    return {
      text,
      pages: [{ physicalPage: 1, text }],
      pageCount: 1,
      needsOcr: false,
      mimeType: MIME_TYPE,
    };
  } catch (e) {
    throw new Error(
      `docx extract failed: ${(e as Error)?.message ?? String(e)}`
    );
  }
}
