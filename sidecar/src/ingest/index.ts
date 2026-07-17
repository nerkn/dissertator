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
import { adapterFromType } from "@dissertator/shared";

import { detectKind, extract } from "../extract/index.ts";
import type { ExtractResult } from "../extract/index.ts";
import { runOcr, runDescribe } from "../ocr/index.ts";
import type { OcrEngine, OcrOptions } from "../ocr/index.ts";
import {
  runTranscribe,
  type TranscribeOptions,
} from "../transcribe/index.ts";
import { embedBatch, type EmbedEngine } from "../embed/index.ts";
import { scheduleLocalEmbedIdleUnload } from "../embed/local.ts";
import {
  ensureReferenceForSource,
  getCurrentProject,
  getSettings,
  lockDimensions,
  mapSourceFile,
  type SourceFileRow,
} from "../db";

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

/** Strip a file's extension to form a human-readable placeholder reference
 *  title (the citekey is derived from this title's first significant word). */
function refTitle(filename: string, ext: string): string {
  const dotExt = ext ? `.${ext}` : "";
  return dotExt && filename.endsWith(dotExt)
    ? filename.slice(0, -dotExt.length)
    : filename;
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
    // `embedding_status` is explicit (NOT just the column default) so a
    // re-chunk after OCR / re-extract always resets to `pending` — even if a
    // future schema change alters the default. Vectors for the old chunk ids
    // (now deleted) are orphaned in vec0; search_corpus (P2 Track 2) joins on
    // chunk_id and simply ignores them.
    const stmt = db.prepare(
      "INSERT INTO chunks (id, source_file_id, ord, physical_page, printed_page, text, token_count, embedding_status) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')"
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

  // 4b. Audio has no born-digital text to extract — park it for STT.
  // The actual transcription is key-gated (like OCR-vision), so it is
  // triggered later by the frontend via POST /sources/:id/transcribe.
  if (kind === "audio") {
    db.prepare(
      "UPDATE source_files SET text_status = 'needs_transcription', needs_ocr_reason = 'audio' WHERE id = ?"
    ).run(id);
    emit({ sourceFileId: id, status: "needs_transcription" });
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
  // Guarantee this freshly-ingested source has a citekey-bearing reference
  // so its notes are immediately citable (no greyed button). No-op if a
  // reference was already linked (e.g. by Crossref/DOI detection). The
  // placeholder citekey derives from the filename; metadata arrives later.
  // See docs/citekey.md §3.
  ensureReferenceForSource(id, refTitle(filename, ext));
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

/**
 * Describe a standalone image (vision_image function) via an OpenAI-compatible
 * vision endpoint, then chunk + store the description as the source's text —
 * mirrors {@link ocrSource} but uses a describe prompt instead of OCR
 * extraction. The API key is supplied by the caller (HTTP → keychain) via
 * `opts.apiKey`; never read from settings.
 */
export async function describeImageSource(
  id: string,
  opts?: OcrOptions
): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const { db, projectPath, dissertatorDir } = project;

  const row = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row) throw new Error(`source file not found: ${id}`);

  db.prepare(
    "UPDATE source_files SET text_status = 'pending_vision', error = NULL WHERE id = ?"
  ).run(id);
  emit({ sourceFileId: id, status: "pending_vision" });

  const absPath = resolve(projectPath, row.rel_path);
  try {
    const result = await runDescribe(absPath, opts ?? {});

    const hash = row.content_hash ?? id;
    const cachePath = join(dissertatorDir, "cache", `${hash}.img.txt`);
    await writeFile(cachePath, result.text, "utf8");
    db.prepare(
      "UPDATE source_files SET extracted_path = ?, ocr_method = 'vision-image' WHERE id = ?"
    ).run(cachePath, id);

    const physPage = row.page_count ?? 1;
    const chunks = chunkExtracted({
      text: result.text,
      pages: [{ physicalPage: physPage, text: result.text }],
      pageCount: result.pageCount,
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
    await appendLog(`[describe] ${row.rel_path}: ${msg}`);
    failRow(db, id, msg);
  }
}

/**
 * Transcribe an audio source via a Whisper-compatible endpoint, then chunk +
 * store the transcript exactly like OCR text. The API key is supplied by the
 * caller (HTTP layer → keychain) via `opts.apiKey`; never read from settings.
 */
export async function transcribeSource(
  id: string,
  opts?: TranscribeOptions
): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const { db, projectPath, dissertatorDir } = project;

  const row = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row) throw new Error(`source file not found: ${id}`);

  db.prepare(
    "UPDATE source_files SET text_status = 'pending_transcription', error = NULL WHERE id = ?"
  ).run(id);
  emit({ sourceFileId: id, status: "pending_transcription" });

  const absPath = resolve(projectPath, row.rel_path);
  try {
    const result = await runTranscribe(absPath, opts ?? {});

    const hash = row.content_hash ?? id;
    const cachePath = join(dissertatorDir, "cache", `${hash}.stt.txt`);
    await writeFile(cachePath, result.text, "utf8");
    db.prepare(
      "UPDATE source_files SET extracted_path = ?, ocr_method = 'whisper' WHERE id = ?"
    ).run(cachePath, id);

    // Transcript is a single "page"; reuse page_count if any.
    const physPage = row.page_count ?? 1;
    const chunks = chunkExtracted({
      text: result.text,
      pages: [{ physicalPage: physPage, text: result.text }],
      pageCount: 1,
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
    await appendLog(`[stt] ${row.rel_path}: ${msg}`);
    failRow(db, id, msg);
    // Rethrow so the HTTP layer surfaces a real error to the frontend (the
    // attention panel shows it inline). Status is already 'failed' via
    // failRow above.
    throw e;
  }
}

/** All source files, oldest first. */
export function listSources(): SourceFile[] {
  const project = getCurrentProject();
  if (!project) return [];
  const rows = project.db
    .query("SELECT * FROM source_files ORDER BY added_at ASC, filename ASC")
    .all() as SourceFileRow[];
  return rows.map((r) => mapSourceFile(r));
}

/** Files needing attention: `needs_ocr`, `pending_vision`,
 * `needs_transcription`, `pending_transcription`, or `failed`. */
export function listAttention(): SourceFile[] {
  const project = getCurrentProject();
  if (!project) return [];
  const rows = project.db
    .prepare(
      "SELECT * FROM source_files WHERE text_status IN ('needs_ocr', 'pending_vision', 'needs_transcription', 'pending_transcription', 'failed') ORDER BY added_at ASC"
    )
    .all() as SourceFileRow[];
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

// ---------------------------------------------------------------------------
// Embedding (P2 Track 1)
// ---------------------------------------------------------------------------

/** Soft cap so a single `/embed` click never runs away on a huge corpus. */
const EMBED_MAX_CHUNKS_PER_RUN = 500;

/**
 * Inputs per provider POST. OpenAI accepts up to 2048; Google's
 * `batchEmbedContents` accepts up to 100. 64 is a safe cross-provider cap.
 */
// Batch size for embedding. On CPU the total compute is fixed (N chunks →
// N forward passes' worth of FLOPs); a bigger batch only amortizes per-call
// overhead — at the cost of peak RAM, since transformer activations scale
// linearly with batch. We keep it tiny: 4 sequences per inference keeps peak
// residency minimal on ordinary laptops, and the cost is only ~125 ms-scale
// session.run overheads across a 500-chunk run (vs ~8 at batch 64). Pair with
// the thread cap in embed/local.ts.
const EMBED_BATCH_SIZE = 4;

/**
 * Pause between consecutive inference batches during a drain. The local
 * transformer is CPU-heavy (4 intra-op threads); a short gap lets the GC
 * reclaim the previous batch's activations and keeps the desktop responsive
 * instead of pinning all cores for the whole (potentially hour-long) run.
 * Remote providers don't need it but pay only the idle. Tunable via env.
 */
const EMBED_INTER_BATCH_DELAY_MS = (() => {
  const env = Number(process.env.DISSERTATOR_EMBED_BATCH_DELAY_MS);
  return Number.isFinite(env) && env >= 0 ? env : 2000;
})();

/** Result of an `embedPending` run — chunks moved to `done` vs `failed`. */
export interface EmbedPendingResult {
  embedded: number;
  failed: number;
}

/** Per-page outcome; `drained` = no more pending expected, `fatal` = abort. */
interface EmbedPageResult {
  embedded: number;
  failed: number;
  /** true when this page was short of the cap → backlog is exhausted. */
  drained: boolean;
  /** true on a dimension-mismatch (permanent) → the whole drain must stop. */
  fatal: boolean;
}

/** Resolve + validate the embed binding; throws an actionable error if unset. */
function resolveEmbedBinding(): {
  engine: EmbedEngine;
  apiUrl: string | undefined;
  model: string;
} {
  const cfg = getSettings().resolved?.embed;
  if (!cfg?.type) {
    throw new Error("no embed provider bound — set one in Settings → Functions");
  }
  const engine: EmbedEngine = adapterFromType(cfg.type);
  if (engine !== "local" && (!cfg.apiUrl || !cfg.model)) {
    throw new Error(
      "no embed provider/model bound — set one in Settings → Functions",
    );
  }
  const model =
    engine === "local"
      ? cfg.model || "granite-embedding-97m-multilingual-r2"
      : cfg.model;
  return { engine, apiUrl: cfg.apiUrl, model };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Process one page (up to `EMBED_MAX_CHUNKS_PER_RUN` pending chunks) in
 * sub-batches of `EMBED_BATCH_SIZE`, sleeping `EMBED_INTER_BATCH_DELAY_MS`
 * between batches. On the first successful batch `lockDimensions` creates the
 * vec0 table with the concrete dimensionality; a later batch returning a
 * different dimensionality is a fatal, permanent lock conflict. Per-batch
 * adapter failures are caught: the affected chunks flip to `failed` (logged)
 * and the page continues with the next batch. The embedding key flows in ONLY
 * via `opts.apiKey` (HTTP → keychain); never stored or logged.
 */
async function processEmbedPage(
  opts: { apiKey?: string } = {}
): Promise<EmbedPageResult> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const { db } = project;
  const { engine, apiUrl, model } = resolveEmbedBinding();

  // Pull the backlog (bounded). `text != ''` skips degenerate chunks.
  const pending = db
    .prepare(
      "SELECT id, text FROM chunks " +
        "WHERE embedding_status = 'pending' AND text != '' " +
        "ORDER BY id LIMIT ?"
    )
    .all(EMBED_MAX_CHUNKS_PER_RUN) as { id: string; text: string }[];

  if (pending.length === 0) {
    return { embedded: 0, failed: 0, drained: true, fatal: false };
  }

  const markEmbedding = db.prepare(
    "UPDATE chunks SET embedding_status = 'embedding' WHERE id = ?"
  );
  const markDone = db.prepare(
    "UPDATE chunks SET embedding_status = 'done' WHERE id = ?"
  );
  const markFailed = db.prepare(
    "UPDATE chunks SET embedding_status = 'failed' WHERE id = ?"
  );

  let embedded = 0;
  let failed = 0;
  let fatal = false;

  for (let i = 0; i < pending.length; i += EMBED_BATCH_SIZE) {
    const slice = pending.slice(i, i + EMBED_BATCH_SIZE);
    // Mark in-flight up front so a crash mid-batch leaves a recoverable state.
    for (const c of slice) markEmbedding.run(c.id);

    try {
      const result = await embedBatch(
        slice.map((c) => c.text),
        engine,
        { apiKey: opts.apiKey, apiUrl, model }
      );
      if (result.vectors.length !== slice.length) {
        throw new Error(
          `vector count mismatch: sent ${slice.length}, got ${result.vectors.length}`
        );
      }
      // First successful batch locks the dimensionality (creates vec0 table).
      lockDimensions(result.dimensions, model);

      const ins = db.prepare(
        "INSERT INTO embeddings(chunk_id, embedding) VALUES (?, ?)"
      );
      for (let j = 0; j < slice.length; j++) {
        ins.run(slice[j].id, new Float32Array(result.vectors[j]));
        markDone.run(slice[j].id);
        embedded++;
      }
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      await appendLog(`[embed] batch failed: ${msg}`);
      for (const c of slice) markFailed.run(c.id);
      failed += slice.length;
      // A dimension mismatch is a permanent lock conflict — stop now; every
      // remaining batch would fail identically. Other errors (auth, network)
      // are also typically permanent within one run, but we keep going so a
      // single transient blip doesn't poison the whole corpus.
      if (/dimension mismatch/.test(msg)) {
        fatal = true;
        break;
      }
    }

    // Pace the drain: a brief gap between batches so the local transformer
    // doesn't pin every core for the whole run and GC can reclaim. Skipped
    // after the last batch of the page (nothing more to wait for here).
    if (i + EMBED_BATCH_SIZE < pending.length && EMBED_INTER_BATCH_DELAY_MS > 0) {
      await sleep(EMBED_INTER_BATCH_DELAY_MS);
    }
  }

  return {
    embedded,
    failed,
    drained: pending.length < EMBED_MAX_CHUNKS_PER_RUN,
    fatal,
  };
}

/**
 * Embed a single bounded page (≤500 chunks). Kept as a programmatic
 * one-shot entrypoint; the HTTP layer uses {@link embedAll} for the full
 * background drain.
 */
export async function embedPending(
  opts: { apiKey?: string } = {}
): Promise<EmbedPendingResult> {
  const r = await processEmbedPage(opts);
  return { embedded: r.embedded, failed: r.failed };
}

// --- Background full-corpus drain -----------------------------------------

/** True while a background drain is running (drives the `running` status flag). */
let drainRunning = false;

/** Is a background embed drain in progress? */
export function isEmbedDraining(): boolean {
  return drainRunning;
}

/**
 * Kick off a background drain that embeds EVERY pending chunk, page by page,
 * until the backlog is empty. Fire-and-forget: returns immediately so the
 * HTTP request can't be killed by the socket idle timeout on a long corpus
 * (a full drain can run for tens of minutes). Progress is observable via
 * `GET /embed/status` (the existing 5s poll) — `pending`/`done` move live and
 * `running` reflects this flag. A second call while draining is a no-op.
 * On a fatal dimension mismatch the drain aborts (every page would fail
 * identically); other per-batch failures are logged and skipped.
 */
export function embedAll(opts: { apiKey?: string } = {}): {
  started: boolean;
  running: boolean;
} {
  if (drainRunning) return { started: false, running: true };
  // Validate project + vec up front so the caller gets an immediate error
  // instead of a silently-never-starting background task.
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  if (!project.vecExtensionOk) {
    throw new Error(
      "sqlite-vec extension not loaded; embeddings disabled on this platform"
    );
  }
  resolveEmbedBinding(); // throws if no provider bound

  drainRunning = true;
  void drainAll(opts);
  return { started: true, running: true };
}

/** Internal: loop pages until drained or a fatal error. Never throws. */
async function drainAll(opts: { apiKey?: string }): Promise<void> {
  let totalEmbedded = 0;
  let totalFailed = 0;
  try {
    for (;;) {
      const r = await processEmbedPage(opts);
      totalEmbedded += r.embedded;
      totalFailed += r.failed;
      if (r.fatal) {
        await appendLog(
          `[embed] drain aborted: dimension mismatch after ${totalEmbedded} embedded, ${totalFailed} failed`
        );
        break;
      }
      if (r.drained && r.embedded === 0 && r.failed === 0) break;
      // A page that returned no work but wasn't drained shouldn't loop-spin;
      // processEmbedPage returns drained=true on an empty pull, so we're safe.
    }
    await appendLog(
      `[embed] drain complete: ${totalEmbedded} embedded, ${totalFailed} failed`
    );
  } catch (e) {
    // processEmbedPage validates project/vec; a throw here is unexpected.
    await appendLog(
      `[embed] drain aborted: ${(e as Error)?.message ?? String(e)}`
    );
  } finally {
    drainRunning = false;
    // Release the local ONNX session if it's been idle since the last batch.
    // Idle-based (not a hard unload) because corpus search reuses the same
    // session — a hard unload would cold-reload ~94 MB on the next query.
    scheduleLocalEmbedIdleUnload();
  }
}
