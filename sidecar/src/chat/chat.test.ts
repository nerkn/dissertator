// Tests for the chat DB layer: chat binding → resolved-endpoint round-trip,
// chat message persistence, and the open-files context builder.
//
// Uses a throwaway project dir + the real `initProject`. Pattern mirrors
// db.test.ts (no other file calls initProject, so `current` is ours).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  buildOpenFilesContext,
  createChat,
  initProject,
  insertChatMessage,
  listChatMessages,
  getSettings,
} from "../db";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-chat-"));
  await initProject(dir);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

test("the seeded chat binding resolves to a provider endpoint", () => {
  // getSettings().resolved.chat is what the /chat route feeds to the adapter:
  // the bound provider's apiUrl + type, plus the binding's model. With the
  // default Z.ai seed, that endpoint is Z.ai's PaaS v4 URL.
  const s = getSettings();
  expect(s.resolved).toBeDefined();
  expect(s.resolved!.chat.type).toBe("zai");
  expect(s.resolved!.chat.apiUrl).toBe("https://api.z.ai/api/paas/v4");
  expect(s.resolved!.chat.model).toBeTruthy();
  // chatProviderId mirrors the chat binding (legacy compat shim).
  expect(s.chatProviderId).toBe(s.resolved!.chat.providerId);
});

test("chat messages persist and replay oldest-first", () => {
  const chat = createChat({ title: "Msg test" });
  const u = insertChatMessage({
    chatId: chat.id,
    role: "user",
    content: "hello",
    openFiles: ["src1", "src2"],
  });
  const a = insertChatMessage({
    chatId: chat.id,
    role: "assistant",
    content: "hi there",
    costTokens: { prompt: 5, completion: 12 },
  });
  const msgs = listChatMessages(chat.id, 50);
  // Oldest-first: the user turn precedes the assistant turn.
  const uIdx = msgs.findIndex((m: { id: string }) => m.id === u.id);
  const aIdx = msgs.findIndex((m: { id: string }) => m.id === a.id);
  expect(uIdx).toBeGreaterThanOrEqual(0);
  expect(aIdx).toBeGreaterThanOrEqual(0);
  expect(uIdx).toBeLessThan(aIdx);
  // openFiles JSON round-trips.
  expect(msgs[uIdx].openFiles).toEqual(["src1", "src2"]);
  // Only .completion is persisted as the integer cost column.
  expect(msgs[aIdx].costTokens).toBe(12);
  // chatId threads onto each message.
  expect(msgs[uIdx].chatId).toBe(chat.id);
  expect(msgs[aIdx].chatId).toBe(chat.id);
});

test("buildOpenFilesContext returns null when no chunks exist", () => {
  expect(buildOpenFilesContext(["no-such-file"])).toBeNull();
});

test("buildOpenFilesContext returns null for empty input", () => {
  expect(buildOpenFilesContext([])).toBeNull();
});
