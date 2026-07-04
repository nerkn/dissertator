// Tests for the page-aware chunker (`chunkExtracted`).
//
// Covers: the small-page single-chunk path (token count + page metadata),
// the large-page overlapping-window path (asserting ~200-char overlap
// between consecutive pieces and exact window sizes), empty/whitespace
// skipping, multi-page ordering, and `printedPage` pass-through (present vs
// absent). Synthetic `ExtractResult` fixtures keep this hermetic — no fs/DB.

import { describe, expect, test } from "bun:test";
import type { ExtractedPage, ExtractResult } from "../extract/index.ts";
import { chunkExtracted } from "./chunk.ts";

/** Build whitespace-free dense text of exactly `len` chars (trim is a no-op). */
function denseText(len: number): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[i % alphabet.length];
  return out;
}

/** Wrap pages in a minimal valid `ExtractResult` (pages joined by "\n\n"). */
function resultOf(pages: ExtractedPage[]): ExtractResult {
  return {
    text: pages.map((p) => p.text).join("\n\n"),
    pages,
    pageCount: pages.length,
    needsOcr: false,
    mimeType: "text/plain",
  };
}

describe("chunkExtracted", () => {
  test("small page → one chunk with correct token count + page metadata", () => {
    const text = "Hello world."; // 12 chars → ceil(12/4) = 3 tokens
    const chunks = chunkExtracted(
      resultOf([{ physicalPage: 1, printedPage: "i", text }])
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].tokenCount).toBe(Math.ceil(text.length / 4));
    expect(chunks[0].physicalPage).toBe(1);
    expect(chunks[0].printedPage).toBe("i");
  });

  test("large page → overlapping windows, all sharing the page metadata", () => {
    // 4000 chars → estTokens 1000 (>400) → large-page path. With PIECE_CHARS
    // 1600 and OVERLAP_CHARS 200 this yields exactly three windows:
    //   [0..1600], [1400..3000], [2800..4000]
    const text = denseText(4000);
    const chunks = chunkExtracted(
      resultOf([{ physicalPage: 7, printedPage: "12", text }])
    );

    expect(chunks).toHaveLength(3);
    // Window sizes are exact (dense text → trim is identity).
    expect(chunks[0].text.length).toBe(1600);
    expect(chunks[1].text.length).toBe(1600);
    expect(chunks[2].text.length).toBe(1200);

    // Every chunk carries the originating page's metadata.
    for (const c of chunks) {
      expect(c.physicalPage).toBe(7);
      expect(c.printedPage).toBe("12");
    }

    // Consecutive chunks overlap by ~200 chars: the start of chunk[i+1]
    // appears within the last 200 chars of chunk[i] (the shared region).
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].text.slice(-200);
      const probe = chunks[i + 1].text.slice(0, 40);
      expect(tail).toContain(probe);
    }
  });

  test("empty / whitespace-only page → zero chunks", () => {
    expect(chunkExtracted(resultOf([{ physicalPage: 1, text: "" }]))).toEqual(
      []
    );
    expect(
      chunkExtracted(resultOf([{ physicalPage: 1, text: "   \n\t  " }]))
    ).toEqual([]);
  });

  test("multi-page → page 1 chunks precede page 2; physicalPage per page", () => {
    const chunks = chunkExtracted(
      resultOf([
        { physicalPage: 1, text: "alpha beta gamma" },
        { physicalPage: 2, text: "delta epsilon zeta" },
      ])
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0].physicalPage).toBe(1);
    expect(chunks[1].physicalPage).toBe(2);
    // Order preserved across the page boundary.
    expect(chunks[0].text).toBe("alpha beta gamma");
    expect(chunks[1].text).toBe("delta epsilon zeta");
  });

  test("printedPage flows through when present, null when absent", () => {
    const withLabel = chunkExtracted(
      resultOf([{ physicalPage: 1, printedPage: "iv", text: "x" }])
    );
    expect(withLabel[0].printedPage).toBe("iv");

    const withoutLabel = chunkExtracted(
      resultOf([{ physicalPage: 1, text: "x" }])
    );
    expect(withoutLabel[0].printedPage).toBeNull();
  });
});
