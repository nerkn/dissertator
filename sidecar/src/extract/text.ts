// Born-digital plain text (.md/.csv/.txt/.tsv/.json/.markdown) → UTF-8 string.
//
// Read directly via `Bun.file(absPath).text()`. The whole file is a single
// page (physicalPage=1, pageCount=1). MIME is derived from the extension:
// `.md`→`text/markdown`, `.csv`→`text/csv`, else `text/plain`.

import { extname } from "node:path";
import type { ExtractResult } from "./index";

/** MIME by extension per the extraction contract. */
export function textMime(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".csv") return "text/csv";
  return "text/plain";
}

export async function extractTextFile(absPath: string): Promise<ExtractResult> {
  try {
    const text = await Bun.file(absPath).text();
    return {
      text,
      pages: [{ physicalPage: 1, text }],
      pageCount: 1,
      needsOcr: false,
      mimeType: textMime(absPath),
    };
  } catch (e) {
    throw new Error(
      `text extract failed: ${(e as Error)?.message ?? String(e)}`
    );
  }
}
