// Sidecar DB layer — owns the Dissertator SQLite database (bun:sqlite).
//
// One project is active at a time (single-user, local). `initProject` creates
// the visible `Dissertator/` directory, the SQLite db (running schema.sql),
// writes project.toml, and primes default settings. It is idempotent.

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { exists, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import {
  EMBEDDING_DEFAULTS,
  PROVIDER_DEFAULTS,
  providerKeyUser,
  type Author,
  type Chat,
  type ChatMessage,
  type DocType,
  type Document,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type EmbeddingStatus,
  type InitProjectResponse,
  type OcrStrategy,
  type ProjectStatus,
  type Provider,
  type ProviderConfig,
  type ProviderKind,
  type Reference,
  type Settings,
  type SettingsPatch,
  type SourceFile,
  type TextStatus,
} from "@dissertator/shared";
import { generateCitekey } from "./cite/citekey.ts";

const DISS_DIR_NAME = "Dissertator";

/**
 * Default `prompts.md` content, written once into `Dissertator/prompts.md` on
 * first project init. User-editable thereafter. Parsed by `prompts.ts` →
 * `## Category` headings + `- **Label**: prompt` bullets.
 */
const DEFAULT_PROMPTS_MD = `# Prompts

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


interface ProjectState {
  projectPath: string;
  dissertatorDir: string;
  dbPath: string;
  db: Database;
  createdAt: string;
  /** sqlite-vec (vec0) loaded? False on this platform without a custom SQLite. */
  vecExtensionOk: boolean;
}

let current: ProjectState | null = null;

export function getCurrentProject(): ProjectState | null {
  return current;
}

function readSchema(): Promise<string> {
  // Resolved relative to this source file.
  return Bun.file(join(import.meta.dir, "schema.sql")).text();
}

function count(db: Database, table: string): number {
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
const SOURCE_FILE_NEW_COLUMNS: Array<{ name: string; type: string }> = [
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
const CHUNK_NEW_COLUMNS: Array<{ name: string; type: string }> = [
  { name: "embedding_status", type: "TEXT NOT NULL DEFAULT 'pending'" },
];

/**
 * Idempotent migration: add any missing `source_files` + `chunks` columns
 * and stamp `meta.schema_version = '3'`. Safe to run on every `initProject`.
 */
function migrate(db: Database): void {
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
        `[db] migrate: could not add column body_md:`,
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
}

// ===========================================================================
// P6: providers subsystem.
// ===========================================================================

interface ProviderRow {
  id: string;
  name: string;
  kind: string;
  type: string;
  api_url: string;
  model: string;
  key_user: string;
  is_default: number;
  created_at: string;
}

function mapProvider(r: ProviderRow): ProviderConfig {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind as ProviderKind,
    type: r.type as ProviderConfig["type"],
    apiUrl: r.api_url,
    model: r.model,
    keyUser: r.key_user,
    isDefault: !!r.is_default,
    createdAt: r.created_at,
  };
}

/**
 * Seed the providers table on first migration. Reads the LEGACY single-
 * provider settings (provider/apiUrl/model + embedding_*) and creates two
 * rows whose `key_user` reuses the legacy keychain slots, so existing keys
 * survive the upgrade with no keychain migration. Idempotent: a no-op once
 * the table has rows AND the two *_provider_id settings are set.
 */
function seedProviders(db: Database): void {
  const countRow = db.prepare("SELECT COUNT(*) AS c FROM providers").get() as {
    c: number;
  };
  const existing = countRow.c;

  // Read whatever legacy settings exist (may be the seeded defaults).
  const rows = db
    .prepare("SELECT key, value FROM settings")
    .all() as { key: string; value: string }[];
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.key] = r.value;

  if (existing === 0) {
    const now = new Date().toISOString();
    // Chat default — reuses the legacy chat keychain slot verbatim.
    const chatType = (obj.provider as Provider) ?? "openai";
    const chatDef = PROVIDER_DEFAULTS[chatType] ?? PROVIDER_DEFAULTS.openai;
    db.prepare(
      "INSERT INTO providers(id, name, kind, type, api_url, model, key_user, is_default, created_at) " +
        "VALUES (?, ?, 'chat', ?, ?, ?, ?, 1, ?)"
    ).run(
      "default-chat",
      chatDef.label,
      chatType,
      obj.apiUrl ?? chatDef.apiUrl,
      obj.model ?? chatDef.defaultModel,
      chatDef.keyUser,
      now,
    );
    // Embedding default — reuses the legacy embedding keychain slot.
    const embType =
      (obj.embedding_provider as EmbeddingProvider) ?? "openai";
    const embDef = EMBEDDING_DEFAULTS[embType] ?? EMBEDDING_DEFAULTS.openai;
    db.prepare(
      "INSERT INTO providers(id, name, kind, type, api_url, model, key_user, is_default, created_at) " +
        "VALUES (?, ?, 'embedding', ?, ?, ?, ?, 0, ?)"
    ).run(
      "default-embedding",
      embDef.label,
      embType,
      obj.embedding_api_url ?? embDef.apiUrl,
      obj.embedding_model ?? embDef.defaultModel,
      embDef.keyUser,
      now,
    );
    console.log("[db] seedProviders: created default-chat + default-embedding");
  }

  // Point the function-selection settings at the seeded rows (idempotent).
  // Only set if absent, so a user who already picked providers isn't reset.
  const upsertIfAbsent = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING"
  );
  upsertIfAbsent.run("chat_provider_id", "default-chat");
  upsertIfAbsent.run("embedding_provider_id", "default-embedding");
}

/** List all provider rows (chat + embedding), oldest first. */
export function listProviders(): ProviderConfig[] {
  if (!current) return [];
  const rows = current.db
    .prepare("SELECT * FROM providers ORDER BY created_at ASC")
    .all() as ProviderRow[];
  return rows.map(mapProvider);
}

/** One provider row, or null. */
export function getProvider(id: string): ProviderConfig | null {
  if (!current) return null;
  const row = current.db
    .prepare("SELECT * FROM providers WHERE id = ?")
    .get(id) as ProviderRow | null;
  return row ? mapProvider(row) : null;
}

export interface ProviderInput {
  name: string;
  kind: ProviderKind;
  type: ProviderConfig["type"];
  apiUrl?: string;
  model?: string;
  /**
   * Keychain slot. Omit to get a fresh per-id slot via `providerKeyUser`
   * (the right choice for user-added providers). Seeded defaults pass the
   * legacy slot explicitly.
   */
  keyUser?: string;
  isDefault?: boolean;
}

/** Create a provider row. Generates a uuid id + per-id keychain slot. */
export function createProvider(input: ProviderInput): ProviderConfig {
  if (!current) throw new Error("no project initialized");
  const id = randomUUID();
  const def =
    input.kind === "chat"
      ? (PROVIDER_DEFAULTS[input.type as Provider] ?? PROVIDER_DEFAULTS.openai)
      : (EMBEDDING_DEFAULTS[input.type as EmbeddingProvider] ??
        EMBEDDING_DEFAULTS.openai);
  const row: ProviderRow = {
    id,
    name: input.name.trim() || def.label,
    kind: input.kind,
    type: input.type,
    api_url: input.apiUrl ?? def.apiUrl,
    model: input.model ?? def.defaultModel,
    key_user: input.keyUser ?? providerKeyUser(id),
    is_default: 0,
    created_at: new Date().toISOString(),
  };
  current.db
    .prepare(
      "INSERT INTO providers(id, name, kind, type, api_url, model, key_user, is_default, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.name,
      row.kind,
      row.type,
      row.api_url,
      row.model,
      row.key_user,
      row.is_default,
      row.created_at,
    );
  const created = mapProvider(row);
  // Setting isDefault for a chat provider rewrites the chat_provider_id
  // pointer (the single source of truth for "default chat provider").
  if (input.isDefault && input.kind === "chat") {
    setChatProviderId(id);
  }
  return created;
}

/** Patch a provider row (only provided fields change). */
export function updateProvider(
  id: string,
  patch: Partial<Omit<ProviderInput, "keyUser">>,
): ProviderConfig | null {
  if (!current) return null;
  const existing = getProvider(id);
  if (!existing) return null;
  const next: ProviderRow = {
    id: existing.id,
    name: patch.name ?? existing.name,
    kind: patch.kind ?? existing.kind,
    type: patch.type ?? existing.type,
    api_url: patch.apiUrl ?? existing.apiUrl,
    model: patch.model ?? existing.model,
    key_user: existing.keyUser, // never change slot post-create (key would orphan)
    is_default: existing.isDefault ? 1 : 0,
    created_at: existing.createdAt,
  };
  current.db
    .prepare(
      "UPDATE providers SET name=?, kind=?, type=?, api_url=?, model=?, is_default=? WHERE id=?",
    )
    .run(
      next.name,
      next.kind,
      next.type,
      next.api_url,
      next.model,
      next.is_default,
      id,
    );
  if (patch.isDefault && existing.kind === "chat") setChatProviderId(id);
  return mapProvider(next);
}

/** Delete a provider row. Refuses the last chat/embedding provider of a kind. */
export function deleteProvider(id: string): { ok: boolean; error?: string } {
  if (!current) return { ok: false, error: "no project initialized" };
  const existing = getProvider(id);
  if (!existing) return { ok: false, error: "not found" };
  const kindCount = current.db
    .prepare("SELECT COUNT(*) AS c FROM providers WHERE kind = ?")
    .get(existing.kind) as { c: number };
  if (kindCount.c <= 1) {
    return {
      ok: false,
      error: `cannot delete the last ${existing.kind} provider`,
    };
  }
  current.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  // If we deleted the selected chat/embedding provider, fall back to the
  // first remaining of that kind so getSettings never dangles.
  const fallback = current.db
    .prepare(
      "SELECT id FROM providers WHERE kind = ? ORDER BY created_at ASC LIMIT 1",
    )
    .get(existing.kind) as { id: string } | null;
  if (fallback) {
    if (existing.kind === "chat") setChatProviderId(fallback.id);
    else setEmbeddingProviderId(fallback.id);
  }
  return { ok: true };
}

/** Set the chat function's provider (the "default" chat provider). */
export function setChatProviderId(id: string): void {
  if (!current) return;
  current.db
    .prepare(
      "INSERT INTO settings(key, value) VALUES ('chat_provider_id', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(id);
}

/** Set the vectorizer function's provider. */
export function setEmbeddingProviderId(id: string): void {
  if (!current) return;
  current.db
    .prepare(
      "INSERT INTO settings(key, value) VALUES ('embedding_provider_id', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(id);
}

// ===========================================================================
// Working-docs persistence (UI tabs).
// ===========================================================================

export interface UiTab {
  sourceId: string;
  kind: string;
  title: string;
}

export function getUiTabs(): { tabs: UiTab[]; activeTabId: string | null } {
  if (!current) return { tabs: [], activeTabId: null };
  const tabsRaw = current.db
    .prepare("SELECT value FROM settings WHERE key = 'ui_open_tabs'")
    .get() as { value?: string } | null;
  const activeRaw = current.db
    .prepare("SELECT value FROM settings WHERE key = 'ui_active_tab'")
    .get() as { value?: string } | null;
  let tabs: UiTab[] = [];
  if (tabsRaw?.value) {
    try {
      const parsed = JSON.parse(tabsRaw.value);
      if (Array.isArray(parsed)) {
        tabs = parsed.filter(
          (t): t is UiTab =>
            t &&
            typeof t.sourceId === "string" &&
            typeof t.kind === "string" &&
            typeof t.title === "string",
        );
      }
    } catch {
      /* corrupt — treat as empty */
    }
  }
  const activeTabId = activeRaw?.value ?? null;
  return { tabs, activeTabId };
}

export function setUiTabs(tabs: UiTab[], activeTabId: string | null): void {
  if (!current) return;
  const upsert = current.db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  upsert.run("ui_open_tabs", JSON.stringify(tabs));
  upsert.run("ui_active_tab", activeTabId ?? "");
}

export async function initProject(
  projectPath: string
): Promise<InitProjectResponse> {
  // Prevent self-digest: refuse to open a path that is ITSELF a Dissertator
  // data dir. A project root (e.g. ~/research) never has a top-level
  // `project.toml` + `dissertator.db`; only a data dir does. If the user
  // picks `<root>/Dissertator` instead of `<root>`, the watcher would index
  // the app's own files (project.toml, dissertator.db, cache/*.txt) as
  // research sources — the exact bug that produced 321 garbage chunks and
  // broke search (the self-ingested DB is never embedded). Reject early with
  // an actionable message so the UI can tell the user to pick the parent.
  const rootToml = join(projectPath, "project.toml");
  const rootDb = join(projectPath, "dissertator.db");
  if ((await exists(rootToml)) && (await exists(rootDb))) {
    throw new Error(
      "That folder is a Dissertator data directory, not a project root. " +
        "Open its parent folder (the one that contains your source PDFs)."
    );
  }

  const dissertatorDir = join(projectPath, DISS_DIR_NAME);
  await mkdir(join(dissertatorDir, "cache"), { recursive: true });
  await mkdir(join(dissertatorDir, "documents"), { recursive: true });
  await mkdir(join(dissertatorDir, "exports"), { recursive: true });
  await mkdir(join(dissertatorDir, "logs"), { recursive: true });

  const dbPath = join(dissertatorDir, "dissertator.db");
  const alreadyExisted = await exists(dbPath);

  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(await readSchema());
  migrate(db);

  // Load sqlite-vec (vec0 virtual table) so embeddings can be stored and
  // searched as dense vectors. Linux/Windows load out of the box; macOS needs
  // `Database.setCustomSQLite(<vanilla libsqlite3.dylib>)` BEFORE the first
  // `new Database()` (Apple's build disables extensions). A load failure is
  // logged but does NOT block project init — extraction, OCR, chunking, and
  // chat all keep working; only embeddings are disabled, and `lockDimensions`
  // will throw a clear error if invoked without the extension.
  let vecExtensionOk = false;
  try {
    db.loadExtension(getLoadablePath());
    vecExtensionOk = true;
  } catch (e) {
    console.error(
      "[db] sqlite-vec extension failed to load (embeddings disabled):",
      (e as Error)?.message ?? String(e)
    );
  }

  // Prime default settings (idempotent).
  const seed = db.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)"
  );
  const d = PROVIDER_DEFAULTS.openai;
  seed.run("provider", "openai");
  seed.run("apiUrl", d.apiUrl);
  seed.run("model", d.defaultModel);
  // Embedding config (P2) — DECOUPLED from the chat provider above. Defaults
  // to OpenAI text-embedding-3-small regardless of the chat backend.
  const ed = EMBEDDING_DEFAULTS.openai;
  seed.run("embedding_provider", "openai");
  seed.run("embedding_api_url", ed.apiUrl);
  seed.run("embedding_model", ed.defaultModel);
  seed.run("embedding_dimensions", "0"); // 0 = not yet locked

  // created_at: reuse if present, else stamp now.
  const metaRow = db
    .query("SELECT value FROM meta WHERE key = 'created_at'")
    .get() as { value?: string } | null;
  const createdAt = metaRow?.value ?? new Date().toISOString();
  if (!metaRow?.value) {
    db.prepare("INSERT INTO meta(key, value) VALUES ('created_at', ?)").run(
      createdAt
    );
  }
  // `schema_version` is owned by migrate() (idempotent upsert to '2').

  // Contact email for Crossref's polite pool (P2 Track 3). Defaults to "";
  // when set it is sent in the Crossref `User-Agent` so requests route
  // through the faster shared-rate-limit pool. NOT a keychain slot — it's a
  // public contact address stored in the project DB.
  seed.run("contactEmail", "");

  // project.toml — written once, not overwritten on reopen.
  const tomlPath = join(dissertatorDir, "project.toml");
  if (!(await exists(tomlPath))) {
    const toml = [
      "# Dissertator project — visible marker that this folder is a workspace.",
      `[project]`,
      `version = 1`,
      `created_at = "${createdAt}"`,
      ``,
      `# Embedding model is locked on first embedding run (P2).`,
      `[embedding]`,
      `model_id = ""`,
      ``,
      `[provider]`,
      `default = "openai"`,
      ``,
    ].join("\n");
    await writeFile(tomlPath, toml, "utf8");
  }

  // prompts.md — written once, not overwritten on reopen. The user can edit
  // this freely; `GET /prompts` re-parses it each call. Provides sensible
  // defaults (new-document planner + reading/writing/citation helpers) so the
  // quick-pick menu is populated out of the box.
  const promptsPath = join(dissertatorDir, "prompts.md");
  if (!(await exists(promptsPath))) {
    await writeFile(promptsPath, DEFAULT_PROMPTS_MD, "utf8");
  }

  current = { projectPath, dissertatorDir, dbPath, db, createdAt, vecExtensionOk };

  return {
    projectPath,
    dissertatorDir,
    dbPath,
    createdAt,
    created: !alreadyExisted,
  };
}

export function getProjectStatus(): ProjectStatus {
  if (!current) {
    return {
      initialized: false,
      projectPath: null,
      dissertatorDir: null,
      createdAt: null,
      counts: { sourceFiles: 0, documents: 0, references: 0 },
    };
  }
  const { db, projectPath, dissertatorDir, createdAt } = current;
  return {
    initialized: true,
    projectPath,
    dissertatorDir,
    createdAt,
    counts: {
      sourceFiles: count(db, "source_files"),
      documents: count(db, "documents"),
      references: count(db, '"references"'),
    },
  };
}

/** Default embedding config block (provider=openai, dimensions unlocked). */
function defaultEmbedding(): EmbeddingConfig {
  const d = EMBEDDING_DEFAULTS.openai;
  return {
    provider: "openai",
    apiUrl: d.apiUrl,
    model: d.defaultModel,
    dimensions: 0, // 0 = not yet locked (locked on first successful embed)
  };
}

/**
 * Build the decoupled `EmbeddingConfig` block from the settings key/value
 * rows. Falls back to defaults for any missing key. `embedding_dimensions`
 * is 0 until `lockDimensions` stamps it on the first successful embed.
 *
 * NOTE (P6): the primary path now resolves from the providers table inside
 * `getSettings`; this helper is retained only as the legacy fallback there.
 */
function embeddingFromSettings(
  obj: Record<string, string>
): EmbeddingConfig {
  const provider = (obj.embedding_provider as EmbeddingConfig["provider"]) ?? "openai";
  const d = EMBEDDING_DEFAULTS[provider] ?? EMBEDDING_DEFAULTS.openai;
  const dimensionsRaw = obj.embedding_dimensions;
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : 0;
  return {
    provider,
    apiUrl: obj.embedding_api_url ?? d.apiUrl,
    model: obj.embedding_model ?? d.defaultModel,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 0,
  };
}

export function getSettings(): Settings {
  if (!current) {
    return {
      provider: "openai",
      apiUrl: PROVIDER_DEFAULTS.openai.apiUrl,
      model: PROVIDER_DEFAULTS.openai.defaultModel,
      ocrStrategy: "tesseract",
      embedding: defaultEmbedding(),
      contactEmail: "",
    };
  }
  const rows = current.db
    .query("SELECT key, value FROM settings")
    .all() as { key: string; value: string }[];
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.key] = r.value;

  // --- Resolve chat function from its provider row (P6) -----------------
  // provider/apiUrl/model are now DERIVED from the chat-kind provider row
  // pointed at by chat_provider_id. Falls back to legacy settings keys, then
  // openai defaults, only if the row is missing (shouldn't happen post-
  // migrate). This keeps every existing consumer (resolveChatConfig, the
  // /chat endpoint, OCR vision) working unchanged.
  const chatProviderId = obj.chat_provider_id || "default-chat";
  const chatProv = getProvider(chatProviderId);
  const provider = (chatProv?.type as Settings["provider"]) ??
    (obj.provider as Settings["provider"]) ??
    "openai";
  const chatDef = PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.openai;
  const apiUrl = chatProv?.apiUrl || obj.apiUrl || chatDef.apiUrl;
  const model = chatProv?.model || obj.model || chatDef.defaultModel;

  // --- Resolve vectorizer function from its provider row ----------------
  const embeddingProviderId = obj.embedding_provider_id || "default-embedding";
  const embProv = getProvider(embeddingProviderId);
  const embProvider = (embProv?.type as EmbeddingConfig["provider"]) ??
    (obj.embedding_provider as EmbeddingConfig["provider"]) ??
    "openai";
  const embDef = EMBEDDING_DEFAULTS[embProvider] ?? EMBEDDING_DEFAULTS.openai;
  const dimensionsRaw = obj.embedding_dimensions;
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : 0;
  const embedding: EmbeddingConfig = {
    provider: embProvider,
    apiUrl: embProv?.apiUrl || obj.embedding_api_url || embDef.apiUrl,
    model: embProv?.model || obj.embedding_model || embDef.defaultModel,
    dimensions: Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 0,
  };

  return {
    provider,
    apiUrl,
    model,
    ocrStrategy: (obj.ocrStrategy as Settings["ocrStrategy"]) ?? "tesseract",
    embedding,
    contactEmail: obj.contactEmail ?? "",
    chatProviderId,
    embeddingProviderId,
  };
}

/** {@link saveSettings} accepts this focused patch (re-exported from shared). */
export type { SettingsPatch };

export function saveSettings(patch: SettingsPatch): Settings {
  if (!current) throw new Error("no project initialized");
  const upsert = current.db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  if (patch.ocrStrategy !== undefined) upsert.run("ocrStrategy", patch.ocrStrategy);
  // Crossref polite-pool contact email. Not a keychain slot — a public
  // contact address stored in the project DB.
  if (patch.contactEmail !== undefined) {
    upsert.run("contactEmail", patch.contactEmail);
  }
  // Function selections → pointers into the providers table.
  if (patch.chatProviderId !== undefined) setChatProviderId(patch.chatProviderId);
  if (patch.embeddingProviderId !== undefined) {
    setEmbeddingProviderId(patch.embeddingProviderId);
  }
  // Embedding dimension lock. Normally stamped by `lockDimensions` on the
  // first successful embed; surfaced here so the UI can reset it when the
  // user switches embedding provider (forces a fresh lock). Saving 0 does
  // NOT drop an existing vec0 table (that lives in meta).
  if (patch.embeddingDimensions !== undefined) {
    upsert.run("embedding_dimensions", String(patch.embeddingDimensions));
  }
  return getSettings();
}

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

// ---------------------------------------------------------------------------
// Embeddings (P2 Track 1): dimension lock + status counts.
// ---------------------------------------------------------------------------

/**
 * Lock the embedding vector dimensionality on the first successful embed.
 *
 * sqlite-vec `vec0` virtual tables require the dimension N at CREATE time,
 * but N is unknown until a model actually returns a vector. So the table is
 * created LAZILY here: the first call with a given N creates
 * `embeddings USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[N])` and
 * stamps the lock into `meta` (`embedding_dimensions` + `embedding_model_id`)
 * — mirrored into `settings.embedding_dimensions` so `getSettings` reflects
 * it. Subsequent calls with the same N are a no-op; a DIFFERENT N throws
 * (switching models requires a full re-embed, deferred to P6 — we never
 * auto-reembed). Requires the sqlite-vec extension to be loaded.
 *
 * `dimensions` is validated to a positive integer, so interpolating it into
 * the DDL is safe (digits only — no injection surface).
 */
export function lockDimensions(dimensions: number, modelId: string): void {
  if (!current) throw new Error("no project initialized");
  if (!current.vecExtensionOk) {
    throw new Error(
      "sqlite-vec extension not loaded; embeddings disabled on this platform"
    );
  }
  if (!Number.isInteger(dimensions) || dimensions <= 0) {
    throw new Error(`lockDimensions: invalid dimensions ${dimensions}`);
  }
  const db = current.db;

  // The lock is the `embedding_dimensions` value (0 / absent = unlocked).
  const cur = db
    .query("SELECT value FROM settings WHERE key = 'embedding_dimensions'")
    .get() as { value?: string } | null;
  const curDim = cur?.value ? parseInt(cur.value, 10) : 0;

  if (Number.isFinite(curDim) && curDim > 0) {
    if (curDim !== dimensions) {
      throw new Error(
        `embedding dimension mismatch: locked ${curDim}, got ${dimensions}; switch model requires re-embed (P6)`
      );
    }
    return; // already locked at exactly this dimension
  }

  // First lock: create the vec0 virtual table with the concrete dimension.
  // `distance_metric=cosine` (sqlite-vec 0.1.9) so KNN returns cosine distance
  // — the natural metric for semantic embeddings, independent of vector
  // magnitude. With cosine, `score = clamp(1 - distance, 0, 1)` in search.ts
  // yields true cosine similarity (1=identical, 0=orthogonal).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(chunk_id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}] distance_metric=cosine)`
  );

  // Authoritative lock in meta (+ model id for project.toml display).
  const upsertMeta = db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsertMeta.run("embedding_dimensions", String(dimensions));
  upsertMeta.run("embedding_model_id", modelId ?? "");

  // Mirror into settings so getSettings().embedding.dimensions reflects lock.
  const upsertSet = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsertSet.run("embedding_dimensions", String(dimensions));
}

/** Embedding lifecycle counts + lock info, surfaced at `GET /embed/status`. */
/** Embedding lifecycle counts + lock info, surfaced at `GET /embed/status`. */
export function getEmbeddingStatus(): EmbeddingStatus {
  if (!current) {
    return {
      pending: 0,
      done: 0,
      failed: 0,
      embedding: 0,
      total: 0,
      dimensions: 0,
      model: "",
      vecLoaded: false,
    };
  }
  const rows = current.db
    .query(
      "SELECT embedding_status AS s, COUNT(*) AS c FROM chunks GROUP BY embedding_status"
    )
    .all() as { s: string; c: number }[];
  let pending = 0;
  let done = 0;
  let failed = 0;
  let embedding = 0;
  let total = 0;
  for (const r of rows) {
    total += r.c;
    if (r.s === "pending") pending += r.c;
    else if (r.s === "done") done += r.c;
    else if (r.s === "failed") failed += r.c;
    else if (r.s === "embedding") embedding += r.c;
  }
  const s = getSettings();
  return {
    pending,
    done,
    failed,
    embedding,
    total,
    dimensions: s.embedding.dimensions,
    model: s.embedding.model,
    vecLoaded: current.vecExtensionOk,
  };
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

// ---------------------------------------------------------------------------
// References (P2 Track 3): CRUD + citekey assignment.
//
// The `references` table is the citation index. A citekey is FROZEN after
// first assignment (DESIGN.md §8 decision #9): `upsertReference` regenerates
// it ONLY when an incoming reference has none, and never overwrites an
// existing one. Collisions (`smith2020` twice) are resolved by appending
// `-2`, `-3`, ... at insert time — the DB UNIQUE constraint is authoritative.
// No LEFT JOIN to `source_files` is needed: the only FK is `source_file_id`,
// filtered directly when requested.
// ---------------------------------------------------------------------------

/**
 * Snake_case shape of a `references` row as returned by `bun:sqlite`.
 * `authors` and `csl_json` are JSON strings at this layer; parsed back to
 * objects by {@link mapReference}.
 */
export interface ReferenceRow {
  id: string;
  citekey: string;
  title: string | null;
  authors: string | null; // JSON "[{family,given}]"
  year: number | null;
  doi: string | null;
  type: string | null;
  venue: string | null;
  csl_json: string | null; // JSON CSL record
  source_file_id: string | null;
}

/** Options for {@link listReferences} (currently just source filtering). */
export interface ListReferencesOptions {
  sourceFileId?: string;
}

/** Max collision-resolution attempts before `upsertReference` gives up. */
const CITEKEY_MAX_ATTEMPTS = 20;

/**
 * Test whether `citekey` is already taken by a DIFFERENT reference id.
 * Used by the collision loop in {@link upsertReference}; the row's own id is
 * excluded so updating a reference in place never looks like a self-collision.
 */
function citekeyTaken(citekey: string, exceptId: string): boolean {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare(
      'SELECT id FROM "references" WHERE citekey = ? AND id != ?'
    )
    .get(citekey, exceptId) as { id?: string } | null;
  return !!row;
}

/**
 * Pick a free citekey by appending `-2`, `-3`, ... on collision.
 *
 * Starts from `base` (already generated / caller-supplied). If `base` is free
 * (excluding `exceptId`), returns it as-is. Otherwise appends `-N` for
 * N=2..CITEKEY_MAX_ATTEMPTS until a free slot is found. Throws
 * `Error("citekey collision: ...")` if all attempts are taken — extremely
 * unlikely in practice (would need 20 near-identical refs).
 */
function resolveCitekey(
  base: string,
  exceptId: string
): string {
  if (!base) {
  // An empty base can't be used as a citekey (DB NOT NULL). Fall back to a
  // synthetic `ref-<uuid-prefix>` so insertion still succeeds.
    base = `ref-${exceptId.slice(0, 8)}`;
  }
  if (!citekeyTaken(base, exceptId)) return base;
  for (let n = 2; n <= CITEKEY_MAX_ATTEMPTS; n++) {
    const candidate = `${base}-${n}`;
    if (!citekeyTaken(candidate, exceptId)) return candidate;
  }
  throw new Error(
    `citekey collision: could not find a free slot for "${base}" after ${CITEKEY_MAX_ATTEMPTS} attempts`
  );
}

/**
 * Map a snake_case `references` DB row to the {@link Reference} contract.
 * `authors` and `csl_json` are JSON-parsed back to objects (empty array / null
 * on parse failure — never throws).
 */
export function mapReference(row: ReferenceRow): Reference {
  let authors: Author[] = [];
  if (row.authors) {
    try {
      const parsed = JSON.parse(row.authors) as unknown;
      if (Array.isArray(parsed)) authors = parsed as Author[];
    } catch {
      authors = [];
    }
  }
  let csl: Record<string, unknown> | null = null;
  if (row.csl_json) {
    try {
      const parsed = JSON.parse(row.csl_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        csl = parsed as Record<string, unknown>;
      }
    } catch {
      csl = null;
    }
  }
  return {
    id: row.id,
    citekey: row.citekey,
    title: row.title,
    authors,
    year: row.year,
    doi: row.doi,
    type: row.type,
    venue: row.venue,
    csl_json: csl,
    source_file_id: row.source_file_id,
  };
}

/**
 * INSERT or UPDATE a reference by `id`.
 *
 * If `ref.id` is present and an existing row matches, the row is UPDATED
 * field-by-field (missing fields preserve their DB value); otherwise a new
 * row is INSERTed with a fresh `crypto.randomUUID()`. Citekey handling:
 *   - If `ref.citekey` is supplied, it is used (and de-collided if taken).
 *   - Else if updating an existing row, the existing citekey is preserved
 *     (FROZEN — DESIGN.md §8 decision #9; tokens in docs never break).
 *   - Else (new row, no citekey), one is generated from the first author's
 *     family + year (falling back to the title), then de-collided.
 *
 * `authors` and `csl_json` are JSON-serialized for storage. Throws on citekey
 * collision exhaustion or if no project is initialized. Returns the full
 * post-write {@link Reference}.
 */
export function upsertReference(ref: Partial<Reference>): Reference {
  if (!current) throw new Error("no project initialized");
  const db = current.db;

  // Resolve the target id: keep the supplied id, else mint a fresh UUID.
  const id = ref.id ?? randomUUID();

  // Does a row already exist for this id? If so we're updating — and must
  // preserve its citekey unless the caller explicitly passed a new one.
  const existing = db
    .prepare('SELECT * FROM "references" WHERE id = ?')
    .get(id) as ReferenceRow | null;

  let citekey: string;
  if (existing) {
    // FROZEN (DESIGN §11 decision #9): once assigned, the citekey NEVER
    // changes — citations in manuscripts would otherwise dangle. Any
    // `ref.citekey` on an update is silently ignored. Caller-supplied
    // citekeys are honored only on the FIRST insert (the branches below).
    citekey = existing.citekey;
  } else if (ref.citekey && ref.citekey.trim()) {
    // New row, caller supplied a citekey → honor it (collision-resolved).
    citekey = resolveCitekey(ref.citekey.trim(), id);
  } else {
    // New row, no citekey supplied — generate from author/year/title.
    const firstAuthor = ref.authors?.[0];
    citekey = resolveCitekey(
      generateCitekey({
        family: firstAuthor?.family,
        year: ref.year,
        title: ref.title,
      }),
      id
    );
  }

  // Merge authors: caller fields win (even `[]` = explicit clear), else parse
  // the existing row's JSON column, else []. Written as explicit if/else —
  // a `??`-and-ternary one-liner here was a precedence bug that discarded
  // caller-supplied authors on new rows (it read `existing?.authors`, which
  // is null for a fresh insert, falling back to "[]").
  let authors: Author[];
  if (ref.authors !== undefined) {
    authors = ref.authors;
  } else if (existing?.authors) {
    authors = JSON.parse(existing.authors) as Author[];
  } else {
    authors = [];
  }
  const csl = ref.csl_json ??
    (existing?.csl_json
      ? (JSON.parse(existing.csl_json as string) as Record<string, unknown>)
      : null);

  const row: ReferenceRow = {
    id,
    citekey,
    title: ref.title ?? existing?.title ?? null,
    authors: JSON.stringify(authors),
    year: ref.year ?? existing?.year ?? null,
    doi: ref.doi ?? existing?.doi ?? null,
    type: ref.type ?? existing?.type ?? null,
    venue: ref.venue ?? existing?.venue ?? null,
    csl_json: csl ? JSON.stringify(csl) : null,
    source_file_id: ref.source_file_id ?? existing?.source_file_id ?? null,
  };

  db.prepare(
    'INSERT INTO "references" ' +
      "(id, citekey, title, authors, year, doi, type, venue, csl_json, source_file_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      'ON CONFLICT(id) DO UPDATE SET ' +
      "citekey = excluded.citekey, " +
      "title = excluded.title, " +
      "authors = excluded.authors, " +
      "year = excluded.year, " +
      "doi = excluded.doi, " +
      "type = excluded.type, " +
      "venue = excluded.venue, " +
      "csl_json = excluded.csl_json, " +
      "source_file_id = excluded.source_file_id"
  ).run(
    row.id,
    row.citekey,
    row.title,
    row.authors,
    row.year,
    row.doi,
    row.type,
    row.venue,
    row.csl_json,
    row.source_file_id
  );

  return mapReference(row);
}

/** Fetch a single reference by id, or null if not found. */
export function getReferenceById(id: string): Reference | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare('SELECT * FROM "references" WHERE id = ?')
    .get(id) as ReferenceRow | null;
  return row ? mapReference(row) : null;
}

/** Fetch a single reference by citekey, or null if not found. */
export function getReferenceByCitekey(citekey: string): Reference | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare('SELECT * FROM "references" WHERE citekey = ?')
    .get(citekey) as ReferenceRow | null;
  return row ? mapReference(row) : null;
}

/**
 * List references, optionally filtered by `source_file_id`. Ordered by
 * `citekey` asc for a stable, predictable listing. Parses the JSON columns
 * back to objects via {@link mapReference}.
 */
export function listReferences(
  opts: ListReferencesOptions = {}
): Reference[] {
  if (!current) throw new Error("no project initialized");
  const sql = opts.sourceFileId
    ? 'SELECT * FROM "references" WHERE source_file_id = ? ORDER BY citekey ASC'
    : 'SELECT * FROM "references" ORDER BY citekey ASC';
  const rows = opts.sourceFileId
    ? (current.db.prepare(sql).all(opts.sourceFileId) as ReferenceRow[])
    : (current.db.prepare(sql).all() as ReferenceRow[]);
  return rows.map(mapReference);
}

/**
 * Link a reference to a source file (set `source_file_id`). Used by the
 * ingestion pipeline when a source resolves to a known reference. Throws if
 * the reference id does not exist.
 */
export function linkReferenceToSource(
  refId: string,
  sourceFileId: string | null
): void {
  if (!current) throw new Error("no project initialized");
  const res = current.db
    .prepare(
      'UPDATE "references" SET source_file_id = ? WHERE id = ?'
    )
    .run(sourceFileId, refId);
  if (res.changes === 0) {
    throw new Error(`linkReferenceToSource: reference ${refId} not found`);
  }
}

// ---------------------------------------------------------------------------
// Documents (editor) (P3): manuscript CRUD.
//
// A Document is ONE body, not a tree of sections. The `body_md` column holds
// the entire manuscript body as a single markdown blob — markdown headers
// (`## intro`) are just lines in the body, not separate rows. "Stats"
// (line count, header positions) are computed by the frontend by parsing
// `body_md`; nothing structural is stored beyond the body itself. Snake↔camel
// mapping mirrors the references layer: `mapDocument` parses JSON columns
// defensively (never throws). `research_questions` is a JSON string[].
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Chat (P3 → P4): freeform chat threads, scoped by chat_id.
//
// A chat is a persisted thread (NOT bound to any document). The user picks
// which source files are in scope per chat (stored on the chat row for UI
// persistence). Messages belong to a chat via `chat_messages.chat_id`. The
// agent loop replays only that chat's recent turns (see POST /chat). The
// legacy single-global-chat DBs are migrated forward to a deterministic
// "General" chat by migrate(). Open-files context (`buildOpenFilesContext`)
// is unchanged — plain full-text injection from `chunks`.
// ---------------------------------------------------------------------------

/**
 * Snake_case shape of a `chats` row as returned by `bun:sqlite`.
 * `context_sources` is a JSON string[] at this layer; parsed by
 * {@link mapChat} (empty array on null/parse-failure — never throws).
 */
export interface ChatRow {
  id: string;
  title: string;
  context_sources: string | null; // JSON "[\"...\"]"
  created_at: number;
  updated_at: number;
}

/**
 * Map a snake_case `chats` DB row to the {@link Chat} contract.
 * `context_sources` is JSON-parsed back to a string[] (empty array on null or
 * parse failure — never throws, mirroring {@link mapReference}).
 */
export function mapChat(row: ChatRow): Chat {
  let contextSources: string[] = [];
  if (row.context_sources) {
    try {
      const parsed = JSON.parse(row.context_sources) as unknown;
      if (Array.isArray(parsed)) contextSources = parsed as string[];
    } catch {
      contextSources = [];
    }
  }
  return {
    id: row.id,
    title: row.title,
    contextSources,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * List all chats, most-recently-touched first (`updated_at` DESC). Mirrors
 * {@link listDocuments} ordering intent, but keyed on `updated_at` so the
 * chat the user just used floats to the top of the sidebar.
 */
export function listChats(): Chat[] {
  if (!current) throw new Error("no project initialized");
  const rows = current.db
    .prepare("SELECT * FROM chats ORDER BY updated_at DESC, id ASC")
    .all() as ChatRow[];
  return rows.map(mapChat);
}

/**
 * INSERT a new chat. Default title "New chat", default contextSources `[]`.
 * Sets created_at=updated_at=Date.now(). Returns the created {@link Chat}.
 */
export function createChat(input: {
  title?: string;
  contextSources?: string[];
}): Chat {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    "INSERT INTO chats(id, title, context_sources, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?)"
  ).run(
    id,
    input.title ?? "New chat",
    JSON.stringify(input.contextSources ?? []),
    now,
    now
  );
  return mapChat(db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow);
}

/** Fetch a single chat by id, or null if not found. */
export function getChat(id: string): Chat | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare("SELECT * FROM chats WHERE id = ?")
    .get(id) as ChatRow | null;
  return row ? mapChat(row) : null;
}

/**
 * Partial-patch a chat by id. Omitted fields keep their DB value (`!==
 * undefined` discipline — mirrors {@link updateDocument}). ANY update (even an
 * empty patch) stamps `updated_at = Date.now()`, which is how POST /chat
 * touches a chat's recency. Returns null if the chat id is unknown (404-style).
 */
export function updateChat(
  id: string,
  patch: { title?: string; contextSources?: string[] }
): Chat | null {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const existing = db.prepare("SELECT * FROM chats WHERE id = ?").get(
    id
  ) as ChatRow | null;
  if (!existing) return null;
  const title = patch.title ?? existing.title;
  const contextSources =
    patch.contextSources !== undefined
      ? JSON.stringify(patch.contextSources)
      : existing.context_sources;
  // Always bump updated_at — even when the patch is empty (a touch).
  db.prepare(
    "UPDATE chats SET title = ?, context_sources = ?, updated_at = ? WHERE id = ?"
  ).run(title, contextSources, Date.now(), id);
  return mapChat(db.prepare("SELECT * FROM chats WHERE id = ?").get(id) as ChatRow);
}

/**
 * Delete a chat by id. In a transaction: delete the chat's `chat_messages`
 * rows, then the chat row. This app-side cascade is intentional — the
 * `chat_id` column is added via ALTER TABLE on old DBs, and SQLite ignores
 * REFERENCES on ALTER, so we cannot rely on `ON DELETE CASCADE` at the DB
 * layer. Returns true if a chat row was deleted, false if the id was unknown.
 */
export function deleteChat(id: string): boolean {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM chat_messages WHERE chat_id = ?").run(id);
    const res = db.prepare("DELETE FROM chats WHERE id = ?").run(id);
    db.exec("COMMIT");
    return res.changes > 0;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

interface ChatMessageRow {
  chat_id: string | null;
  id: string;
  role: string;
  content: string | null;
  open_files: string | null;
  cost_tokens: number | null;
  created_at: number;
}

function mapChatMessage(row: ChatMessageRow): ChatMessage {
  let openFiles: string[] = [];
  try {
    const parsed = row.open_files ? JSON.parse(row.open_files) : null;
    if (Array.isArray(parsed)) openFiles = parsed as string[];
  } catch {
    /* malformed JSON → empty */
  }
  return {
    id: row.id,
    chatId: row.chat_id!,
    role: row.role as ChatMessage["role"],
    content: row.content,
    openFiles,
    costTokens: row.cost_tokens,
    createdAt: row.created_at,
  };
}

/**
 * Insert a chat message scoped to a chat (`chat_id` REQUIRED). `costTokens`
 * is optional (assistant turns); only `.completion` is persisted to the
 * INTEGER column (mirrors the original single-number behavior). Mirrors
 * {@link createDocument}'s insert-then-return-row shape.
 */
export function insertChatMessage(msg: {
  chatId: string;
  role: ChatMessage["role"];
  content: string | null;
  openFiles?: string[];
  costTokens?: { prompt: number; completion: number } | null;
}): ChatMessage {
  if (!current) throw new Error("no project initialized");
  const id = randomUUID();
  const createdAt = Date.now();
  const costTokens = msg.costTokens ? msg.costTokens.completion : null;
  current.db
    .prepare(
      "INSERT INTO chat_messages(chat_id, id, role, content, open_files, cost_tokens, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .run(
      msg.chatId,
      id,
      msg.role,
      msg.content,
      JSON.stringify(msg.openFiles ?? []),
      costTokens,
      createdAt
    );
  return {
    id,
    chatId: msg.chatId,
    role: msg.role,
    content: msg.content,
    openFiles: msg.openFiles ?? [],
    costTokens,
    createdAt,
  };
}

/**
 * Recent chat messages for ONE chat, oldest-first (insertion order — the
 * transcript replay order). Uses the implicit `rowid` (monotonically
 * increasing with insertion) rather than `created_at`, which collides for
 * rapid turns inserted within the same ms. Scoped by `chat_id`.
 */
export function listChatMessages(chatId: string, limit = 50): ChatMessage[] {
  if (!current) throw new Error("no project initialized");
  const rows = current.db
    .prepare(
      "SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY rowid DESC LIMIT ?"
    )
    .all(chatId, limit) as ChatMessageRow[];
  return rows.reverse().map(mapChatMessage);
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
