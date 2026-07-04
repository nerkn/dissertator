// Page-aware text chunker.
//
// Splits an `ExtractResult` into ~400-token chunks, never crossing a page
// boundary. Each output chunk carries the originating page's
// `physicalPage` (1-based) and optional `printedPage` label. Pages whose
// token estimate exceeds the budget are sliced into overlapping windows
// (~1600 chars per piece, ~200 char overlap ≈ 50-token overlap). Empty /
// whitespace-only chunks are skipped.
//
// Token estimates are char-based (`Math.ceil(len / 4)`) — no tokenizer
// dependency. Good enough for budgeting and ordering.

import type { ExtractResult } from "../extract/index.ts";

export interface ChunkOutput {
  text: string;
  physicalPage: number | null;
  printedPage: string | null;
  tokenCount: number;
}

/** Target chunk budget (tokens ≈ chars/4). */
const MAX_TOKENS = 400;
/** Char window per piece when a page exceeds the budget (~400 tokens). */
const PIECE_CHARS = MAX_TOKENS * 4; // 1600
/** Char overlap between consecutive pieces on the same page (~50 tokens). */
const OVERLAP_CHARS = 200;

/**
 * Chunk an extraction result. One chunk per small page; large pages are split
 * into sequential overlapping windows that all retain the page's metadata.
 */
export function chunkExtracted(result: ExtractResult): ChunkOutput[] {
  const out: ChunkOutput[] = [];

  for (const page of result.pages) {
    const raw = page.text ?? "";
    const text = raw.trim();
    if (text.length === 0) continue;

    const physicalPage: number | null =
      typeof page.physicalPage === "number" ? page.physicalPage : null;
    const printedPage: string | null = page.printedPage ?? null;
    const estTokens = Math.ceil(text.length / 4);

    // Small page → single chunk.
    if (estTokens <= MAX_TOKENS) {
      out.push({ text, physicalPage, printedPage, tokenCount: estTokens });
      continue;
    }

    // Large page → sequential overlapping windows.
    let start = 0;
    while (start < text.length) {
      const end = Math.min(start + PIECE_CHARS, text.length);
      const piece = text.slice(start, end).trim();
      if (piece.length > 0) {
        out.push({
          text: piece,
          physicalPage,
          printedPage,
          tokenCount: Math.ceil(piece.length / 4),
        });
      }
      if (end >= text.length) break;
      // Advance by (piece - overlap); guaranteed > 0 since OVERLAP < PIECE.
      start = end - OVERLAP_CHARS;
      if (start < 0) start = 0;
    }
  }

  return out;
}
