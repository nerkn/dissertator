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
  type Author,
  type EmbeddingConfig,
  type InitProjectResponse,
  type ProjectStatus,
  type Reference,
  type Settings,
  type SourceFile,
  type TextStatus,
} from "@dissertator/shared";
import { generateCitekey } from "./cite/citekey.ts";

const DISS_DIR_NAME = "Dissertator";

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
  // Idempotent schema-version bump (P0 → '2', P2 → '3').
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', '3') " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run();
}

export async function initProject(
  projectPath: string
): Promise<InitProjectResponse> {
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
  return {
    provider: (obj.provider as Settings["provider"]) ?? "openai",
    apiUrl: obj.apiUrl ?? "",
    model: obj.model ?? "",
    ocrStrategy: (obj.ocrStrategy as Settings["ocrStrategy"]) ?? "tesseract",
    embedding: embeddingFromSettings(obj),
    contactEmail: obj.contactEmail ?? "",
  };
}

export function saveSettings(s: Settings): Settings {
  if (!current) throw new Error("no project initialized");
  const upsert = current.db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  upsert.run("provider", s.provider);
  upsert.run("apiUrl", s.apiUrl);
  upsert.run("model", s.model);
  upsert.run("ocrStrategy", s.ocrStrategy);
  // Crossref polite-pool contact email (P2 Track 3). Not a keychain slot —
  // a public contact address stored in the project DB.
  upsert.run("contactEmail", s.contactEmail ?? "");
  // Embedding block is DECOUPLED from chat — its own keys. `dimensions` is
  // round-tripped here too, but it is normally stamped by `lockDimensions`
  // (0 = not yet locked). Saving 0 does NOT unlock an existing vec0 table
  // (that lives in meta); it only reflects the configured/expected value.
  upsert.run("embedding_provider", s.embedding.provider);
  upsert.run("embedding_api_url", s.embedding.apiUrl);
  upsert.run("embedding_model", s.embedding.model);
  upsert.run("embedding_dimensions", String(s.embedding.dimensions ?? 0));
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
export interface EmbeddingStatus {
  pending: number;
  done: number;
  failed: number;
  /** Chunks mid-flight (`embedding_status='embedding'`). */
  embedding: number;
  total: number;
  /** Locked dimensionality (0 = not yet locked / vec0 table not created). */
  dimensions: number;
  /** Configured embedding model id. */
  model: string;
  /** sqlite-vec extension loaded? False → embeddings disabled. */
  vecLoaded: boolean;
}

/**
 * Aggregate per-chunk embedding status counts + the current lock. Safe to
 * call before the vec0 table exists (counts come from `chunks`, not from
 * `embeddings`).
 */
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
