// Multi-provider bindings (P-multi): function ↔ provider+model matrix.
//
// `function_bindings` holds exactly one row per AiFunction. Each points at a
// `providers` row (apiUrl + keyUser) and carries its OWN model. The legacy
// chat_provider_id / embedding_provider_id settings remain the source of
// truth for the legacy Settings fields during the transition; bindings mirror
// them on seed and become the editable surface once the Functions UI (P4)
// switches to `setBinding`.
//
// `readBindingsJoined` lives in _core (shared with project.getSettings).

import type { Database } from "bun:sqlite";
import {
  AI_FUNCTIONS,
  type AiFunction,
  type Bindings,
  type BindingPatch,
  type BindingSetResult,
  type ResolvedBindings,
} from "@dissertator/shared";
import { current, readBindingsJoined } from "./_core.ts";

interface BindingRow {
  function: string;
  provider_id: string;
  model: string;
  updated_at: number;
}

/** Count of seeded binding rows (db-param form for use in migrate). */
function bindingCount(db: Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM function_bindings").get() as {
    c: number;
  }).c;
}

/** True if a binding row exists for `fn` (db-param form for use in migrate). */
function bindingExists(db: Database, fn: AiFunction): boolean {
  return !!db
    .prepare("SELECT 1 FROM function_bindings WHERE function = ?")
    .get(fn);
}

/**
 * Seed the five function bindings on first migration, mirroring the legacy
 * chat_provider_id / embedding_provider_id pointers: chat/stt/vision_* → the
 * chat provider, embed → the embedding provider. Idempotent — never
 * overwrites an existing binding row, so a user who already wired functions
 * is not reset.
 */
export function seedBindings(db: Database): void {
  if (bindingCount(db) >= AI_FUNCTIONS.length) return;

  const getSetting = (k: string): string | undefined =>
    (db.prepare("SELECT value FROM settings WHERE key = ?").get(k) as {
      value?: string;
    } | null)?.value;
  const chatId = getSetting("chat_provider_id") ?? "default-chat";
  const embId = getSetting("embedding_provider_id") ?? "default-embedding";

  const now = Date.now();
  const ins = db.prepare(
    "INSERT OR IGNORE INTO function_bindings(function, provider_id, model, updated_at) VALUES (?, ?, ?, ?)",
  );
  const seed = (fn: AiFunction, providerId: string, model: string): void => {
    if (bindingExists(db, fn)) return;
    ins.run(fn, providerId, model, now);
  };
  // Default models match the seeded providers: Z.ai (chat/vision glm-4.6,
  // whisper-1 for stt) + OpenAI (embed text-embedding-3-small).
  seed("chat", chatId, "glm-4.6");
  seed("stt", chatId, "whisper-1");
  seed("vision_doc", chatId, "glm-4.6");
  seed("vision_image", chatId, "glm-4.6");
  seed("embed", embId, "text-embedding-3-small");
}

/** All five bindings, keyed by function. null if no project is open. */
export function getBindings(): Bindings | null {
  if (!current) return null;
  const joined = readBindingsJoined();
  const out = {} as Bindings;
  for (const fn of AI_FUNCTIONS) {
    const r = joined.find((x) => x.fn === fn);
    out[fn] = {
      fn,
      providerId: r?.providerId ?? "",
      model: r?.model ?? "",
      updatedAt: r?.updatedAt ?? 0,
    };
  }
  return out;
}

/** All five bindings resolved with their provider's apiUrl/type. */
export function getResolvedBindings(): ResolvedBindings | null {
  if (!current) return null;
  const joined = readBindingsJoined();
  const out = {} as ResolvedBindings;
  for (const fn of AI_FUNCTIONS) {
    const r = joined.find((x) => x.fn === fn);
    out[fn] = {
      fn,
      providerId: r?.providerId ?? "",
      apiUrl: r?.apiUrl ?? "",
      model: r?.model ?? "",
      type: r?.type ?? "",
    };
  }
  return out;
}

/**
 * Reset every chunk to `pending` and drop the vec0 table so the next embed
 * re-locks dimensions for the new model. Called (in a transaction) by
 * {@link setBinding} when the EMBED binding's provider or model changes —
 * changing the vector space invalidates all existing vectors.
 */
function revectorizeAll(db: Database): void {
  db.exec("UPDATE chunks SET embedding_status = 'pending'");
  db.exec("DROP TABLE IF EXISTS embeddings");
  // Unlock the dimension so lockDimensions treats the next embed as a first
  // lock (it would otherwise throw on the dimension mismatch).
  const unlockSetting = db.prepare(
    "INSERT INTO settings(key, value) VALUES ('embedding_dimensions', '0') " +
      "ON CONFLICT(key) DO UPDATE SET value = '0'",
  );
  unlockSetting.run();
  const unlockMeta = db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, '0') " +
      "ON CONFLICT(key) DO UPDATE SET value = '0'",
  );
  unlockMeta.run("embedding_dimensions");
  const clearModel = db.prepare(
    "INSERT INTO meta(key, value) VALUES (?, '') " +
      "ON CONFLICT(key) DO UPDATE SET value = ''",
  );
  clearModel.run("embedding_model_id");
}

/**
 * Set a function's binding (provider + model). For `embed`, changing the
 * provider or model triggers a full re-vectorize (all chunks → pending, vec0
 * table dropped, dimension unlocked); the caller then kicks the background
 * embed worker and warns the user via the returned `revectorized` flag.
 * Returns the new binding + whether a re-vectorize kicked off.
 */
export function setBinding(
  fn: AiFunction,
  patch: BindingPatch,
): BindingSetResult {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const prov = db.prepare("SELECT id FROM providers WHERE id = ?").get(
    patch.providerId,
  ) as { id?: string } | null;
  if (!prov) throw new Error(`provider not found: ${patch.providerId}`);

  const prev = db
    .prepare("SELECT provider_id, model FROM function_bindings WHERE function = ?")
    .get(fn) as { provider_id?: string; model?: string } | null;
  const revectorized =
    fn === "embed" &&
    !!prev &&
    (prev.provider_id !== patch.providerId || prev.model !== patch.model);

  const now = Date.now();
  const tx = db.transaction(() => {
    if (revectorized) revectorizeAll(db);
    db.prepare(
      "INSERT INTO function_bindings(function, provider_id, model, updated_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(function) DO UPDATE SET provider_id = excluded.provider_id, " +
        "model = excluded.model, updated_at = excluded.updated_at",
    ).run(fn, patch.providerId, patch.model, now);
  });
  tx();

  return {
    binding: { fn, providerId: patch.providerId, model: patch.model, updatedAt: now },
    revectorized,
  };
}
