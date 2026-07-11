// Tests for semantic search (P2 Track 2) — pure logic, NO network, NO key.
//
// Three invariants pinned:
//   1. `distanceToScore` clamps sqlite-vec distance → [0,1] similarity
//      (identity at 0, monotone decreasing, clamps negatives & NaN to 0);
//   2. `searchCorpus` returns an EMPTY result with `embedded:false` (not an
//      error) when the corpus isn't embedded yet — no key is required and no
//      provider is called;
//   3. a query embedding whose dimensionality differs from the locked dim
//      throws `Error("search failed: query dimension mismatch: ...")`.
//
// Uses a throwaway project dir + the real `initProject` (loads sqlite-vec).
// The embed adapter is NOT called: test #2 short-circuits before any embed;
// test #3 injects a stub `embed` via `searchCorpusWith` (the DI test seam),
// so the mismatch path runs without a network call or API key.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { initProject, lockDimensions } from "./db";
import {
  distanceToScore,
  searchCorpus,
  searchCorpusWith,
  type EmbedFn,
} from "./search.ts";

let dir: string;
let dbPath: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-search-"));
  await initProject(dir);
  dbPath = join(dir, "Dissertator", "dissertator.db");
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// 1. distance → score conversion (pure helper).
// ---------------------------------------------------------------------------

test("distanceToScore: identical vectors (distance 0) → score 1", () => {
  expect(distanceToScore(0)).toBe(1);
});

test("distanceToScore: monotonically decreases with distance", () => {
  expect(distanceToScore(0.25)).toBe(0.75);
  expect(distanceToScore(0.5)).toBe(0.5);
  expect(distanceToScore(0.9)).toBeCloseTo(0.1, 7);
});

test("distanceToScore: distance >= 1 clamps to 0", () => {
  expect(distanceToScore(1)).toBe(0); // orthogonal vectors (cosine dist 1)
  expect(distanceToScore(1.4142135)).toBe(0); // beyond orthogonal
  expect(distanceToScore(2)).toBe(0); // opposite vectors (cosine dist 2)
});

test("distanceToScore: negative distance (impossible but defensive) clamps to 1", () => {
  expect(distanceToScore(-0.5)).toBe(1);
});

test("distanceToScore: non-finite collapses to 0", () => {
  expect(distanceToScore(Number.NaN)).toBe(0);
  expect(distanceToScore(Number.POSITIVE_INFINITY)).toBe(0);
});

// ---------------------------------------------------------------------------
// 2. Early-return when the corpus is not yet embedded (no key, no network).
//    A fresh project has dimensions=0 and done=0 → searchCorpus must return
//    an empty result with embedded:false WITHOUT calling the embed provider.
// ---------------------------------------------------------------------------

test("searchCorpus returns {embedded:false, hits:[]} on an unembedded corpus", async () => {
  // A stub embed that FAILS the test if ever called — proves the early-return
  // path never touches the provider (so no key / no network is needed).
  const bomb: EmbedFn = async () => {
    throw new Error("embed must not be called when the corpus is unembedded");
  };
  const res = await searchCorpusWith("anything", {}, bomb);
  expect(res.embedded).toBe(false);
  expect(res.hits).toEqual([]);
  expect(res.total).toBe(0);
  expect(res.dimensions).toBe(0);
});

test("searchCorpus (public) also degrades gracefully with no key on a fresh project", async () => {
  // The public entry binds the real embedBatch, but the early-return must
  // fire before it — so no key and no network are needed here either.
  const res = await searchCorpus("crime");
  expect(res.embedded).toBe(false);
  expect(res.hits).toEqual([]);
});

// ---------------------------------------------------------------------------
// 3. Query dimension mismatch throws a clear, wrapped error.
//    Setup: lock the corpus at dim 1536 and mark one chunk `done` so the
//    early-return is bypassed; inject a stub embed returning dim 2 → the
//    dimension guard must throw before the KNN query ever runs.
// ---------------------------------------------------------------------------

test("searchCorpus throws query dimension mismatch when the query dim differs", async () => {
  // Lock the corpus at 1536 (creates the vec0 table + stamps the lock).
  lockDimensions(1536, "text-embedding-3-small");

  // Mark one chunk `done` so getEmbeddingStatus().done > 0 (bypasses the
  // early-return). Opened on a SECOND connection (WAL allows it); the vec0
  // extension isn't needed because we only touch regular tables. FK is ON,
  // so insert a dummy source_file before the chunk that references it.
  const dbw = new Database(dbPath);
  dbw.run(
    "INSERT OR IGNORE INTO source_files " +
      "(id, rel_path, filename, ext, kind, text_status, added_at) " +
      "VALUES ('s1', 'a.md', 'a.md', 'md', 'text', 'done', 0)"
  );
  dbw.run(
    "INSERT OR REPLACE INTO chunks " +
      "(id, source_file_id, ord, text, embedding_status) " +
      "VALUES ('c1', 's1', 0, 'some crime text', 'done')"
  );
  dbw.close();

  // Stub embed: returns a deliberately wrong dimension (2 vs locked 1536).
  const stub: EmbedFn = async () => ({
    vectors: [[0.1, 0.2]],
    dimensions: 2,
  });

  let err: Error | null = null;
  try {
    await searchCorpusWith("crime", {}, stub);
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  // Wrapped by searchCorpusWith's try/catch as `search failed: <orig>`.
  expect((err as Error).message).toBe(
    "search failed: query dimension mismatch: locked 1536, got 2"
  );
});
