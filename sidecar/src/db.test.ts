// DB-backed tests for the embedding dimension lock (P2 hard design rule #2).
//
// sqlite-vec `vec0` tables have a FIXED dimension, set at CREATE time. The
// lock is created lazily on the first successful embed (`lockDimensions`).
// These tests pin the three invariants:
//   1. first call creates the vec0 table + stamps the lock (meta + settings);
//   2. a second call at the SAME dimension is a no-op (no throw);
//   3. a later call at a DIFFERENT dimension throws the mismatch error
//      (never auto-reembeds).
//
// Uses a throwaway project dir + the real `initProject` (which loads the
// sqlite-vec extension). No other test file calls `initProject`, so the
// module-level `current` project is owned exclusively here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  getEmbeddingStatus,
  getSettings,
  initProject,
  lockDimensions,
} from "./db.ts";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-db-"));
  await initProject(dir);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("first lockDimensions creates the vec0 table + stamps the lock", () => {
  // Before: dimensions unlocked.
  expect(getSettings().embedding.dimensions).toBe(0);
  expect(getEmbeddingStatus().dimensions).toBe(0);

  lockDimensions(1536, "text-embedding-3-small");

  // After: lock mirrored into settings + surfaced via status.
  const s = getSettings();
  expect(s.embedding.dimensions).toBe(1536);
  expect(s.embedding.model).toBe("text-embedding-3-small");
  expect(getEmbeddingStatus().dimensions).toBe(1536);
});

test("the vec0 table now accepts a vector at the locked dimension", () => {
  // Direct proof the virtual table exists with the right shape.
  const dbPath = join(dir, "Dissertator", "dissertator.db");
  const ro = new Database(dbPath, { readonly: true });
  const tables = ro
    .query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='embeddings'"
    )
    .all() as { name: string }[];
  expect(tables.length).toBe(1);
  ro.close();
});

test("re-locking at the SAME dimension is a no-op (no throw)", () => {
  expect(() => lockDimensions(1536, "text-embedding-3-small")).not.toThrow();
  expect(getSettings().embedding.dimensions).toBe(1536);
});

test("locking at a DIFFERENT dimension throws the mismatch error", () => {
  // Must NOT auto-reembed — surfaces the P6 re-embed requirement.
  let err: Error | null = null;
  try {
    lockDimensions(768, "text-embedding-004");
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect((err as Error).message).toBe(
    "embedding dimension mismatch: locked 1536, got 768; switch model requires re-embed (P6)"
  );
  // The original lock is preserved (768 must not have replaced 1536).
  expect(getSettings().embedding.dimensions).toBe(1536);
});

test("getEmbeddingStatus reports vecLoaded + zero counts on a fresh project", () => {
  const st = getEmbeddingStatus();
  expect(st.vecLoaded).toBe(true); // sqlite-vec loaded on linux in CI
  expect(st.total).toBe(0);
  expect(st.pending).toBe(0);
  expect(st.done).toBe(0);
  expect(st.failed).toBe(0);
});
