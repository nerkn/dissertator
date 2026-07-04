// Sidecar DB layer — owns the Dissertator SQLite database (bun:sqlite).
//
// One project is active at a time (single-user, local). `initProject` creates
// the visible `Dissertator/` directory, the SQLite db (running schema.sql),
// writes project.toml, and primes default settings. It is idempotent.

import { Database } from "bun:sqlite";
import { exists, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROVIDER_DEFAULTS,
  type InitProjectResponse,
  type ProjectStatus,
  type Settings,
  type SourceFile,
} from "@dissertator/shared";

const DISS_DIR_NAME = "Dissertator";

interface ProjectState {
  projectPath: string;
  dissertatorDir: string;
  dbPath: string;
  db: Database;
  createdAt: string;
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
 * Idempotent migration: add any missing `source_files` columns and stamp
 * `meta.schema_version = '2'`. Safe to run on every `initProject`.
 */
function migrate(db: Database): void {
  const cols = db
    .prepare("PRAGMA table_info(source_files)")
    .all() as Array<{ name: string }>;
  const have = new Set(cols.map((c) => c.name));
  for (const col of SOURCE_FILE_NEW_COLUMNS) {
    if (!have.has(col.name)) {
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
  // Idempotent schema-version bump.
  db.prepare(
    "INSERT INTO meta(key, value) VALUES ('schema_version', '2') " +
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

  // Prime default settings (idempotent).
  const seed = db.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)"
  );
  const d = PROVIDER_DEFAULTS.openai;
  seed.run("provider", "openai");
  seed.run("apiUrl", d.apiUrl);
  seed.run("model", d.defaultModel);

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

  current = { projectPath, dissertatorDir, dbPath, db, createdAt };

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

export function getSettings(): Settings {
  if (!current) {
    return {
      provider: "openai",
      apiUrl: PROVIDER_DEFAULTS.openai.apiUrl,
      model: PROVIDER_DEFAULTS.openai.defaultModel,
      ocrStrategy: "tesseract",
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
  return getSettings();
}

/**
 * Map a snake_case `source_files` DB row to the camelCase `SourceFile`
 * contract shared with the frontend. Reused by later stages.
 */
export function mapSourceFile(row: any): SourceFile {
  return {
    id: row.id,
    relPath: row.rel_path,
    filename: row.filename,
    ext: row.ext,
    kind: row.kind,
    contentHash: row.content_hash ?? null,
    fileSize: row.file_size ?? null,
    mimeType: row.mime_type ?? null,
    textStatus: row.text_status,
    ocrMethod: row.ocr_method ?? null,
    pageCount: row.page_count ?? null,
    error: row.error ?? null,
    needsOcrReason: row.needs_ocr_reason ?? null,
    addedAt: row.added_at,
  };
}
