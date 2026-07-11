// Source files read paths: row shape + mapping + single-source fetches +
// open-files chat context. (Source ingestion lives in src/ingest; this is the
// read side used by routes and the agent loop.)

import { type SourceFile, type TextStatus } from "@dissertator/shared";
import { current } from "./_core.ts";

/**
 * Snake_case shape of a `source_files` row as returned by `bun:sqlite`
 * (`.all()` / `.get()`). Replaces an untyped `any` boundary at `mapSourceFile`;
 * call sites cast raw query output through this type. The `text_status`
 * column is free-text at the DB layer (the app only writes valid values).
 */
export interface SourceFileRow {
  id: string;
  rel_path: string;
  filename: string;
  ext: string;
  kind: string;
  content_hash: string | null;
  file_size: number | null;
  mime_type: string | null;
  text_status: string;
  ocr_method: string | null;
  page_count: number | null;
  error: string | null;
  needs_ocr_reason: string | null;
  added_at: number;
}

/**
 * Map a snake_case `source_files` DB row to the camelCase `SourceFile`
 * contract shared with the frontend. Reused by later stages.
 */
export function mapSourceFile(row: SourceFileRow): SourceFile {
  return {
    id: row.id,
    relPath: row.rel_path,
    filename: row.filename,
    ext: row.ext,
    kind: row.kind,
    contentHash: row.content_hash ?? null,
    fileSize: row.file_size ?? null,
    mimeType: row.mime_type ?? null,
    // DB column is free-text; the app only ever writes valid TextStatus values.
    textStatus: row.text_status as TextStatus,
    ocrMethod: row.ocr_method ?? null,
    pageCount: row.page_count ?? null,
    error: row.error ?? null,
    needsOcrReason: row.needs_ocr_reason ?? null,
    addedAt: row.added_at,
  };
}

/** Fetch a single source file by id, or null if not found. Used by the
 *  sidecar's byte-stream + text endpoints (`/files/:id`, `/sources/:id/text`). */
export function getSourceById(id: string): SourceFile | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | null;
  return row ? mapSourceFile(row) : null;
}

/**
 * Build a single context string from the open source files' chunks. Each
 * file's chunks are concatenated with page markers, and files are capped so
 * the total stays under `maxChars` (rough token proxy ≈ chars/4). Pure-text
 * injection — no embedding/vector work. Files with no extracted text are
 * skipped silently. Returns `null` if nothing usable was found.
 */
export function buildOpenFilesContext(
  sourceIds: string[],
  maxChars = 12000
): string | null {
  if (!current || sourceIds.length === 0) return null;
  const placeholders = sourceIds.map(() => "?").join(",");
  const rows = current.db
    .prepare(
      `SELECT source_file_id, physical_page, text FROM chunks
       WHERE source_file_id IN (${placeholders})
       ORDER BY source_file_id, ord ASC`
    )
    .all(...sourceIds) as Array<{
    source_file_id: string;
    physical_page: number | null;
    text: string;
  }>;
  if (rows.length === 0) return null;

  // Group by source file, prefix with filename for readability.
  const fileNames = new Map<string, string>();
  const nameRows = current.db
    .prepare(
      `SELECT id, filename FROM source_files WHERE id IN (${placeholders})`
    )
    .all(...sourceIds) as Array<{ id: string; filename: string }>;
  for (const r of nameRows) fileNames.set(r.id, r.filename);

  const parts: string[] = [];
  let total = 0;
  let currentFile = "";
  for (const r of rows) {
    if (r.source_file_id !== currentFile) {
      currentFile = r.source_file_id;
      const label = fileNames.get(r.source_file_id) ?? r.source_file_id;
      parts.push(`\n--- ${label} ---`);
    }
    const pageTag =
      r.physical_page != null ? `[p.${r.physical_page}] ` : "";
    const chunk = `${pageTag}${r.text}`;
    if (total + chunk.length > maxChars) break;
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Concatenated extracted text for a SINGLE source file, page-tagged. Used by
 * `GET /sources/:id/text` for the text/docx/xlsx viewer tabs and "search
 * inside". Mirrors {@link buildOpenFilesContext}'s chunk query + page-marker
 * pattern, but for one source and with no char cap (the UI scrolls).
 *
 * If the source has no chunks yet (not extracted / needs OCR), returns an
 * EMPTY `text` with `pageCount: 0` — this is NOT an error; the UI shows
 * "not extracted yet". `filename` is always populated when the source row
 * exists (empty string only if the id is unknown, which the route 404s on).
 */
export function getSourceText(id: string): {
  filename: string;
  text: string;
  pageCount: number;
} {
  if (!current) return { filename: "", text: "", pageCount: 0 };
  const src = current.db
    .prepare("SELECT filename, page_count FROM source_files WHERE id = ?")
    .get(id) as { filename: string; page_count: number | null } | null;
  if (!src) return { filename: "", text: "", pageCount: 0 };
  const rows = current.db
    .prepare(
      "SELECT physical_page, text FROM chunks WHERE source_file_id = ? ORDER BY ord ASC"
    )
    .all(id) as Array<{ physical_page: number | null; text: string }>;
  const text = rows
    .map((r) => (r.physical_page != null ? `[p.${r.physical_page}] ` : "") + r.text)
    .join("\n\n");
  return {
    filename: src.filename,
    text,
    pageCount: src.page_count ?? 0,
  };
}
