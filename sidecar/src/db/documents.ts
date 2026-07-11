// Documents (editor) (P3): manuscript CRUD.
//
// A Document is ONE body, not a tree of sections. The `body_md` column holds
// the entire manuscript body as a single markdown blob — markdown headers
// (`## intro`) are just lines in the body, not separate rows. "Stats"
// (line count, header positions) are computed by the frontend by parsing
// `body_md`; nothing structural is stored beyond the body itself. Snake↔camel
// mapping mirrors the references layer: `mapDocument` parses JSON columns
// defensively (never throws). `research_questions` is a JSON string[].

import { randomUUID } from "node:crypto";
import { type DocType, type Document } from "@dissertator/shared";
import { current } from "./_core.ts";

/**
 * Snake_case shape of a `documents` row as returned by `bun:sqlite`.
 * `research_questions` is a JSON string at this layer; parsed back to a
 * string[] by {@link mapDocument}. `body_md` holds the manuscript body
 * (nullable in SQL, but the app always sets it to at least `""`).
 */
export interface DocumentRow {
  id: string;
  title: string;
  doc_type: string | null;
  thesis: string | null;
  research_questions: string | null; // JSON "[\"...\"]"
  focus_prompt: string | null;
  body_md: string | null; // manuscript body (single markdown blob)
  created_at: number;
}

/**
 * Map a snake_case `documents` DB row to the {@link Document} contract.
 * `research_questions` is JSON-parsed back to a string[] (empty array on
 * parse failure — never throws, mirroring {@link mapReference}). `body_md`
 * defaults to `""` when null so the app always sees a defined body.
 */
export function mapDocument(row: DocumentRow): Document {
  let researchQuestions: string[] = [];
  if (row.research_questions) {
    try {
      const parsed = JSON.parse(row.research_questions) as unknown;
      if (Array.isArray(parsed)) researchQuestions = parsed as string[];
    } catch {
      researchQuestions = [];
    }
  }
  return {
    id: row.id,
    title: row.title,
    docType: (row.doc_type as DocType | null) ?? null,
    thesis: row.thesis ?? null,
    researchQuestions,
    focusPrompt: row.focus_prompt ?? null,
    bodyMd: row.body_md ?? "",
    createdAt: row.created_at,
  };
}

/**
 * List all documents, newest-first (insertion/created_at desc). Mirrors
 * {@link listReferences} (no filter needed yet — single-user, local).
 */
export function listDocuments(): Document[] {
  if (!current) throw new Error("no project initialized");
  const rows = current.db
    .prepare("SELECT * FROM documents ORDER BY created_at DESC, id ASC")
    .all() as DocumentRow[];
  return rows.map(mapDocument);
}

/**
 * INSERT a document with an empty body.
 *
 * The manuscript body lives ON the document row as `body_md`, seeded to `""`
 * so the editor always has a body to write into. `researchQuestions` is
 * JSON-serialized (default `[]`). Returns the created {@link Document}.
 */
export function createDocument(input: {
  title: string;
  docType?: DocType;
  thesis?: string;
  researchQuestions?: string[];
  focusPrompt?: string;
}): Document {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const id = randomUUID();
  const createdAt = Date.now();
  db.prepare(
    "INSERT INTO documents " +
      "(id, title, doc_type, thesis, research_questions, focus_prompt, body_md, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    input.title,
    input.docType ?? null,
    input.thesis ?? null,
    JSON.stringify(input.researchQuestions ?? []),
    input.focusPrompt ?? null,
    "", // body_md seeded empty; the editor writes into it
    createdAt
  );
  return mapDocument(
    db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow
  );
}

/**
 * Fetch a document by id. Returns null if the id is unknown (the route
 * turns this into a 404). The body is carried on the returned document.
 */
export function getDocument(id: string): Document | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare("SELECT * FROM documents WHERE id = ?")
    .get(id) as DocumentRow | null;
  return row ? mapDocument(row) : null;
}

/**
 * Partial-patch a document by id. Omitted fields keep their DB value; `null`
 * clears a nullable field (docType/thesis/focusPrompt). `bodyMd` follows a
 * `!== undefined` discipline so an explicit `""` is a valid SET (empty body),
 * distinct from omitting the field (keep the existing body). Returns null if
 * the document id is unknown (404-style). `researchQuestions` is
 * JSON-serialized when provided.
 */
export function updateDocument(
  id: string,
  patch: Partial<{
    title: string;
    docType: DocType | null;
    thesis: string | null;
    researchQuestions: string[];
    focusPrompt: string | null;
    bodyMd: string;
  }>
): Document | null {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const existing = db.prepare("SELECT * FROM documents WHERE id = ?").get(
    id
  ) as DocumentRow | null;
  if (!existing) return null;
  // Merge patch over the existing row. `!== undefined` distinguishes
  // "omitted" (keep) from an explicit value (set, including "" for bodyMd
  // and null for the other nullable columns).
  const title = patch.title ?? existing.title;
  const docType = patch.docType !== undefined ? patch.docType : existing.doc_type;
  const thesis = patch.thesis !== undefined ? patch.thesis : existing.thesis;
  const researchQuestions =
    patch.researchQuestions !== undefined
      ? JSON.stringify(patch.researchQuestions)
      : existing.research_questions;
  const focusPrompt =
    patch.focusPrompt !== undefined ? patch.focusPrompt : existing.focus_prompt;
  const bodyMd = patch.bodyMd !== undefined ? patch.bodyMd : existing.body_md;
  db.prepare(
    "UPDATE documents SET title = ?, doc_type = ?, thesis = ?, " +
      "research_questions = ?, focus_prompt = ?, body_md = ? WHERE id = ?"
  ).run(title, docType, thesis, researchQuestions, focusPrompt, bodyMd, id);
  return mapDocument(
    db.prepare("SELECT * FROM documents WHERE id = ?").get(id) as DocumentRow
  );
}

/**
 * Delete a document by id. Returns true if a row was deleted, false if the
 * id was unknown (idempotent).
 */
export function deleteDocument(id: string): boolean {
  if (!current) throw new Error("no project initialized");
  const res = current.db
    .prepare("DELETE FROM documents WHERE id = ?")
    .run(id);
  return res.changes > 0;
}
