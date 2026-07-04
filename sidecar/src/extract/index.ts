// Born-digital text extraction dispatcher (Track B).
//
// Routes an absolute file path to a kind-specific extractor based on its
// `FileKind`. The public types (`ExtractResult`, `ExtractedPage`, `FileKind`)
// and the `detectKind` / `extract` functions are the stable contract consumed
// by the chunking and OCR stages (Track C). Each per-kind module owns its own
// error handling and rethrows with a descriptive prefix.

import type { TextStatus } from "@dissertator/shared";
import { extractDocx } from "./docx";
import { extractImage } from "./image";
import { extractPdf } from "./pdf";
import { extractTextFile } from "./text";
import { extractXlsx } from "./xlsx";

export type FileKind =
  | "pdf"
  | "docx"
  | "xlsx"
  | "text"
  | "image"
  | "unsupported";

export interface ExtractedPage {
  /** 1-based physical page index within the file. */
  physicalPage: number;
  /** Human-readable printed page label if known (e.g. "12", "iv"). */
  printedPage?: string;
  text: string;
}

export interface ExtractResult {
  /** Full text — pages joined by "\n\n". */
  text: string;
  /** One entry per page; length >= 1. */
  pages: ExtractedPage[];
  pageCount: number;
  /** True for images; true for the scanned-PDF heuristic. */
  needsOcr: boolean;
  mimeType: string;
}

/**
 * Extension → kind table (extensions lowercased, no leading dot). Anything not
 * listed maps to `"unsupported"`.
 */
const EXT_TO_KIND: Record<string, FileKind> = {
  // PDF
  pdf: "pdf",
  // Word
  docx: "docx",
  // Spreadsheets
  xlsx: "xlsx",
  xls: "xlsx",
  // Born-digital text
  csv: "text",
  tsv: "text",
  md: "text",
  markdown: "text",
  txt: "text",
  json: "text",
  // Raster images (OCR'd in Track C)
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  tif: "image",
  tiff: "image",
  bmp: "image",
  gif: "image",
};

/**
 * Detect a file's `FileKind` purely from its filename extension. Unknown or
 * missing extensions return `"unsupported"`. The check is case-insensitive.
 */
export function detectKind(filename: string): FileKind {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return "unsupported";
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXT_TO_KIND[ext] ?? "unsupported";
}

/**
 * Extract born-digital text from a file. When `kind` is omitted it is inferred
 * from the path's extension via `detectKind`. `"unsupported"` kinds throw
 * synchronously (as a rejected promise); image kinds never OCR here.
 *
 * Note: `TextStatus` (from `@dissertator/shared`) is the lifecycle marker the
 * caller advances based on the returned `needsOcr` flag — e.g. `done` vs.
 * `needs_ocr` / `pending_vision`.
 */
export async function extract(
  absPath: string,
  kind?: FileKind
): Promise<ExtractResult> {
  const resolved: FileKind = kind ?? detectKind(absPath);
  switch (resolved) {
    case "pdf":
      return extractPdf(absPath);
    case "docx":
      return extractDocx(absPath);
    case "xlsx":
      return extractXlsx(absPath);
    case "text":
      return extractTextFile(absPath);
    case "image":
      return extractImage(absPath);
    default:
      throw new Error("unsupported file kind");
  }
}
