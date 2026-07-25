import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createManuscript,
  getSourceById,
  initProject,
} from "../db";
import { readSourceMarkdown, writeSourceMarkdown } from "../ingest/index.ts";
import type { SourceFile } from "@dissertator/shared";

const src = (id: string): SourceFile => getSourceById(id)!;
const getBody = (id: string) => readSourceMarkdown(src(id));
const setBody = (id: string, md: string) => writeSourceMarkdown(src(id), md);
import type { LoopMessage, StreamChatOptions, StreamResult } from "../chat/openai.ts";
import { runAgentLoop, type AgentStreamEvent } from "./loop.ts";
import { dispatchTool, type ToolContext } from "./tools.ts";

let dir: string;
const ctxBase: ToolContext = {
  embeddingApiKey: undefined,
  activeSourceId: undefined,
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

test("loop: create then final answer emits tool_call + tool_result + edit + delta", async () => {
  const events: AgentStreamEvent[] = [];
  const stream = scriptedStream(
    [
      {
        toolCalls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "create",
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
  const docId = (edit as { sourceId: string }).sourceId;
  expect(getSourceById(docId)?.filename.replace(/\.[^.]+$/, "")).toBe("Test Doc");
  expect(await getBody(docId)).toBe("# Hi\n");
});

test("loop: multiple sequential tool calls in one round each execute", async () => {
  const doc = await createManuscript({ title: "Multi" });
  await setBody(doc.id, "alpha beta gamma");
  const events: AgentStreamEvent[] = [];
  const stream = scriptedStream(
    [
      {
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ id: doc.id }),
            },
          },
          {
            id: "c2",
            type: "function",
            function: {
              name: "edit",
              arguments: JSON.stringify({
                id: doc.id,
                op: "replace",
                anchor: "beta",
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
    toolContext: { ...ctxBase, activeSourceId: doc.id },
    onEvent: (e) => { events.push(e); },
    streamFn: stream,
  });

  const calls = events.filter((e) => e.type === "tool_call");
  const results = events.filter((e) => e.type === "tool_result");
  expect(calls.length).toBe(2);
  expect(results.length).toBe(2);
  const edits = events.filter((e) => e.type === "edit");
  expect(edits.length).toBe(1);
  // Body now reflects the replacement.
  expect((await getBody(doc.id))).toBe("alpha BETA gamma");
});

test("loop: step cap stops a tool-only loop and flags capped", async () => {
  // Every round returns a tool call; with maxSteps=2 the loop must stop.
  const events: AgentStreamEvent[] = [];
  const forever: StreamResult = {
    toolCalls: [
      {
        id: "c",
        type: "function",
        function: { name: "toast", arguments: JSON.stringify({ action: "info", text: "x" }) },
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
  // Two-phase fake: first call offers quick replies (so the suggest-replies
  // nudge never fires), second call streams the text answer.
  let phase = 0;
  const slow = async (opts: StreamChatOptions): Promise<StreamResult> => {
    phase++;
    if (phase === 1) {
      return {
        toolCalls: [
          {
            id: "t1",
            type: "function",
            function: {
              name: "suggest",
              arguments: JSON.stringify({
                options: [{ short: "A", prompt: "a" }],
              }),
            },
          },
        ],
        finishReason: "tool_calls",
      };
    }
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

test("loop: nudges the model to call suggest when it forgets", async () => {
  // First call: text answer, no quick-reply buttons → loop must nudge once.
  // Second call: still no buttons → accepted (no infinite loop).
  let phase = 0;
  const forgetful = async (): Promise<StreamResult> => {
    phase++;
    return phase === 1
      ? { toolCalls: [], finishReason: "stop" }
      : phase === 2
        ? {
            toolCalls: [
              {
                id: "t1",
                type: "function",
                function: {
                  name: "suggest",
                  arguments: JSON.stringify({
                    options: [{ short: "A", prompt: "a" }],
                  }),
                },
              },
            ],
            finishReason: "tool_calls",
          }
        : { toolCalls: [], finishReason: "stop" };
  };
  const events: AgentStreamEvent[] = [];
  const res = await runAgentLoop({
    apiKey: "k",
    config: CFG,
    messages: [{ role: "user", content: "hi" }],
    toolContext: ctxBase,
    onEvent: (e) => {
      events.push(e);
    },
    streamFn: forgetful,
  });
  // The nudge happened: the model was called a 2nd time and the tool ran.
  expect(phase).toBeGreaterThanOrEqual(2);
  expect(
    events.some(
      (e) => e.type === "tool_call" && e.name === "suggest",
    ),
  ).toBe(true);
  expect(res.aborted).toBe(false);
});

// --- dispatchTool unit tests (no loop, no network) -----------------------

test("dispatchTool edit replace replaces first occurrence and returns the new body", async () => {
  const d = await createManuscript({ title: "W" });
  await setBody(d.id, "one two three");
  const r = await dispatchTool(
    "edit",
    { id: d.id, op: "replace", anchor: "two", text: "TWO" },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.source?.bodyMd).toBe("one TWO three");
  expect((await getBody(d.id))).toBe("one TWO three");
});

test("dispatchTool edit replace fails when anchor is absent (optimistic)", async () => {
  const d = await createManuscript({ title: "W2" });
  await setBody(d.id, "abc");
  const r = await dispatchTool(
    "edit",
    { id: d.id, op: "replace", anchor: "xyz", text: "nope" },
    ctxBase
  );
  expect(r.ok).toBe(false);
  expect(r.error).toContain("not found");
  expect((await getBody(d.id))).toBe("abc"); // unchanged
});

test("dispatchTool edit replace fixes over-escaped quotes in anchor", async () => {
  const d = await createManuscript({ title: "W3" });
  await setBody(d.id, 'Atlas: "Sevil mi?" dedi');
  const r = await dispatchTool(
    "edit",
    { id: d.id, op: "replace", anchor: '\\"Sevil mi?\\"', text: "OK" },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.source?.bodyMd).toBe("Atlas: OK dedi");
});

test("dispatchTool edit insert anchors after first match; empty anchor prepends", async () => {
  const d = await createManuscript({ title: "I" });
  await setBody(d.id, "head\nbody");
  const r1 = await dispatchTool(
    "edit",
    { id: d.id, op: "insert", anchor: "head", text: "\nmiddle" },
    ctxBase
  );
  expect(r1.ok).toBe(true);
  expect(r1.source?.bodyMd).toBe("head\nmiddle\nbody");

  const r2 = await dispatchTool(
    "edit",
    { id: d.id, op: "insert", anchor: "", text: "TOP\n" },
    ctxBase
  );
  expect(r2.ok).toBe(true);
  expect((await getBody(d.id))).toBe("TOP\nhead\nmiddle\nbody");
});

test("dispatchTool unknown tool returns ok=false", async () => {
  const r = await dispatchTool("nope_tool", {}, ctxBase);
  expect(r.ok).toBe(false);
  expect(r.error).toContain("unknown tool");
});

test("dispatchTool read resolves a citekey to its linked source", async () => {
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
  const byId = await dispatchTool("read", { id: sid }, ctxBase);
  expect(byId.ok).toBe(true);
  const byCitekey = await dispatchTool(
    "read",
    { id: "CiteKey2025" },
    ctxBase,
  );
  expect(byCitekey.ok).toBe(true);
  expect(byCitekey.rawContent).toContain("hello body");
  expect(
    (byCitekey.data as { pages: { given: number; total: number } }).pages,
  ).toEqual({ given: 1, total: 1 });
  const missing = await dispatchTool("read", { id: "nope" }, ctxBase);
  expect(missing.ok).toBe(false);
  expect(missing.error).toContain("citekey");
});

test("dispatchTool edit replace on a DB document updates the body", async () => {
  const d = await createManuscript({ title: "EditReplaceDoc" });
  await setBody(d.id, "foo bar baz");
  const r = await dispatchTool(
    "edit",
    { id: d.id, op: "replace", anchor: "bar", text: "BAR" },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.source?.bodyMd).toBe("foo BAR baz");
  expect((await getBody(d.id))).toBe("foo BAR baz");
});

test("dispatchTool edit insert on a DB document inserts after first match", async () => {
  const d = await createManuscript({ title: "EditInsertDoc" });
  await setBody(d.id, "head tail");
  const r = await dispatchTool(
    "edit",
    { id: d.id, op: "insert", anchor: "head", text: " MID" },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.source?.bodyMd).toBe("head MID tail");
  expect((await getBody(d.id))).toBe("head MID tail");
});

test("dispatchTool read returns a page on a document with data.pages.total", async () => {
  const body = "0123456789".repeat(100);
  const d = await createManuscript({ title: "WindowDoc" });
  await setBody(d.id, body);
  const r = await dispatchTool(
    "read",
    { id: d.id },
    ctxBase
  );
  expect(r.ok).toBe(true);
  expect(r.rawContent).toBe(body.slice(0, 4000));
  const pages = (r.data as { pages: { given: number; total: number } }).pages;
  expect(pages.given).toBe(1);
  expect(pages.total).toBe(Math.ceil(body.length / 4000));
});

test("dispatchTool list returns lean hits: filename===relPath and a string note", async () => {
  const project = (await import("../db")).getCurrentProject()!;
  const sid = "src-list-lean-test";
  project.db
    .prepare(
      `INSERT OR REPLACE INTO source_files
       (id, rel_path, filename, ext, kind, page_count, text_status, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sid, "papers/lean.pdf", "lean.pdf", "pdf", "pdf", 0, "done", 1700000003);
  const r = await dispatchTool("list", {}, ctxBase);
  expect(r.ok).toBe(true);
  const data = r.data as {
    count: number;
    corpusTotal: number;
    hits: Array<{ filename: string; note: string; size: number | null }>;
  };
  const hit = data.hits.find((h) => h.filename === "papers/lean.pdf");
  expect(hit).toBeTruthy();
  expect(typeof hit!.note).toBe("string");
  expect(hit!.note).toBe("");
});

test("dispatchTool retention: toast/show are ephemeral, list is keep", async () => {
  const toast = await dispatchTool(
    "toast",
    { action: "info", text: "hi" },
    ctxBase
  );
  expect(toast.retention).toBe("ephemeral");

  const d = await createManuscript({ title: "ShowRetentionDoc" });
  const show = await dispatchTool("show", { id: d.id }, ctxBase);
  expect(show.retention).toBe("ephemeral");

  const list = await dispatchTool("list", {}, ctxBase);
  expect(list.retention).toBe("keep");
});
