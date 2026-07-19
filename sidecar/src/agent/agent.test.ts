// P5 agent loop + tools integration tests.
//
// The loop is exercised with a SCRIPTED fake `streamFn` (no network) that
// returns canned tool_calls then a final text answer, against a REAL temp
// project (so p_create/p_write/p_insert actually mutate the DB and emit live
// `edit` events). This pins the loop contract: tool calls → results → edits,
// final text accumulation, step cap, and abort.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createDocument,
  getDocument,
  initProject,
  updateDocument,
} from "../db";
import type { LoopMessage, StreamChatOptions, StreamResult } from "../chat/openai.ts";
import { runAgentLoop, type AgentStreamEvent } from "./loop.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";

let dir: string;
const ctxBase: ToolContext = {
  embeddingApiKey: undefined,
  activeDocumentId: undefined,
  emitGui: () => {},
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-agent-"));
  await initProject(dir);
});
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

/** Build a fake streamFn that plays back a fixed script of round-trips. */
function scriptedStream(
  rounds: StreamResult[],
  textFor: (roundIdx: number) => string
): (opts: StreamChatOptions) => Promise<StreamResult> {
  let i = 0;
  return async (opts) => {
    const round = rounds[Math.min(i, rounds.length - 1)];
    const text = textFor(i) ?? "";
    if (text) opts.onDelta(text);
    i++;
    return round;
  };
}

const CFG = { provider: "openai", apiUrl: "https://x.test", model: "test" } as const;

test("loop: p_create then final answer emits tool_call + tool_result + edit + delta", async () => {
  const events: AgentStreamEvent[] = [];
  const stream = scriptedStream(
    [
      {
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "p_create",
              arguments: JSON.stringify({ title: "Test Doc", text: "# Hi\n" }),
            },
          },
        ],
        finishReason: "tool_calls",
      },
      { toolCalls: [], finishReason: "stop" },
    ],
    (i) => (i === 1 ? "Done." : "")
  );

  const res = await runAgentLoop({
    apiKey: "k",
    config: CFG,
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "make a doc" },
    ],
    toolContext: ctxBase,
    onEvent: (e) => {
      events.push(e);
    },
    streamFn: stream,
  });

  // Final text accumulated from the second round.
  expect(res.content).toBe("Done.");
  expect(res.toolCalls).toBe(1);
  expect(res.aborted).toBe(false);
  expect(res.capped).toBe(false);

  // Event sequence: tool_call → tool_result → edit → delta.
  const types = events.map((e) => e.type);
  expect(types).toEqual(["tool_call", "tool_result", "edit", "delta"]);
  const edit = events.find((e) => e.type === "edit")!;
  expect(edit.type === "edit" && edit.bodyMd).toBe("# Hi\n");
  // The doc really was created.
  const doc = getDocument((edit as { documentId: string }).documentId);
  expect(doc?.title).toBe("Test Doc");
  expect(doc?.bodyMd).toBe("# Hi\n");
});

test("loop: multiple sequential tool calls in one round each execute", async () => {
  // Round 0: model emits TWO tool calls at once (p_read then p_write).
  const doc = createDocument({ title: "Multi" });
  updateDocument(doc.id, { bodyMd: "alpha beta gamma" });
  const events: AgentStreamEvent[] = [];
  const stream = scriptedStream(
    [
      {
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "p_read",
              arguments: JSON.stringify({ id: doc.id }),
            },
          },
          {
            id: "c2",
            type: "function",
            function: {
              name: "p_write",
              arguments: JSON.stringify({
                id: doc.id,
                oldtext: "beta",
                text: "BETA",
              }),
            },
          },
        ],
        finishReason: "tool_calls",
      },
      { toolCalls: [], finishReason: "stop" },
    ],
    (i) => (i === 1 ? "ok" : "")
  );

  await runAgentLoop({
    apiKey: "k",
    config: CFG,
    messages: [] as LoopMessage[],
    toolContext: { ...ctxBase, activeDocumentId: doc.id },
    onEvent: (e) => { events.push(e); },
    streamFn: stream,
  });

  // Two tool_calls, two tool_results, one edit (only p_write mutates).
  const calls = events.filter((e) => e.type === "tool_call");
  const results = events.filter((e) => e.type === "tool_result");
  expect(calls.length).toBe(2);
  expect(results.length).toBe(2);
  const edits = events.filter((e) => e.type === "edit");
  expect(edits.length).toBe(1);
  // Body now reflects the replacement.
  expect(getDocument(doc.id)?.bodyMd).toBe("alpha BETA gamma");
});

test("loop: step cap stops a tool-only loop and flags capped", async () => {
  // Every round returns a tool call; with maxSteps=2 the loop must stop.
  const events: AgentStreamEvent[] = [];
  const forever: StreamResult = {
    toolCalls: [
      {
        id: "c",
        type: "function",
        function: { name: "gui_action", arguments: JSON.stringify({ action: "info", text: "x" }) },
      },
    ],
    finishReason: "tool_calls",
  };
  const stream = scriptedStream([forever], () => "");
  const res = await runAgentLoop({
    apiKey: "k",
    config: CFG,
    messages: [],
    toolContext: ctxBase,
    onEvent: (e) => { events.push(e); },
    streamFn: stream,
    maxSteps: 2,
  });
  expect(res.capped).toBe(true);
  // 2 steps → 2 tool calls executed before the cap.
  expect(events.filter((e) => e.type === "tool_result").length).toBe(2);
});

test("loop: no-activity watchdog aborts a stalled provider and throws a clear error", async () => {
  // Fake provider that never emits a token: resolves only when aborted.
  const hang = (opts: StreamChatOptions) =>
    new Promise<StreamResult>((resolve) => {
      opts.signal?.addEventListener("abort", () =>
        resolve({ toolCalls: [], finishReason: "abort" }),
      );
    });
  await expect(
    runAgentLoop({
      apiKey: "k",
      config: CFG,
      messages: [{ role: "user", content: "hi" }],
      toolContext: ctxBase,
      stepTimeoutMs: 40,
      onEvent: () => {},
      streamFn: hang,
    }),
  ).rejects.toThrow(/timed out after 0s/);
});

test("loop: watchdog does not trip while the provider is actively streaming", async () => {
  // Streams a token every 5ms (well under the 200ms budget) → must finish.
  const slow = async (opts: StreamChatOptions): Promise<StreamResult> => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 5));
      opts.onDelta("x");
    }
    return { toolCalls: [], finishReason: "stop" };
  };
  const res = await runAgentLoop({
    apiKey: "k",
    config: CFG,
    messages: [{ role: "user", content: "hi" }],
    toolContext: ctxBase,
    stepTimeoutMs: 200,
    onEvent: () => {},
    streamFn: slow,
  });
  expect(res.content).toBe("xxxx");
  expect(res.aborted).toBe(false);
});

// --- dispatchTool unit tests (no loop, no network) -----------------------

test("dispatchTool p_write replaces first occurrence and returns the new body", async () => {
  const d = createDocument({ title: "W" });
  updateDocument(d.id, { bodyMd: "one two three" });
  const r = await dispatchTool(
    "p_write",
    { id: d.id, oldtext: "two", text: "TWO" },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.document?.bodyMd).toBe("one TWO three");
  expect(getDocument(d.id)?.bodyMd).toBe("one TWO three");
});

test("dispatchTool p_write fails when oldtext is absent (optimistic)", async () => {
  const d = createDocument({ title: "W2" });
  updateDocument(d.id, { bodyMd: "abc" });
  const r = await dispatchTool(
    "p_write",
    { id: d.id, oldtext: "xyz", text: "nope" },
    ctxBase
  );
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
  expect(getDocument(d.id)?.bodyMd).toBe("abc"); // unchanged
});

test("dispatchTool p_insert anchors after first match; empty anchor prepends", async () => {
  const d = createDocument({ title: "I" });
  updateDocument(d.id, { bodyMd: "head\nbody" });
  const r1 = await dispatchTool(
    "p_insert",
    { id: d.id, anchor: "head", text: "\nmiddle" },
    ctxBase
  );
  expect(r1.ok).toBe(true);
  expect(r1.document?.bodyMd).toBe("head\nmiddle\nbody");

  const r2 = await dispatchTool(
    "p_insert",
    { id: d.id, anchor: "", text: "TOP\n" },
    ctxBase
  );
  expect(r2.ok).toBe(true);
  expect(getDocument(d.id)?.bodyMd).toBe("TOP\nhead\nmiddle\nbody");
});

test("dispatchTool unknown tool returns ok=false", async () => {
  const r = await dispatchTool("nope_tool", {}, ctxBase);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("unknown tool");
});

test("dispatchTool doc_read resolves a citekey to its linked source", async () => {
  const project = (await import("../db")).getCurrentProject()!;
  const sid = "src-docread-citekey-test";
  project.db
    .prepare(
      `INSERT OR REPLACE INTO source_files
       (id, rel_path, filename, ext, kind, page_count, text_status, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sid, "x.pdf", "x.pdf", "pdf", "pdf", 1, "done", 1700000002);
  project.db
    .prepare(
      `INSERT OR REPLACE INTO chunks (id, source_file_id, ord, physical_page, text)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run("chk-drc-1", sid, 1, 1, "hello body");
  const { upsertReference } = await import("../db");
  upsertReference({
    citekey: "CiteKey2025",
    title: "Sample",
    source_file_id: sid,
  });
  const byId = await dispatchTool("doc_read", { id: sid }, ctxBase);
  expect(byId.ok).toBe(true);
  const byCitekey = await dispatchTool(
    "doc_read",
    { id: "CiteKey2025" },
    ctxBase,
  );
  expect(byCitekey.ok).toBe(true);
  expect((byCitekey.data as { text: string }).text).toContain("hello body");
  const missing = await dispatchTool("doc_read", { id: "nope" }, ctxBase);
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("citekey");
});
