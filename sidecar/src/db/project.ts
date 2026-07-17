// Project lifecycle + cross-cutting settings: init/open, status, settings
// read/save, embedding dimension lock + status. This is the orchestrator
// module — it wires the shared connection (_core) and reaches into a couple
// of entity modules at init/save time (setEmbeddingProviderId,
// backfillSourceReferences). It is the ONLY writer of the shared `current`
// handle, via `setCurrentProject`.

import { Database } from "bun:sqlite";
import { exists, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getLoadablePath } from "sqlite-vec";
import {
  AI_FUNCTIONS,
  isKeylessProviderType,
  type Bindings,
  type EmbeddingStatus,
  type InitProjectResponse,
  type ProjectStatus,
  type ResolvedBindings,
  type Settings,
  type SettingsPatch,
} from "@dissertator/shared";
import {
  count,
  current,
  DEFAULT_PROMPTS_MD,
  DISS_DIR_NAME,
  migrate,
  ProjectState,
  readBindingsJoined,
  readSchema,
  setChatProviderId,
  setCurrentProject,
} from "./_core.ts";
import { setEmbeddingProviderId } from "./providers.ts";
import { backfillSourceReferences } from "./references.ts";
import { ensureAgentFiles } from "../agent-files.ts";

/**
 * Resolve the sqlite-vec vec0 extension path.
 *
 * Release builds set `DISSERTATOR_VEC0_PATH` (Tauri resource dir) because
 * `bun build --compile` does NOT bundle the native `.so`/`.dll`, so
 * `getLoadablePath()`'s `import.meta.resolve(...)` fails against the
 * compiled binary's virtual FS. We also fall back to
 * `DISSERTATOR_RESOURCE_DIR/native/<lib>` in case only the resource root
 * was exported. Dev leaves both unset and falls back to `getLoadablePath()`,
 * which resolves the lib from `node_modules`.
 */
function vecExtensionPath(): string {
  const tried: string[] = [];
  const name =
    process.platform === "win32"
      ? "vec0.dll"
      : process.platform === "darwin"
        ? "vec0.dylib"
        : "vec0.so";

  const env = process.env.DISSERTATOR_VEC0_PATH;
  if (env) {
    if (existsSync(env)) return env;
    tried.push(env);
  }
  const rd = process.env.DISSERTATOR_RESOURCE_DIR;
  if (rd) {
    const p = join(rd, "native", name);
    if (existsSync(p)) return p;
    tried.push(p);
  }
  try {
    return getLoadablePath();
  } catch (e) {
    throw new Error(
      `sqlite-vec vec0 extension not found. Tried: [${tried.join(", ")}]. ` +
        `Ensure the native/vec0.* lib ships alongside the app ` +
        `(DISSERTATOR_VEC0_PATH / DISSERTATOR_RESOURCE_DIR). ` +
        `Underlying: ${(e as Error)?.message ?? String(e)}`,
    );
  }
}

export function getCurrentProject(): ProjectState | null {
  return current;
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
    db.loadExtension(vecExtensionPath());
    vecExtensionOk = true;
  } catch (e) {
    console.error(
      "[db] sqlite-vec extension failed to load (embeddings disabled):",
      (e as Error)?.message ?? String(e)
    );
  }

  // Prime default settings (idempotent). Legacy provider/apiUrl/model +
  // embedding_* keys are gone — providers + function_bindings are the single
  // source of truth (seeded by seedProviders/seedBindings below).
  const seed = db.prepare(
    "INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)"
  );
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

  // agent/ — personality.md + rules.md (Settings → Agent tab). Seeded once;
  // existing files are never overwritten so the user's edits win.
  await ensureAgentFiles(dissertatorDir);

  setCurrentProject({ projectPath, dissertatorDir, dbPath, db, createdAt, vecExtensionOk });

  // Backfill: ensure every source has a citekey-bearing reference so no note
  // is ever cite-less (greyed cite button). No-op on a steady-state reopen.
  // See docs/citekey.md §3. Runs AFTER `current` is set (the helpers below
  // depend on it).
  backfillSourceReferences();

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
      ocrStrategy: "tesseract",
      contactEmail: "",
      embeddingDimensions: 0,
    };
  }
  const rows = current.db
    .query("SELECT key, value FROM settings")
    .all() as { key: string; value: string }[];
  const obj: Record<string, string> = {};
  for (const r of rows) obj[r.key] = r.value;

  // --- function bindings: the single source of truth ---
  const joined = readBindingsJoined();
  const bindings = {} as Bindings;
  const resolved = {} as ResolvedBindings;
  for (const fn of AI_FUNCTIONS) {
    const r = joined.find((x) => x.fn === fn);
    bindings[fn] = {
      fn,
      providerId: r?.providerId ?? "",
      model: r?.model ?? "",
      updatedAt: r?.updatedAt ?? 0,
    };
    resolved[fn] = {
      fn,
      providerId: r?.providerId ?? "",
      apiUrl: r?.apiUrl ?? "",
      model: r?.model ?? "",
      type: r?.type ?? "",
    };
  }

  const dimensionsRaw = obj.embedding_dimensions;
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : 0;

  return {
    ocrStrategy: (obj.ocrStrategy as Settings["ocrStrategy"]) ?? "tesseract",
    contactEmail: obj.contactEmail ?? "",
    chatProviderId: resolved.chat.providerId || obj.chat_provider_id || undefined,
    embeddingProviderId:
      resolved.embed.providerId || obj.embedding_provider_id || undefined,
    embeddingDimensions:
      Number.isFinite(dimensions) && dimensions > 0 ? dimensions : 0,
    bindings,
    resolved,
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

  // Mirror into settings so getSettings().embeddingDimensions reflects the lock.
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
      keyless: false,
      running: false,
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
    dimensions: s.embeddingDimensions ?? 0,
    model: s.resolved?.embed.model ?? "",
    vecLoaded: current.vecExtensionOk,
    keyless: isKeylessProviderType(s.resolved?.embed.type ?? ""),
    // The live `running` flag is merged in by the route (it lives in the ingest
    // module, which imports db — importing it back here would be circular).
    running: false,
  };
}
