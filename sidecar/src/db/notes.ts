// Notes (collect-while-reading). A note is a highlight/excerpt on a source
// page, grouped into a list. The citekey shown alongside a note is resolved
// through the reference linked to the note's source (NOTES_WITH_CITE).

import { randomUUID } from "node:crypto";
import { type Note, type NoteRect } from "@dissertator/shared";
import { current } from "./_core.ts";

/** Snake_case shape of a `notes` row, enriched with the joined `citekey`. */
interface NoteRow {
  id: string;
  source_file_id: string;
  page: number;
  excerpt: string | null;
  body: string | null;
  list_id: number;
  rect: string | null;
  created_at: number;
  citekey: string | null;
}

/** SQL + JSON mapping shared by every notes read path. */
function mapNote(r: NoteRow): Note {
  let rect: NoteRect | null = null;
  if (r.rect) {
    try {
      const p = JSON.parse(r.rect) as unknown;
      if (
        p &&
        typeof p === "object" &&
        typeof (p as NoteRect).x === "number"
      ) {
        rect = p as NoteRect;
      }
    } catch {
      rect = null;
    }
  }
  return {
    id: r.id,
    sourceId: r.source_file_id,
    page: r.page,
    excerpt: r.excerpt,
    body: r.body,
    listId: r.list_id,
    rect,
    createdAt: r.created_at,
    citekey: r.citekey ?? null,
  };
}

/**
 * Notes SELECT with the citekey subquery baked in. A note's citekey is the
 * citekey of the reference linked to the note's source — resolved through the
 * CANONICAL direction `references.source_file_id` (never the reverse, never
 * stored on the note or source). LIMIT 1 honors the one-citekey-per-source
 * invariant even if two references ever pointed at the same source.
 */
const NOTES_WITH_CITE =
  "SELECT n.*, (" +
  ' SELECT r.citekey FROM "references" r' +
  "  WHERE r.source_file_id = n.source_file_id LIMIT 1" +
  ") AS citekey FROM notes n ";

/** Notes, optionally filtered by list and/or source, newest-first. */
export function listNotes(
  opts: { listId?: number; sourceId?: string } = {},
): Note[] {
  if (!current) throw new Error("no project initialized");
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.listId !== undefined) {
    where.push("n.list_id = ?");
    params.push(opts.listId);
  }
  if (opts.sourceId) {
    where.push("n.source_file_id = ?");
    params.push(opts.sourceId);
  }
  const sql =
    NOTES_WITH_CITE +
    (where.length ? "WHERE " + where.join(" AND ") + " " : "") +
    "ORDER BY n.created_at DESC";
  return (current.db.prepare(sql).all(...params) as NoteRow[]).map(mapNote);
}

/** Create a note. excerpt/body/rect optional. Returns the row w/ citekey. */
export function createNote(input: {
  sourceId: string;
  page: number;
  excerpt?: string | null;
  body?: string | null;
  listId: number;
  rect?: NoteRect | null;
}): Note {
  if (!current) throw new Error("no project initialized");
  const id = randomUUID();
  const now = Date.now();
  current.db
    .prepare(
      "INSERT INTO notes(id, source_file_id, page, excerpt, body, list_id, rect, created_at) " +
        "VALUES (?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      input.sourceId,
      input.page,
      input.excerpt ?? null,
      input.body ?? null,
      input.listId,
      input.rect ? JSON.stringify(input.rect) : null,
      now,
    );
  return mapNote(
    current.db.prepare(NOTES_WITH_CITE + "WHERE n.id = ?").get(id) as NoteRow,
  );
}

/** Patch a note's excerpt/body/listId/rect. Returns null if not found. */
export function updateNote(
  id: string,
  patch: {
    excerpt?: string | null;
    body?: string | null;
    listId?: number;
    rect?: NoteRect | null;
  },
): Note | null {
  if (!current) throw new Error("no project initialized");
  const existing = current.db.prepare("SELECT * FROM notes WHERE id = ?").get(
    id,
  ) as NoteRow | undefined;
  if (!existing) return null;
  const excerpt = patch.excerpt !== undefined ? patch.excerpt : existing.excerpt;
  const body = patch.body !== undefined ? patch.body : existing.body;
  const listId = patch.listId ?? existing.list_id;
  const rect =
    patch.rect !== undefined
      ? patch.rect
        ? JSON.stringify(patch.rect)
        : null
      : existing.rect;
  current.db
    .prepare("UPDATE notes SET excerpt = ?, body = ?, list_id = ?, rect = ? WHERE id = ?")
    .run(excerpt, body, listId, rect, id);
  return mapNote(
    current.db.prepare(NOTES_WITH_CITE + "WHERE n.id = ?").get(id) as NoteRow,
  );
}

/** Delete a note by id. Returns true if a row was removed. */
export function deleteNote(id: string): boolean {
  if (!current) throw new Error("no project initialized");
  const res = current.db.prepare("DELETE FROM notes WHERE id = ?").run(id);
  return res.changes > 0;
}
