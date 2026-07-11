// P6: providers subsystem — the credential pool (apiUrl + keychain slot per
// row). `setChatProviderId` lives in _core (shared with project.saveSettings
// and mirrors into the chat binding via bindings.setBinding); this module
// owns provider CRUD + the embed-provider setter + the first-run seed.

import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  PROVIDER_DEFS,
  TESSERACT_PROVIDER,
  TESSERACT_TYPE,
  providerKeyUser,
  type ProviderRow,
} from "@dissertator/shared";
import { current, setChatProviderId } from "./_core.ts";

/** Snake_case shape of a `providers` DB row (no `kind`/`model` — those moved
 *  to function bindings). Mapped to the shared camelCase {@link ProviderRow}. */
interface ProviderDbRow {
  id: string;
  name: string;
  type: string;
  api_url: string;
  key_user: string;
  is_default: number;
  created_at: string;
}

function mapProvider(r: ProviderDbRow): ProviderRow {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    apiUrl: r.api_url,
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
export function seedProviders(db: Database): void {
  const existing = (db.prepare("SELECT COUNT(*) AS c FROM providers").get() as {
    c: number;
  }).c;

  if (existing === 0) {
    const now = new Date().toISOString();
    const zai = PROVIDER_DEFS.find((p) => p.id === "zai")!;
    const openai = PROVIDER_DEFS.find((p) => p.id === "openai")!;
    // Chat default (Z.ai) — reuses the legacy zai keychain slot.
    db.prepare(
      "INSERT INTO providers(id, name, type, api_url, key_user, is_default, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, ?)",
    ).run("default-chat", zai.label, "zai", zai.apiUrl, zai.keyUser, now);
    // Embedding default (OpenAI) — reuses the legacy openai keychain slot.
    db.prepare(
      "INSERT INTO providers(id, name, type, api_url, key_user, is_default, created_at) " +
        "VALUES (?, ?, ?, ?, ?, 0, ?)",
    ).run(
      "default-embedding",
      openai.label,
      "openai",
      openai.apiUrl,
      openai.keyUser,
      now,
    );
    console.log("[db] seedProviders: created default-chat + default-embedding");
  }

  // Keyless local OCR pseudo-provider (vision_doc dropdown only). Idempotent.
  db.prepare(
    "INSERT OR IGNORE INTO providers(id, name, type, api_url, key_user, is_default, created_at) " +
      "VALUES (?, ?, ?, '', '', 0, ?)",
  ).run(
    TESSERACT_PROVIDER.id,
    TESSERACT_PROVIDER.name,
    TESSERACT_TYPE,
    new Date().toISOString(),
  );

  // Point the function-selection settings at the seeded rows (idempotent).
  // Only set if absent, so a user who already picked providers isn't reset.
  const upsertIfAbsent = db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
  );
  upsertIfAbsent.run("chat_provider_id", "default-chat");
  upsertIfAbsent.run("embedding_provider_id", "default-embedding");
}

/** List all provider rows (the credential pool), oldest first. */
export function listProviders(): ProviderRow[] {
  if (!current) return [];
  const rows = current.db
    .prepare("SELECT * FROM providers ORDER BY created_at ASC")
    .all() as ProviderDbRow[];
  return rows.map(mapProvider);
}

/** One provider row, or null. */
export function getProvider(id: string): ProviderRow | null {
  if (!current) return null;
  const row = current.db
    .prepare("SELECT * FROM providers WHERE id = ?")
    .get(id) as ProviderDbRow | null;
  return row ? mapProvider(row) : null;
}

export interface ProviderInput {
  name: string;
  /** Backend flavor ("openai"|"zai"|"deepseek"|...|"tesseract"). */
  type: string;
  apiUrl?: string;
  /**
   * Keychain slot. Omit to get a fresh per-id slot via `providerKeyUser`
   * (the right choice for user-added providers). Seeded defaults pass the
   * legacy slot explicitly.
   */
  keyUser?: string;
  isDefault?: boolean;
}

/** Create a provider row. Generates a uuid id + per-id keychain slot. */
export function createProvider(input: ProviderInput): ProviderRow {
  if (!current) throw new Error("no project initialized");
  const id = randomUUID();
  const def = PROVIDER_DEFS.find((p) => p.id === input.type);
  const row: ProviderDbRow = {
    id,
    name: input.name.trim() || def?.label || input.type,
    type: input.type,
    api_url: input.apiUrl ?? def?.apiUrl ?? "",
    key_user: input.keyUser ?? providerKeyUser(id),
    is_default: 0,
    created_at: new Date().toISOString(),
  };
  current.db
    .prepare(
      "INSERT INTO providers(id, name, type, api_url, key_user, is_default, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.name,
      row.type,
      row.api_url,
      row.key_user,
      row.is_default,
      row.created_at,
    );
  const created = mapProvider(row);
  if (input.isDefault) setChatProviderId(id);
  return created;
}

/** Patch a provider row (only provided fields change). */
export function updateProvider(
  id: string,
  patch: Partial<Omit<ProviderInput, "keyUser">>,
): ProviderRow | null {
  if (!current) return null;
  const existing = getProvider(id);
  if (!existing) return null;
  const next: ProviderDbRow = {
    id: existing.id,
    name: patch.name ?? existing.name,
    type: patch.type ?? existing.type,
    api_url: patch.apiUrl ?? existing.apiUrl,
    key_user: existing.keyUser, // never change slot post-create (key would orphan)
    is_default: existing.isDefault ? 1 : 0,
    created_at: existing.createdAt,
  };
  current.db
    .prepare(
      "UPDATE providers SET name=?, type=?, api_url=?, is_default=? WHERE id=?",
    )
    .run(next.name, next.type, next.api_url, next.is_default, id);
  if (patch.isDefault) setChatProviderId(id);
  return mapProvider(next);
}

/**
 * Delete a provider row. Refuses if any function is currently bound to it
 * (the `function_bindings` row holds an ON DELETE RESTRICT FK) — rebind the
 * function first. Tesseract is also undeletable (built-in). A deletable
 * provider is unbound, so no binding ever dangles.
 */
export function deleteProvider(id: string): { ok: boolean; error?: string } {
  if (!current) return { ok: false, error: "no project initialized" };
  const existing = getProvider(id);
  if (!existing) return { ok: false, error: "not found" };
  if (existing.type === TESSERACT_TYPE) {
    return { ok: false, error: "cannot delete the built-in Tesseract provider" };
  }
  const bound = current.db
    .prepare("SELECT 1 FROM function_bindings WHERE provider_id = ? LIMIT 1")
    .get(id);
  if (bound) {
    return {
      ok: false,
      error: "rebind the function(s) using this provider before deleting it",
    };
  }
  current.db.prepare("DELETE FROM providers WHERE id = ?").run(id);
  return { ok: true };
}

/**
 * Set the vectorizer function's provider. Mirrors into the embed binding
 * WITHOUT re-vectorizing — this is the legacy UI path; the explicit
 * {@link setBinding} path (P4 Functions UI) is the one that re-vectorizes on
 * provider/model change. Keeps the legacy dropdown and the binding in sync.
 */
export function setEmbeddingProviderId(id: string): void {
  if (!current) return;
  current.db
    .prepare(
      "INSERT INTO settings(key, value) VALUES ('embedding_provider_id', ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(id);
  // Mirror into the embed binding WITHOUT re-vectorizing — this is the legacy
  // UI path; the explicit setBinding path (Functions UI) re-vectorizes. Keep
  // the current binding model if set, else blank.
  const prev = current.db
    .prepare("SELECT model FROM function_bindings WHERE function = 'embed'")
    .get() as { model?: string } | null;
  current.db
    .prepare(
      "INSERT INTO function_bindings(function, provider_id, model, updated_at) VALUES ('embed', ?, ?, ?) " +
        "ON CONFLICT(function) DO UPDATE SET provider_id = excluded.provider_id, " +
        "model = excluded.model, updated_at = excluded.updated_at",
    )
    .run(id, prev?.model ?? "", Date.now());
}
