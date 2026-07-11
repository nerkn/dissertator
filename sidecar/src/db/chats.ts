// Chat (P3 → P4): freeform chat threads, scoped by chat_id.
//
// A chat is a persisted thread (NOT bound to any document). The user picks
// which source files are in scope per chat (stored on the chat row for UI
// persistence). Messages belong to a chat via `chat_messages.chat_id`. The
// agent loop replays only that chat's recent turns (see POST /chat). The
// legacy single-global-chat DBs are migrated forward to a deterministic
// "General" chat by migrate(). Open-files context (`buildOpenFilesContext`)
// is unchanged — plain full-text injection from `chunks`.

import { randomUUID } from "node:crypto";
import { type Chat, type ChatMessage } from "@dissertator/shared";
import { current } from "./_core.ts";

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
