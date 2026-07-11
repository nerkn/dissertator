// Shared DB core — the single SQLite connection + schema migration + helpers
// used by 2+ entity modules. Every per-entity module under db/ imports the
// shared `current` handle (and any cross-cutting helper) from here, so they
// all talk to the SAME connection. `initProject` (project.ts) is the only
// writer of `current`, via `setCurrentProject`.
//
// What lives here, by the refactor rule "shared helper needed by 2+ entities
// -> _core": the mutable `current` singleton + its setter, the ProjectState
// shape, schema constants, `migrate`, `readSchema`, `count`, and the small
// set of cross-cutting settings/binding bridges (`readBindingsJoined`,
// `setChatProviderId`) that are referenced from more than one entity module.

import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AiFunction } from "@dissertator/shared";
import { seedProviders } from "./providers.ts";
import { seedBindings, setBinding } from "./bindings.ts";
import { seedLists } from "./lists.ts";

export const DISS_DIR_NAME = "Dissertator";

/**
 * Default `prompts.md` content, written once into `Dissertator/prompts.md` on
 * first project init. User-editable thereafter. Parsed by `prompts.ts` →
 * `## Category` headings + `- **Label**: prompt` bullets.
 */
export const DEFAULT_PROMPTS_MD = `# Prompts

Quick-fire prompts for the chat. Edit this file freely — changes apply on the
next message. Format: a \`## Category\` heading, then one prompt per line as
\`- **Short label**: the actual prompt text\`.

## Start a new document

- **New document**: I just created a new, empty document. Help me plan its structure. Ask me what kind of manuscript this is (journal article, thesis chapter, literature review, conference paper), my topic, and any structure I already have in mind. Then propose a clear heading outline we can refine before writing.

## Read & synthesize

- **Summarize a source**: Summarize the key arguments of the pinned source in about 200 words.
- **Compare sources**: Compare how the pinned sources treat the same idea. Where do they agree, where do they differ, and whose evidence is stronger?
- **Find the gap**: Based on the pinned sources, what gaps, tensions, or open questions could a new paper address?
- **Trace a concept**: Trace how the concept of [concept] developed across these sources.

## Write

- **Draft a section**: Draft the [section] of my paper using the pinned sources. Use [@citekey] citations and keep it grounded in what the sources actually say.
- **Improve a paragraph**: Rewrite the selected paragraph to be clearer, more concise, and better signposted, without changing the meaning.
- **Suggest an outline**: Suggest a three-level outline for a paper on [topic] grounded in these sources.
- **Sharpen the thesis**: Read my draft and propose three sharper, more arguable versions of the thesis.

## Cite & evidence

- **Find supporting evidence**: Find passages in the sources that support this claim: "[claim]". Quote them with page numbers.
- **Stress-test a claim**: Which sources push back against this claim, and how strongly?
- **Check citations**: Scan my draft's main claims and tell me which ones still need a citation or stronger evidence.
`;

export interface ProjectState {
  projectPath: string;
  dissertatorDir: string;
  dbPath: string;
  db: Database;
  createdAt: string;
  /** sqlite-vec (vec0) loaded? False on this platform without a custom SQLite. */
  vecExtensionOk: boolean;
}

/**
 * The ONE shared connection. `let` + a setter (rather than a local each module
 * could reassign) because ESM imported bindings are read-only — `initProject`
 * in project.ts calls `setCurrentProject` to attach the handle, and every
 * entity module reads `current` (live binding) to reach the same Database.
 */
export let current: ProjectState | null = null;

/** Attach the shared connection. Called once by `initProject` after open. */
export function setCurrentProject(next: ProjectState | null): void {
  current = next;
}

export function readSchema(): Promise<string> {
  // schema.sql lives one level up (src/schema.sql); this module is in src/db/.
  return Bun.file(join(import.meta.dir, "..", "schema.sql")).text();
}

export function count(db: Database, table: string): number {
  const row = db
    .query(`SELECT COUNT(*) AS c FROM ${table}`)
    .get() as { c: number };
  return row.c;
}

/**
 * Columns added to `source_files` after the initial P0 release.
 * `migrate` adds any that are missing on existing project DBs (CREATE TABLE
 * IF NOT EXISTS won't add columns to an already-existing table).
 */
export const SOURCE_FILE_NEW_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "mime_type", type: "TEXT" },
  { name: "page_count", type: "INTEGER" },
  { name: "extracted_path", type: "TEXT" },
  { name: "needs_ocr_reason", type: "TEXT" },
];

/**
 * Columns added to `chunks` in schema v3 (P2): per-chunk embedding lifecycle
 * so `embedPending` knows which chunks still need vectors. Mirrors the
 * SOURCE_FILE_NEW_COLUMNS idempotent-ALTER pattern.
 */
export const CHUNK_NEW_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "embedding_status", type: "TEXT NOT NULL DEFAULT 'pending'" },
];

/**
 * Idempotent migration: add any missing `source_files` + `chunks` columns
 * and stamp `meta.schema_version = '3'`. Safe to run on every `initProject`.
 */
export function migrate(db: Database): void {
  // source_files (P1 columns).
  const sfCols = db
    .prepare("PRAGMA table_info(source_files)")
    .all() as Array<{ name: string }>;
  const sfHave = new Set(sfCols.map((c) => c.name));
  for (const col of SOURCE_FILE_NEW_COLUMNS) {
    if (!sfHave.has(col.name)) {
      try {
        db.exec(
          `ALTER TABLE source_files ADD COLUMN ${col.name} ${col.type}`
        );
      } catch (e) {
        // Race / already added concurrently — ignore.
        console.warn(
          `[db] migrate: could not add column ${col.name}:`,
          (e as Error)?.message
        );
      }
    }
  }

  // source_files.reference_id: the REVERSE link is gone — the canonical
  // direction is references.source_file_id (see docs/citekey.md §5). Best-
  // effort DROP for existing DBs (SQLite < 3.35 lacks DROP COLUMN, so guard
  // it). The column was never written, so leaving it on ancient SQLite is
  // harmless (always NULL, nothing reads it).
  if (sfHave.has("reference_id")) {
    try {
      db.exec("ALTER TABLE source_files DROP COLUMN reference_id");
      console.log(
        "[db] migrate: dropped source_files.reference_id (redundant reverse link)"
      );
    } catch (e) {
      console.warn(
        "[db] migrate: could not drop reference_id (SQLite too old? harmless):",
        (e as Error)?.message
      );
    }
  }

  // chunks (P2 embedding_status).
  const ckCols = db
    .prepare("PRAGMA table_info(chunks)")
    .all() as Array<{ name: string }>;
  const ckHave = new Set(ckCols.map((c) => c.name));
  for (const col of CHUNK_NEW_COLUMNS) {
    if (!ckHave.has(col.name)) {
      try {
        db.exec(`ALTER TABLE chunks ADD COLUMN ${col.name} ${col.type}`);
      } catch (e) {
        console.warn(
          `[db] migrate: could not add column ${col.name}:`,
          (e as Error)?.message
        );
      }
    }
  }
  // documents (P3 → P3.1): the manuscript body moved ONTO the document row.
  // The `sections` subsystem was removed — a Document is ONE body, not a tree
  // of sections. Existing project DBs gain `documents.body_md`; the now-orphan
  // `sections` table is dropped (safe: nothing references it via FK except
  // agent_runs.section_id, which is a free-text column with no constraint).
  const docCols = db
    .prepare("PRAGMA table_info(documents)")
    .all() as Array<{ name: string }>;
  const docHave = new Set(docCols.map((c) => c.name));
  if (!docHave.has("body_md")) {
    try {
      db.exec("ALTER TABLE documents ADD COLUMN body_md TEXT");
    } catch (e) {
      console.warn(
        "[db] migrate: could not add column body_md:",
        (e as Error)?.message
      );
    }
  }
  db.exec("DROP TABLE IF EXISTS sections");

  // Chats (P4): freeform chat threads, scoped by chat_id. On a FRESH db the
  // `chats` + `chat_messages` tables are created by schema.sql (above). On an
  // OLD db that predates the `chats` table, create it here. SQLite makes
  // ALTER TABLE ADD COLUMN ignore the REFERENCES clause, so the FK/cascade is
  // NOT enforced at the DB layer for the new column — deleteChat deletes the
  // chat's messages explicitly in a transaction (we intentionally do NOT rely
  // on `PRAGMA foreign_keys=ON` here because flipping global pragma behavior
  // could surprise other tables; the app-layer cascade is explicit + tested).
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chats'")
    .get() as { name?: string } | null;
  if (!tables?.name) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS chats (" +
        "id TEXT PRIMARY KEY, title TEXT NOT NULL, context_sources TEXT, " +
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    );
  }

  // chat_messages.chat_id column (additive).
  const cmCols = db
    .prepare("PRAGMA table_info(chat_messages)")
    .all() as Array<{ name: string }>;
  const cmHave = new Set(cmCols.map((c) => c.name));
  if (!cmHave.has("chat_id")) {
    try {
      // REFERENCES is ignored by SQLite on ALTER TABLE ADD COLUMN — see the
      // comment above; the cascade is enforced app-side in deleteChat.
      db.exec(
        "ALTER TABLE chat_messages ADD COLUMN chat_id TEXT REFERENCES chats(id) ON DELETE CASCADE"
      );
    } catch (e) {
      console.warn(
        "[db] migrate: could not add column chat_id:",
        (e as Error)?.message
      );
    }
  }

  // Backfill: any pre-existing rows (single-global-chat era) get attached to
  // a deterministic "General" chat so the transcript survives the migration.
  // Uses INSERT ... ON CONFLICT DO NOTHING so re-running migrate is safe.
  const orphanCount = db
    .prepare("SELECT COUNT(*) AS c FROM chat_messages WHERE chat_id IS NULL")
    .get() as { c: number };
  if (orphanCount.c > 0) {
    const GENERAL_CHAT_ID = "00000000-0000-4000-8000-000000000000";
    const now = Date.now();
    db.prepare(
      "INSERT INTO chats(id, title, context_sources, created_at, updated_at) " +
        "VALUES (?, 'General', '[]', ?, ?) " +
        "ON CONFLICT(id) DO NOTHING"
    ).run(GENERAL_CHAT_ID, now, now);
    db.prepare(
      "UPDATE chat_messages SET chat_id = ? WHERE chat_id IS NULL"
    ).run(GENERAL_CHAT_ID);
    console.log(
      `[db] migrate: backfilled ${orphanCount.c} chat_messages to "General" chat`
    );
  }
  // Idempotent schema-version bump (P0 → '2', P2 → '3', P6 → '4').
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', '4') " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();

  // -----------------------------------------------------------------------
  // P6: providers table. Seed two rows from the LEGACY single-provider
  // settings so nothing is lost, and reuse the legacy keychain slots
  // (`openai_api_key`, `openai_embedding_key`, …) as the rows' `key_user` —
  // that way existing keys keep working with ZERO keychain migration. Rows
  // the user adds later get a fresh per-id slot via `providerKeyUser`.
  // Deterministic ids ('default-chat' / 'default-embedding') make this
  // idempotent and keep the chat_provider_id / embedding_provider_id
  // settings stable across re-runs.
  // -----------------------------------------------------------------------
  seedProviders(db);
  // Multi-provider: seed the 5 function bindings, mirroring the legacy
  // chat/embedding provider pointers. Idempotent.
  seedBindings(db);

  // Lists & notes (collect-while-reading). Seeds the 4 built-in lists
  // (system=1) idempotently — `INSERT OR IGNORE` by id so a deliberately
  // emptied row is NOT recreated, but the defaults exist on first run.
  seedLists(db);
}

// ===========================================================================
// Cross-cutting settings/binding bridges.
//
// `readBindingsJoined` and `setChatProviderId` are used by 2+ entity modules
// (bindings + project, providers + project respectively), so by the refactor
// rule they live here rather than in any single entity module. Keeping them
// here also avoids entity↔entity imports (setChatProviderId mirrors into the
// chat binding via setBinding, which lives in bindings.ts).
// ===========================================================================

/** All bindings joined with their provider's apiUrl/type (single query). */
export function readBindingsJoined(): Array<{
  fn: AiFunction;
  providerId: string;
  model: string;
  updatedAt: number;
  apiUrl: string;
  type: string;
}> {
  if (!current) return [];
  const rows = current.db
    .prepare(
      "SELECT b.function AS fn, b.provider_id AS pid, b.model AS model, " +
        "b.updated_at AS ts, p.api_url AS url, p.type AS type " +
        "FROM function_bindings b LEFT JOIN providers p ON p.id = b.provider_id",
    )
    .all() as Array<{
    fn: string;
    pid: string;
    model: string;
    ts: number;
    url: string | null;
    type: string | null;
  }>;
  return rows.map((r) => ({
    fn: r.fn as AiFunction,
    providerId: r.pid,
    model: r.model,
    updatedAt: r.ts,
    apiUrl: r.url ?? "",
    type: r.type ?? "",
  }));
}

/**
 * Set the chat function's provider. Writes the legacy settings pointer AND
 * mirrors it into the chat binding (the single source of truth), so the
 * legacy Functions dropdown and the new binding view stay in sync. Chat is
 * non-destructive, so this never re-vectorizes.
 */
export function setChatProviderId(id: string): void {
  if (!current) return;
  current.db
    .prepare(
      "INSERT INTO settings(key, value) VALUES ('chat_provider_id', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(id);
  // Mirror into the chat binding WITHOUT clobbering an existing model: keep
  // the current binding model if set, else blank (the Functions UI fills it).
  const prev = current.db
    .prepare("SELECT model FROM function_bindings WHERE function = 'chat'")
    .get() as { model?: string } | null;
  setBinding("chat", { providerId: id, model: prev?.model ?? "" });
}
