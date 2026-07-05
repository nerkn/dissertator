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
  createProvider,
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

test("selecting a chat provider resolves provider/apiUrl/model", () => {
  // P6: the chat function points at a provider row; getSettings resolves the
  // main provider/apiUrl/model block from it (so resolveChatConfig + the
  // /chat endpoint + OCR vision all see the selected backend unchanged).
  const zai = createProvider({
    name: "My Z.ai",
    kind: "chat",
    type: "zai",
  });
  saveSettings({ chatProviderId: zai.id });
  const s = getSettings();
  expect(s.provider).toBe("zai");
  expect(s.apiUrl).toBe("https://api.z.ai/api/paas/v4");
  expect(s.model).toBe("glm-4.6");
  expect(s.chatProviderId).toBe(zai.id);
});

test("resolveChatConfig falls back to main provider when no override", () => {
  // Pure-function check: a Settings with no chatProvider override mirrors
  // its main provider/apiUrl/model block (the path getSettings now feeds it).
  const resolved = resolveChatConfig({
    provider: "zai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.6",
    ocrStrategy: "tesseract",
    embedding: getSettings().embedding,
    contactEmail: "",
  });
  expect(resolved.provider).toBe("zai");
  expect(resolved.model).toBe("glm-4.6");
});

test("resolveChatConfig fills override gaps from PROVIDER_DEFAULTS", () => {
  // The chatProvider override path is retained for direct callers; getSettings
  // no longer populates it, but resolveChatConfig must still honor a caller-
  // supplied override and fill gaps from PROVIDER_DEFAULTS.
  const resolved = resolveChatConfig({
    provider: "zai",
    apiUrl: "https://api.z.ai/api/paas/v4",
    model: "glm-4.6",
    ocrStrategy: "tesseract",
    embedding: getSettings().embedding,
    contactEmail: "",
    chatProvider: "openai",
    // chatApiUrl + chatModel omitted → defaults filled in.
  });
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
