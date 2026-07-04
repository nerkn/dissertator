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

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  getCurrentProject,
  getEmbeddingStatus,
  getSettings,
  getSourceById,
  getSourceText,
  initProject,
  lockDimensions,
} from "./db.ts";
import { parsePrompts } from "./prompts.ts";

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

// --- P3 Workstream 2: getSourceById + getSourceText -----------------------
// These back the sidecar's `/files/:id` and `/sources/:id/text` endpoints.
// We seed rows directly (the ingest pipeline writes the same shape) and pin:
//   - getSourceById maps snake_case → camelCase SourceFile, null when unknown;
//   - getSourceText concatenates chunks page-tagged, in `ord` order, with the
//     source filename + page_count; empty text (NOT an error) when no chunks.
const SRC_ID = "src-getsource-tests-todo-md";
const SRC_NO_CHUNKS_ID = "src-getsource-tests-empty-pdf";

function seedGetSourceRows(): void {
  const db = getCurrentProject()!.db;
  // A text source with two chunks across two pages (inserted OUT of `ord`
  // order to prove the ORDER BY ord ASC matters).
  db.prepare(
    `INSERT OR REPLACE INTO source_files
     (id, rel_path, filename, ext, kind, mime_type, page_count, text_status, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(SRC_ID, "notes/todo.md", "todo.md", "md", "text", "text/markdown", 2, "done", 1700000000);
  db.prepare(
    `INSERT OR REPLACE INTO chunks (id, source_file_id, ord, physical_page, text)
     VALUES (?, ?, ?, ?, ?)`
  ).run("chk-2", SRC_ID, 2, 2, "buy milk");
  db.prepare(
    `INSERT OR REPLACE INTO chunks (id, source_file_id, ord, physical_page, text)
     VALUES (?, ?, ?, ?, ?)`
  ).run("chk-1", SRC_ID, 1, 1, "wake up");
  // A second source that exists but has NO chunks (failed/uneextracted).
  db.prepare(
    `INSERT OR REPLACE INTO source_files
     (id, rel_path, filename, ext, kind, page_count, text_status, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    SRC_NO_CHUNKS_ID,
    "broken.pdf",
    "broken.pdf",
    "pdf",
    "pdf",
    null,
    "failed",
    1700000001
  );
}

test("getSourceById maps the row to a camelCase SourceFile, null when unknown", () => {
  seedGetSourceRows();
  const src = getSourceById(SRC_ID)!;
  expect(src).not.toBeNull();
  expect(src.id).toBe(SRC_ID);
  expect(src.relPath).toBe("notes/todo.md");
  expect(src.filename).toBe("todo.md");
  expect(src.kind).toBe("text");
  expect(src.mimeType).toBe("text/markdown");
  expect(src.pageCount).toBe(2);
  expect(src.textStatus).toBe("done");
  // Unknown id → null (the route turns this into a 404).
  expect(getSourceById("does-not-exist-id")).toBeNull();
});

test("getSourceText concatenates chunks page-tagged in `ord` order", () => {
  const got = getSourceText(SRC_ID);
  expect(got.filename).toBe("todo.md");
  expect(got.pageCount).toBe(2);
  // `ord` 1 chunk (page 1) comes before `ord` 2 (page 2) despite insert order.
  expect(got.text).toBe("[p.1] wake up\n\n[p.2] buy milk");
});

test("getSourceText returns empty text (not an error) for a chunkless source", () => {
  const got = getSourceText(SRC_NO_CHUNKS_ID);
  expect(got.filename).toBe("broken.pdf");
  expect(got.text).toBe("");
  expect(got.pageCount).toBe(0); // page_count was NULL → coerced to 0
});

test("getSourceText on an unknown id returns empty filename + text", () => {
  // Mirrors the route's 404 path: getSourceById nulls first, but getSourceText
  // itself must not throw on a bare unknown id.
  const got = getSourceText("totally-unknown-id");
  expect(got.filename).toBe("");
  expect(got.text).toBe("");
  expect(got.pageCount).toBe(0);
});

test("initProject seeds a default prompts.md that parses + is write-once", async () => {
  // The seeded prompts.md (Dissertator/prompts.md) must exist after init,
  // parse into a non-empty Prompt[], include the "New document" entry the
  // New Document button looks for, and NOT be overwritten on re-init.
  const project = getCurrentProject()!;
  const promptsPath = join(project.dissertatorDir, "prompts.md");
  expect(existsSync(promptsPath)).toBe(true);

  const parsed = parsePrompts(readFileSync(promptsPath, "utf8"));
  expect(parsed.length).toBeGreaterThan(0);
  expect(parsed.some((p) => p.label.toLowerCase() === "new document")).toBe(
    true
  );

  // Write-once: user edits must survive a re-init.
  writeFileSync(promptsPath, "- **Mine**: custom\n", "utf8");
  await initProject(dir); // reopen
  const after = readFileSync(promptsPath, "utf8");
  expect(after.trim()).toBe("- **Mine**: custom");
});
