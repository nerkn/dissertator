// Ingestion orchestrator (Track D+E).
//
// Owns the per-file pipeline: stat → hash → dedup → upsert → extract → cache →
// chunk → done (with `needs_ocr` / `failed` side exits). A bounded worker
// queue (concurrency 3) drains the backlog; a recursive watcher enqueues new
// or changed files; a tree walk powers the initial scan. Events are emitted
// on every status transition for the future SSE layer to fan out.
//
// Public contract (do not rename): start / stop / enqueuePath / scanAll /
// ocrSource / listSources / listAttention / getSourceCounts / onEvent, plus
// the `IngestEvent` type.

import { createHash, randomUUID } from "node:crypto";
import { appendFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import type { Database } from "bun:sqlite";

import type {
  SourceCounts,
  SourceFile,
  TextStatus,
} from "@dissertator/shared";

import { detectKind, extract } from "../extract/index.ts";
import type { ExtractResult } from "../extract/index.ts";
import { runOcr } from "../ocr/index.ts";
import type { OcrEngine, OcrOptions } from "../ocr/index.ts";
import {
  getCurrentProject,
  getSettings,
  mapSourceFile,
} from "../db.ts";

import { createQueue } from "./queue.ts";
import { chunkExtracted, type ChunkOutput } from "./chunk.ts";
import {
  isExcludedPath,
  scanFiles,
  startWatcher,
  stopWatcher,
} from "./watch.ts";

export interface IngestEvent {
  sourceFileId: string;
  status: TextStatus;
  error?: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const listeners = new Set<(e: IngestEvent) => void>();

function emit(e: IngestEvent): void {
  for (const cb of listeners) {
    try {
      cb(e);
    } catch {
      /* a listener must never break emit */
    }
  }
}

/** Subscribe to ingest status events. Returns an unsubscribe fn. */
export function onEvent(cb: (e: IngestEvent) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---------------------------------------------------------------------------
// Queue + logging
// ---------------------------------------------------------------------------

/** Append a line to `Dissertator/logs/ingest.log`; never throws. */
async function appendLog(line: string): Promise<void> {
  try {
    const project = getCurrentProject();
    if (!project) return;
    const logPath = join(project.dissertatorDir, "logs", "ingest.log");
    const stamp = new Date().toISOString();
    await appendFile(logPath, `${stamp} ${line}\n`, "utf8");
  } catch {
    /* logging must never throw */
  }
}

const queue = createQueue({
  concurrency: 3,
  onError: (err) => {
    // Backstop for truly unexpected task rejections. Per-step expected
    // errors are caught inside `ingestFile` and surfaced via status events.
    const msg = (err as Error)?.message ?? String(err);
    void appendLog(`[queue] uncaught error: ${msg}`);
  },
});

/** relPaths currently queued or in-flight — prevents redundant concurrent work. */
const inFlight = new Set<string>();

// ---------------------------------------------------------------------------
// Chunks
// ---------------------------------------------------------------------------

/**
 * Replace a source file's chunks. Runs in a transaction: delete-then-insert,
 * `ord` is 0-based. Callers own the page metadata on each `ChunkOutput`.
 */
function insertChunks(
  db: Database,
  sourceFileId: string,
  chunks: ChunkOutput[]
): void {
  const tx = db.transaction((items: ChunkOutput[]) => {
    db.prepare("DELETE FROM chunks WHERE source_file_id = ?").run(sourceFileId);
    const stmt = db.prepare(
      "INSERT INTO chunks (id, source_file_id, ord, physical_page, printed_page, text, token_count) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    items.forEach((c, i) =>
      stmt.run(
        randomUUID(),
        sourceFileId,
        i,
        c.physicalPage,
        c.printedPage,
        c.text,
        c.tokenCount
      )
    );
  });
  tx(chunks);
}

// ---------------------------------------------------------------------------
// Per-file orchestrator
// ---------------------------------------------------------------------------

interface SourceFileRow {
  id: string;
  rel_path: string;
  content_hash: string | null;
  page_count: number | null;
  mime_type: string | null;
}

/**
 * Ingest a single relative path end-to-end. Never throws to the caller —
 * expected failures (missing file, unsupported kind, extract/ocr errors) set
 * the row's `text_status` to `failed` and emit an event; the watcher queue
 * treats this as a successful task.
 */
async function ingestFile(relPath: string): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const { db, projectPath, dissertatorDir } = project;

  const absPath = resolve(projectPath, relPath);

  // 1. Stat — a gone file means delete its row (chunks cascade).
  let st;
  try {
    st = await stat(absPath);
  } catch {
    deleteRowsByPath(db, relPath);
    return;
  }
  if (!st.isFile()) return; // directories have no row

  // 2. Hash + dedup by content (across any path).
  const buf = Buffer.from(await Bun.file(absPath).arrayBuffer());
  const contentHash = createHash("sha256")
    .update(buf)
    .digest("hex");

  const byHash = db
    .prepare("SELECT id FROM source_files WHERE content_hash = ?")
    .get(contentHash) as { id: string } | undefined;
  if (byHash) {
    // Identical content already extracted — refresh bookkeeping only.
    db.prepare("UPDATE source_files SET mtime = ?, file_size = ? WHERE id = ?")
      .run(Math.floor(st.mtimeMs), st.size, byHash.id);
    emit({ sourceFileId: byHash.id, status: "done" });
    return;
  }

  // 3. Upsert a row (reuse the id if this rel_path already has one, so a
  //    file that changed content keeps a stable id across re-extracts).
  const filename = basename(absPath);
  const kind = detectKind(filename);
  const ext = extname(filename).toLowerCase().replace(/^\./, "") || "";
  const existingByPath = db
    .prepare("SELECT id FROM source_files WHERE rel_path = ?")
    .get(relPath) as { id: string } | undefined;
  const id = existingByPath?.id ?? randomUUID();
  const now = Date.now();

  // Positional `?` params (bun:sqlite named-param object binding requires
  // sigil-prefixed keys, so we keep this consistent with db.ts and use `?`).
  db.prepare(
    `INSERT INTO source_files
       (id, rel_path, filename, ext, kind, content_hash, file_size, mtime,
        mime_type, page_count, extracted_path, needs_ocr_reason,
        text_status, ocr_method, error, added_at)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 'extracting', NULL, NULL, ?)
     ON CONFLICT(id) DO UPDATE SET
       rel_path = excluded.rel_path,
       filename = excluded.filename,
       ext = excluded.ext,
       kind = excluded.kind,
       content_hash = excluded.content_hash,
       file_size = excluded.file_size,
       mtime = excluded.mtime,
       mime_type = NULL,
       page_count = NULL,
       extracted_path = NULL,
       needs_ocr_reason = NULL,
       text_status = 'extracting',
       ocr_method = NULL,
       error = NULL`
  ).run(
    id,
    relPath,
    filename,
    ext,
    kind,
    contentHash,
    st.size,
    Math.floor(st.mtimeMs),
    now
  );

  emit({ sourceFileId: id, status: "extracting" });

  // 4. Unsupported kind (legacy .doc/.xls, unknown exts).
  if (kind === "unsupported") {
    failRow(db, id, "unsupported file kind");
    return;
  }

  // 5. Extract.
  let result: ExtractResult;
  try {
    result = await extract(absPath, kind);
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await appendLog(`[extract] ${relPath}: ${msg}`);
    failRow(db, id, msg);
    return;
  }

  // 6. Cache the extracted text + record mime / page count.
  const cachePath = join(dissertatorDir, "cache", `${contentHash}.txt`);
  try {
    await writeFile(cachePath, result.text, "utf8");
  } catch (e) {
    await appendLog(
      `[cache-write] ${relPath}: ${(e as Error)?.message ?? String(e)}`
    );
  }
  db.prepare(
    "UPDATE source_files SET extracted_path = ?, mime_type = ?, page_count = ? WHERE id = ?"
  ).run(cachePath, result.mimeType, result.pageCount, id);

  // 7. Needs OCR? Park it — do NOT auto-OCR.
  if (result.needsOcr) {
    const reason = kind === "image" ? "image" : "low text yield";
    db.prepare(
      "UPDATE source_files SET text_status = 'needs_ocr', needs_ocr_reason = ? WHERE id = ?"
    ).run(reason, id);
    emit({ sourceFileId: id, status: "needs_ocr" });
    return;
  }

  // 8. Chunk + insert.
  insertChunks(db, id, chunkExtracted(result));

  // 9. Done.
  db.prepare(
    "UPDATE source_files SET text_status = 'done', error = NULL WHERE id = ?"
  ).run(id);
  emit({ sourceFileId: id, status: "done" });
}

/** Mark a row failed + emit. */
function failRow(db: Database, id: string, msg: string): void {
  db.prepare(
    "UPDATE source_files SET text_status = 'failed', error = ? WHERE id = ?"
  ).run(msg, id);
  emit({ sourceFileId: id, status: "failed", error: msg });
}

/** Delete every row whose rel_path matches (chunks cascade via FK). */
function deleteRowsByPath(db: Database, relPath: string): void {
  const rows = db
    .prepare("SELECT id FROM source_files WHERE rel_path = ?")
    .all(relPath) as { id: string }[];
  if (rows.length === 0) return;
  const del = db.prepare("DELETE FROM source_files WHERE id = ?");
  for (const r of rows) del.run(r.id);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let currentRoot: string | null = null;

/**
 * Start watching `projectPath` (recursive) and run an initial scan. Idempotent
 * for the same root; a different root tears down the previous watcher first.
 */
export async function start(projectPath: string): Promise<void> {
  const root = resolve(projectPath);
  if (currentRoot === root && currentRoot !== null) return;
  // Tear down any prior session.
  stopWatcher();
  queue.clear();
  inFlight.clear();
  currentRoot = root;
  startWatcher(root, enqueuePath);
  await scanAll();
}

/** Stop the watcher and clear the queue (in-flight tasks finish). */
export function stop(): void {
  stopWatcher();
  queue.clear();
  inFlight.clear();
  currentRoot = null;
}

/**
 * Enqueue a single relative path for ingestion. Dedups concurrent enqueues of
 * the same path; content-level dedup happens inside `ingestFile`.
 */
export function enqueuePath(relPath: string): void {
  const norm = relPath.replace(/\\/g, "/");
  if (inFlight.has(norm)) return;
  inFlight.add(norm);
  queue.enqueue(async () => {
    try {
      await ingestFile(norm);
    } catch (e) {
      // ingestFile swallows expected errors; this is a true backstop.
      const msg = (e as Error)?.message ?? String(e);
      void appendLog(`[ingest] ${norm}: ${msg}`);
    } finally {
      inFlight.delete(norm);
    }
  });
}

/**
 * Full re-scan of the watched root (minus excluded dirs + node_modules).
 * Returns the count of files enqueued.
 */
export async function scanAll(): Promise<number> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const files = await scanFiles(project.projectPath);
  for (const f of files) {
    enqueuePath(relative(project.projectPath, f));
  }
  return files.length;
}

/**
 * Run OCR on a parked source file. `engine` defaults to the project's
 * `ocrStrategy` setting (`"skip"` throws). On success the OCR text is cached,
 * chunked (single page), and the row marked `done` with `ocr_method` set.
 */
export async function ocrSource(
  id: string,
  engine?: OcrEngine,
  opts?: OcrOptions
): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const { db, projectPath, dissertatorDir } = project;

  const row = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row) throw new Error(`source file not found: ${id}`);

  // Resolve the engine (explicit override → settings → throw on skip).
  let eng: OcrEngine;
  if (engine) {
    eng = engine;
  } else {
    const settings = getSettings();
    if (settings.ocrStrategy === "skip") {
      throw new Error("ocr strategy is skip");
    }
    eng = settings.ocrStrategy; // narrowed to "tesseract" | "vision"
  }

  const runningStatus: TextStatus =
    eng === "vision" ? "pending_vision" : "ocr_tesseract";
  db.prepare(
    "UPDATE source_files SET text_status = ?, error = NULL WHERE id = ?"
  ).run(runningStatus, id);
  emit({ sourceFileId: id, status: runningStatus });

  const absPath = resolve(projectPath, row.rel_path);
  try {
    const ocrResult = await runOcr(absPath, eng, opts);

    const hash = row.content_hash ?? id;
    const cachePath = join(dissertatorDir, "cache", `${hash}.ocr.txt`);
    await writeFile(cachePath, ocrResult.text, "utf8");
    db.prepare(
      "UPDATE source_files SET extracted_path = ?, ocr_method = ? WHERE id = ?"
    ).run(cachePath, eng, id);

    // OCR result is a single page; reuse the existing page_count if any.
    const physPage = row.page_count ?? 1;
    const chunks = chunkExtracted({
      text: ocrResult.text,
      pages: [{ physicalPage: physPage, text: ocrResult.text }],
      pageCount: ocrResult.pageCount,
      needsOcr: false,
      mimeType: row.mime_type ?? "text/plain",
    });
    insertChunks(db, id, chunks);

    db.prepare(
      "UPDATE source_files SET text_status = 'done', error = NULL WHERE id = ?"
    ).run(id);
    emit({ sourceFileId: id, status: "done" });
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    await appendLog(`[ocr] ${row.rel_path}: ${msg}`);
    failRow(db, id, msg);
  }
}

/** All source files, oldest first. */
export function listSources(): SourceFile[] {
  const project = getCurrentProject();
  if (!project) return [];
  const rows = project.db
    .query("SELECT * FROM source_files ORDER BY added_at ASC, filename ASC")
    .all() as unknown[];
  return rows.map((r) => mapSourceFile(r));
}

/** Files needing attention: `needs_ocr`, `pending_vision`, or `failed`. */
export function listAttention(): SourceFile[] {
  const project = getCurrentProject();
  if (!project) return [];
  const rows = project.db
    .prepare(
      "SELECT * FROM source_files WHERE text_status IN ('needs_ocr', 'pending_vision', 'failed') ORDER BY added_at ASC"
    )
    .all() as unknown[];
  return rows.map((r) => mapSourceFile(r));
}

/** Aggregate counts by status bucket. Sums to `total`. */
export function getSourceCounts(): SourceCounts {
  const project = getCurrentProject();
  if (!project) {
    return { total: 0, done: 0, needsOcr: 0, failed: 0, extracting: 0 };
  }
  const rows = project.db
    .query("SELECT text_status AS s, COUNT(*) AS c FROM source_files GROUP BY text_status")
    .all() as { s: string; c: number }[];
  const counts: SourceCounts = {
    total: 0,
    done: 0,
    needsOcr: 0,
    failed: 0,
    extracting: 0,
  };
  for (const r of rows) {
    counts.total += r.c;
    if (r.s === "done") counts.done += r.c;
    else if (r.s === "needs_ocr") counts.needsOcr += r.c;
    else if (r.s === "failed") counts.failed += r.c;
    else counts.extracting += r.c; // new | extracting | ocr_tesseract | pending_vision
  }
  return counts;
}
