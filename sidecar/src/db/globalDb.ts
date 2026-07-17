import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { seedProviders } from "./providers.ts";
import { seedBindings } from "./bindings.ts";

function globalDir(): string {
  const env = process.env.DISSERTATOR_APP_DATA_DIR;
  if (env) return env;
  return join(homedir(), ".dissertator");
}

const dir = globalDir();
mkdirSync(dir, { recursive: true });

export const globalDb = new Database(join(dir, "app.db"));
globalDb.exec("PRAGMA journal_mode = WAL;");
globalDb.exec("PRAGMA foreign_keys = ON;");

globalDb.exec(`
CREATE TABLE IF NOT EXISTS providers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL,
  api_url    TEXT NOT NULL DEFAULT '',
  key_user   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS function_bindings (
  function    TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE RESTRICT,
  model       TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS keys (
  key_user TEXT PRIMARY KEY,
  value    TEXT NOT NULL DEFAULT ''
);
`);

export function getGlobalSetting(key: string): string | undefined {
  const row = globalDb
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value?: string } | null;
  return row?.value;
}

export function setGlobalSetting(key: string, value: string): void {
  globalDb
    .prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

export function getKey(keyUser: string): string {
  const row = globalDb
    .prepare("SELECT value FROM keys WHERE key_user = ?")
    .get(keyUser) as { value?: string } | null;
  return row?.value ?? "";
}

export function setKey(keyUser: string, value: string): void {
  if (value) {
    globalDb
      .prepare(
        "INSERT INTO keys(key_user, value) VALUES (?, ?) " +
          "ON CONFLICT(key_user) DO UPDATE SET value = excluded.value",
      )
      .run(keyUser, value);
  } else {
    globalDb.prepare("DELETE FROM keys WHERE key_user = ?").run(keyUser);
  }
}

export function deleteKey(keyUser: string): void {
  globalDb.prepare("DELETE FROM keys WHERE key_user = ?").run(keyUser);
}

export function listKeys(): Record<string, string> {
  const rows = globalDb
    .prepare("SELECT key_user, value FROM keys")
    .all() as Array<{ key_user: string; value: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.key_user] = r.value;
  return out;
}

export function getChatKey(): string {
  const row = globalDb
    .prepare(
      "SELECT p.key_user AS ku " +
        "FROM function_bindings b JOIN providers p ON p.id = b.provider_id " +
        "WHERE b.function = 'chat'",
    )
    .get() as { ku?: string } | null;
  return row?.ku ? getKey(row.ku) : "";
}

seedProviders(globalDb);
seedBindings(globalDb);
