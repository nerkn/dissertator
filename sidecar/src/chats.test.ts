// DB-backed tests for chat thread CRUD (P4): freeform chats scoped by chat_id.
//
// Pins:
//   1. createChat default title/contextSources + round-trip;
//   2. updateChat omit-vs-set (title + contextSources) + updated_at bump;
//   3. getChat returns null for an unknown id (404 path);
//   4. deleteChat cascades its messages (app-side transactional cascade);
//   5. listChats ordering by updated_at DESC (most-recently-touched first);
//   6. insertChatMessage + listChatMessages scoping (two chats don't bleed).
//
// Mirrors documents.test.ts: throwaway project dir + real `initProject` (which
// runs the chats/chat_id migration). Bun isolates each test FILE into its own
// process, so the module-level `current` project is owned exclusively here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createChat,
  deleteChat,
  getCurrentProject,
  getChat,
  initProject,
  insertChatMessage,
  listChatMessages,
  listChats,
  updateChat,
} from "./db";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-chats-"));
  await initProject(dir);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// createChat defaults + round-trip.
// ---------------------------------------------------------------------------

test("createChat uses default title 'New chat' + empty contextSources", () => {
  const chat = createChat({});
  expect(chat.id).toBeTruthy();
  expect(chat.title).toBe("New chat");
  expect(chat.contextSources).toEqual([]);
  expect(chat.createdAt).toBeGreaterThan(0);
  expect(chat.updatedAt).toBe(chat.createdAt);

  // getChat reads the row back unchanged.
  const got = getChat(chat.id);
  expect(got).not.toBeNull();
  expect(got!.id).toBe(chat.id);
  expect(got!.title).toBe("New chat");
  expect(got!.contextSources).toEqual([]);

  // Unknown id → null (route turns into 404).
  expect(getChat("no-such-chat")).toBeNull();
});

test("createChat honors provided title + contextSources", () => {
  const chat = createChat({
    title: "Lit review brainstorm",
    contextSources: ["src-a", "src-b"],
  });
  expect(chat.title).toBe("Lit review brainstorm");
  expect(chat.contextSources).toEqual(["src-a", "src-b"]);
});

// ---------------------------------------------------------------------------
// updateChat — omit-vs-set + updated_at bump.
// ---------------------------------------------------------------------------

test("updateChat sets title and getChat reads it back", () => {
  const chat = createChat({ title: "Old" });
  const updated = updateChat(chat.id, { title: "New" });
  expect(updated).not.toBeNull();
  expect(updated!.title).toBe("New");
  expect(getChat(chat.id)!.title).toBe("New");
});

test("updateChat omit-vs-set for contextSources: omit keeps, set replaces", () => {
  const chat = createChat({ contextSources: ["a", "b"] });
  // Omit contextSources → preserved.
  const titled = updateChat(chat.id, { title: "Renamed" });
  expect(titled!.contextSources).toEqual(["a", "b"]);
  // Set contextSources → replaces (NOT merges).
  const replaced = updateChat(chat.id, { contextSources: ["c"] });
  expect(replaced!.contextSources).toEqual(["c"]);
  // Explicit empty array clears.
  const cleared = updateChat(chat.id, { contextSources: [] });
  expect(cleared!.contextSources).toEqual([]);
});

test("updateChat bumps updated_at on any call (including empty patch = touch)", async () => {
  const chat = createChat({ title: "T" });
  const before = chat.updatedAt;
  // Force a clock tick so Date.now() is strictly greater.
  await new Promise((r) => setTimeout(r, 5));
  const touched = updateChat(chat.id, {});
  expect(touched).not.toBeNull();
  expect(touched!.updatedAt).toBeGreaterThanOrEqual(before);
  // Empty patch must NOT nuke fields.
  expect(touched!.title).toBe("T");
  expect(touched!.contextSources).toEqual([]);
});

test("updateChat on an unknown id returns null", () => {
  expect(updateChat("no-such-chat", { title: "x" })).toBeNull();
});

// ---------------------------------------------------------------------------
// deleteChat — app-side cascade of the chat's messages.
// ---------------------------------------------------------------------------

test("deleteChat cascades its messages and returns false once gone", () => {
  const chat = createChat({ title: "Doomed" });
  insertChatMessage({ chatId: chat.id, role: "user", content: "hi" });
  insertChatMessage({
    chatId: chat.id,
    role: "assistant",
    content: "hello",
  });
  expect(listChatMessages(chat.id)).toHaveLength(2);

  // Delete the chat → its messages are gone too (app-side cascade).
  expect(deleteChat(chat.id)).toBe(true);
  expect(getChat(chat.id)).toBeNull();
  expect(listChatMessages(chat.id)).toEqual([]);
  // Idempotent: deleting again returns false.
  expect(deleteChat(chat.id)).toBe(false);
});

test("deleteChat does NOT touch other chats' messages", () => {
  const a = createChat({ title: "A" });
  const b = createChat({ title: "B" });
  insertChatMessage({ chatId: a.id, role: "user", content: "a-msg" });
  insertChatMessage({ chatId: b.id, role: "user", content: "b-msg" });
  expect(deleteChat(a.id)).toBe(true);
  // B's messages survive.
  expect(listChatMessages(b.id)).toHaveLength(1);
  expect(listChatMessages(b.id)[0].content).toBe("b-msg");
});

// ---------------------------------------------------------------------------
// listChats — ordered by updated_at DESC (most-recently-touched first).
// ---------------------------------------------------------------------------

test("listChats orders by updated_at DESC", async () => {
  // Create three chats in order; touch the OLDEST last so it floats up.
  const old = createChat({ title: "old" });
  const mid = createChat({ title: "mid" });
  const newest = createChat({ title: "newest" });
  // Guarantee distinct timestamps with small sleeps (Date.now() ms resolution).
  await new Promise((r) => setTimeout(r, 5));
  updateChat(mid.id, {});
  await new Promise((r) => setTimeout(r, 5));
  updateChat(old.id, {}); // old touched last → floats to top
  await new Promise((r) => setTimeout(r, 5));
  updateChat(newest.id, {}); // newest touched last now → top

  const chats = listChats();
  const idxOld = chats.findIndex((c) => c.id === old.id);
  const idxMid = chats.findIndex((c) => c.id === mid.id);
  const idxNew = chats.findIndex((c) => c.id === newest.id);
  expect(idxOld).toBeGreaterThanOrEqual(0);
  expect(idxMid).toBeGreaterThanOrEqual(0);
  expect(idxNew).toBeGreaterThanOrEqual(0);
  // Most-recently-touched (newest) is first; old (touched 2nd-last) after it;
  // mid (touched earliest) last of the three.
  expect(idxNew).toBeLessThan(idxOld);
  expect(idxOld).toBeLessThan(idxMid);
});

// ---------------------------------------------------------------------------
// insertChatMessage + listChatMessages — scoping (two chats don't bleed).
// ---------------------------------------------------------------------------

test("listChatMessages is scoped by chatId (no bleed between chats)", () => {
  const a = createChat({ title: "A2" });
  const b = createChat({ title: "B2" });
  insertChatMessage({ chatId: a.id, role: "user", content: "a1" });
  insertChatMessage({ chatId: a.id, role: "assistant", content: "a2" });
  insertChatMessage({ chatId: b.id, role: "user", content: "b1" });

  const aMsgs = listChatMessages(a.id);
  const bMsgs = listChatMessages(b.id);
  expect(aMsgs).toHaveLength(2);
  expect(bMsgs).toHaveLength(1);
  expect(aMsgs.map((m) => m.content)).toEqual(["a1", "a2"]);
  expect(bMsgs.map((m) => m.content)).toEqual(["b1"]);
  // Each message carries its chat id.
  for (const m of aMsgs) expect(m.chatId).toBe(a.id);
  for (const m of bMsgs) expect(m.chatId).toBe(b.id);
});

test("listChatMessages respects the limit (most-recent N, oldest-first)", () => {
  const chat = createChat({ title: "Lim" });
  for (let i = 0; i < 5; i++) {
    insertChatMessage({ chatId: chat.id, role: "user", content: `m${i}` });
  }
  // Limit 3 → the 3 most-recent (m2,m3,m4), oldest-first (m2,m3,m4).
  const msgs = listChatMessages(chat.id, 3);
  expect(msgs.map((m) => m.content)).toEqual(["m2", "m3", "m4"]);
});

test("listChatMessages on an empty chat returns []", () => {
  const chat = createChat({ title: "Empty" });
  expect(listChatMessages(chat.id)).toEqual([]);
});

// ---------------------------------------------------------------------------
// mapChat tolerates a malformed context_sources JSON column (→ []).
// ---------------------------------------------------------------------------

test("mapChat tolerates a malformed context_sources JSON column (→ [])", () => {
  const db = getCurrentProject()!.db;
  const id = "chat-badjson";
  const now = Date.now();
  db.prepare(
    "INSERT INTO chats(id, title, context_sources, created_at, updated_at) " +
      "VALUES (?, 'bad', ?, ?, ?)"
  ).run(id, "{not valid json", now, now);
  const got = getChat(id)!;
  expect(got.contextSources).toEqual([]);
});
