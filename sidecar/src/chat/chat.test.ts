// Tests for the P3 chat DB layer: chat settings round-trip (decision #1),
// chat message persistence, and the open-files context builder.
//
// Uses a throwaway project dir + the real `initProject`. Pattern mirrors
// db.test.ts (no other file calls initProject, so `current` is ours).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolveChatConfig } from "@dissertator/shared";

import {
  buildOpenFilesContext,
  createChat,
  getSettings,
  initProject,
  insertChatMessage,
  listChatMessages,
  saveSettings,
} from "../db.ts";

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

test("chat settings round-trip the optional override", () => {
  const s = saveSettings({
    ...getSettings(),
    chatProvider: "claude",
    chatModel: "claude-3-5-sonnet-latest",
    // chatApiUrl intentionally omitted → should round-trip as undefined.
  });
  expect(s.chatProvider).toBe("claude");
  expect(s.chatModel).toBe("claude-3-5-sonnet-latest");
  expect(s.chatApiUrl).toBeUndefined();
});

test("chat override clears to undefined when set to empty", () => {
  saveSettings({
    ...getSettings(),
    chatProvider: "claude",
    chatModel: "claude-3-5-sonnet-latest",
  });
  // Clearing: an explicit empty/undefined on all three.
  saveSettings({
    ...getSettings(),
    chatProvider: undefined,
    chatApiUrl: undefined,
    chatModel: undefined,
  });
  const s = getSettings();
  expect(s.chatProvider).toBeUndefined();
  expect(s.chatModel).toBeUndefined();
});

test("resolveChatConfig falls back to main provider when no override", () => {
  saveSettings({
    ...getSettings(),
    provider: "zai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.6",
    chatProvider: undefined,
  });
  const resolved = resolveChatConfig(getSettings());
  expect(resolved.provider).toBe("zai");
  expect(resolved.model).toBe("glm-4.6");
});

test("resolveChatConfig fills override gaps from PROVIDER_DEFAULTS", () => {
  saveSettings({
    ...getSettings(),
    chatProvider: "openai",
    // chatApiUrl + chatModel omitted → defaults filled in.
  });
  const resolved = resolveChatConfig(getSettings());
  expect(resolved.provider).toBe("openai");
  expect(resolved.apiUrl).toBe("https://api.openai.com/v1");
  expect(resolved.model).toBe("gpt-4o-mini");
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
