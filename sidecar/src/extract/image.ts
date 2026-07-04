// Raster image → empty text + `needsOcr: true`.
//
// This stage does NOT OCR — it merely flags the file for Track C (tesseract /
// vision). We return a single empty page and a MIME derived from the
// extension. The file is not read or validated here; the OCR stage will.

import { extname } from "node:path";
import type { ExtractResult } from "./index";

/** MIME by image extension; unknown extensions fall back to a byte-stream. */
export function imageMime(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    case ".bmp":
      return "image/bmp";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

export async function extractImage(absPath: string): Promise<ExtractResult> {
  // No fallible I/O is performed here — the stub is derived from the path.
  return {
    text: "",
    pages: [{ physicalPage: 1, text: "" }],
    pageCount: 1,
    needsOcr: true,
    mimeType: imageMime(absPath),
  };
}
