import type { GuiEvent, Reference, SourceFile } from "@dissertator/shared";
import type { ToolSpec } from "../chat/openai.ts";
import {
  createManuscript,
  getReferenceByCitekey,
  listReferences,
  getSourceById,
  getSourceText,
} from "../db";
import { listSources, readSourceMarkdown, writeSourceMarkdown } from "../ingest/index.ts";
import { searchCorpus } from "../search.ts";
import { appendPreference } from "../agent-files.ts";

function looseIndex(body: string, needle: string): { idx: number; len: number } {
  const exact = body.indexOf(needle);
  if (exact !== -1) return { idx: exact, len: needle.length };
  const relaxed = needle.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (relaxed !== needle) {
    const alt = body.indexOf(relaxed);
    if (alt !== -1) return { idx: alt, len: relaxed.length };
  }
  return { idx: -1, len: 0 };
}

export interface ToolContext {
  embeddingApiKey?: string;
  activeSourceId?: string;
  emitGui: (e: GuiEvent) => void;
}

export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  rawContent?: string;
  retention?: "default" | "keep" | "ephemeral";
  source?: { id: string; title: string; bodyMd: string };
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "list",
      description:
        "List/search the corpus. With `query`: search over embedded chunks. " +
        "Without `query`: list source files, optionally filtered by `filename`/`author`/`title`. " +
        "Each hit carries `filename` (the relative path — also the handle `read`/" +
        "`show` take), `size`, and `note`; bibliographic fields (`title`, " +
        "`authors`, `year`, `citekey`) appear ONLY when a reference exists.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic search query (vector)." },
          filename: { type: "string", description: "Filename substring (no-query listing filter)." },
          author: { type: "string", description: "Author surname substring (reference-based; no effect when no references exist)." },
          title: { type: "string", description: "Title substring (reference-based; no effect when no references exist)." },
          limit: {
            type: "integer",
            description: "Max hits (1–20).",
            minimum: 1,
            maximum: 20,
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read",
      description:
        "Read a file. `id` resolves via filename, source id, or citekey; omit for the active manuscript. `page` (default 1) selects the page; use the returned `pages.total` to page through.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "filename.",},
          page: {
            type: "integer",
            description: "Page number",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create",
      description:
        "Create a new manuscript with a `title` and optional initial `text`. Returns its id; follow with `show` to display it to user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          text: {
            type: "string",
            description: "Optional initial body markdown.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit",
      description:
        "Edit a `.md` source (content-addressed). `op`=\"replace\": swap the first verbatim `anchor` for `text`. `op`=\"insert\": add `text` after the first `anchor` (empty/omitted `anchor` = top). `id` resolves via filename, source id, or citekey; omit for the active manuscript. Non-markdown sources aren't editable. If `anchor` isn't found, `read` again.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "filename.",
          },
          op: {
            type: "string",
            enum: ["replace", "insert"],
            description: "replace = swap first anchor match; insert = add text after first anchor match (or top if anchor empty/omitted).",
          },
          anchor: {
            type: "string",
            description: "Existing text to replace (op=replace) or insert after (op=insert). Required for replace; empty/omitted = top for insert.",
          },
          text: { type: "string", description: "Replacement (replace) or new (insert) text." },
        },
        required: ["op", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show",
      description:
        "Open a source in the user's UI. id is filename.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "filename",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "suggest",
      description:
        "Offer quick-reply buttons to close your turn (2–4 concrete next steps). The run does not pause; a click sends the button's `prompt` as the next user message. Call at the end of every turn.",
      parameters: {
        type: "object",
        properties: {
          options: {
            type: "array",
            description: "2–5 options.",
            items: {
              type: "object",
              properties: {
                short: { type: "string", description: "Button label." },
                prompt: { type: "string", description: "Sent on click." },
              },
              required: ["short", "prompt"],
            },
          },
        },
        required: ["options"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "toast",
      description:
        "Non-blocking toast for milestones: `celebrate` a finished draft, `warn` before a risky edit, `info` otherwise.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["warn", "celebrate", "info"],
          },
          text: { type: "string" },
        },
        required: ["action", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pref_add",
      description:
        "Append ONE durable user preference/correction as a bullet (read into every future chat). Call only for lasting " +
        "preferences (tone, format, citation style, workflow, hard constraint) — never one-offs. Append-only; keep `text` to one line.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description: "One concise preference bullet (no leading dash).",
          },
        },
        required: ["text"],
      },
    },
  },
];

type Handle =
  | { kind: "source"; source: SourceFile }
  | { kind: "non-md-source"; source: SourceFile };

function resolveHandle(h: string): Handle | null {
  if (!h) return null;
  const byId = getSourceById(h);
  if (byId) return mdOrNot(byId);
  const lc = h.replace(/\\/g, "/").toLowerCase();
  const lcMd = lc.endsWith(".md") ? lc : lc + ".md";
  const sources = listSources();
  const match = sources.find((s) => {
    const rel = s.relPath.replace(/\\/g, "/").toLowerCase();
    const fn = s.filename.replace(/\\/g, "/").toLowerCase();
    return rel === lc || rel === lcMd || fn === lc || fn === lcMd;
  });
  if (match) return mdOrNot(match);
  const ref = getReferenceByCitekey(h);
  if (ref?.source_file_id) {
    const s = getSourceById(ref.source_file_id);
    if (s) return mdOrNot(s);
  }
  return null;
}

function mdOrNot(
  s: SourceFile,
): Handle | { kind: "non-md-source"; source: SourceFile } {
  return (s.mimeType ?? "").toLowerCase() === "text/markdown"
    ? { kind: "source", source: s }
    : { kind: "non-md-source", source: s };
}

async function mutateBody(
  target: Handle,
  ctx: ToolContext,
  summaryFor: (name: string) => string,
  transform: (
    body: string,
  ) => { next: string } | { error: string },
): Promise<ToolResult> {
  if (target.kind === "non-md-source") {
    return { ok: false, summary: "⚠️ not editable", error: `${target.source.filename} is not a markdown file; only manuscripts and .md sources are editable` };
  }
  let body: string;
  try {
    body = await readSourceMarkdown(target.source);
  } catch (e) {
    return { ok: false, summary: "⚠️ read failed", error: (e as Error)?.message ?? String(e) };
  }
  const res = transform(body);
  if ("error" in res) return { ok: false, summary: "⚠️ edit failed", error: res.error };
  try {
    await writeSourceMarkdown(target.source, res.next);
  } catch (e) {
    return { ok: false, summary: "⚠️ write failed", error: (e as Error)?.message ?? String(e) };
  }
  const title = target.source.filename.replace(/\.[^.]+$/, "");
  return {
    ok: true,
    summary: summaryFor(title),
    data: { id: target.source.id, title, ok: true, bodyMd: res.next },
    source: { id: target.source.id, title, bodyMd: res.next },
  };
}

const DOC_READ_CAP = 12000;
const BODY_PAGE_SIZE = 4000;

interface ListHit {
  filename: string;
  size: number | null;
  title?: string;
  authors?: string[];
  year?: number;
  citekey?: string;
  note: string;
}

function hitFromSource(s: SourceFile, r?: Reference): ListHit {
  const h: ListHit = {
    filename: s.relPath,
    size: s.fileSize,
    note: s.note ?? "",
  };
  if (r) {
    h.citekey = r.citekey;
    if (typeof r.title === "string") h.title = r.title;
    h.authors = r.authors.map((a) =>
      [a.given, a.family].filter(Boolean).join(" ")
    );
    if (typeof r.year === "number") h.year = r.year;
  }
  return h;
}

function slicePage(text: string, page: number): string {
  const parts = text.split(/(?=\[p\.\d+\])/);
  const want = `[p.${page}]`;
  const seg = parts.find((p) => p.startsWith(want));
  return seg ?? "";
}

export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | null,
  ctx: ToolContext
): Promise<ToolResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "list":
        return await listTool(a, ctx);
      case "read":
        return await readTool(a, ctx);
      case "create":
        return await createTool(a);
      case "edit":
        return await editTool(a, ctx);
      case "show":
        return showTool(a, ctx);
      case "suggest":
        return suggestTool(a, ctx);
      case "toast":
        return toastTool(a, ctx);
      case "pref_add":
        return await prefAdd(a);
      default:
        return { ok: false, summary: `Unknown tool: ${name}`, error: `unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { ok: false, summary: `⚠️ ${name} failed`, error: msg };
  }
}

async function listTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = (args.query as string | undefined)?.trim();
  const limit = Math.min(20, Math.max(1, (args.limit as number) || 10));

  const allSources = listSources();
  const refBySrc = new Map<string, Reference>();
  for (const r of listReferences()) {
    if (r.source_file_id) refBySrc.set(r.source_file_id, r);
  }

  if (query) {
    const res = await searchCorpus(query, {
      apiKey: ctx.embeddingApiKey,
      limit: limit * 4,
    });
    const srcById = new Map(allSources.map((s) => [s.id, s] as const));
    const hits: ListHit[] = [];
    const seen = new Set<string>();
    for (const h of res.hits) {
      if (seen.has(h.sourceId)) continue;
      const s = srcById.get(h.sourceId);
      if (!s) continue;
      seen.add(h.sourceId);
      hits.push(hitFromSource(s, refBySrc.get(h.sourceId)));
      if (hits.length >= limit) break;
    }
    const plural = (n: number) => (n === 1 ? "" : "s");
    const summary =
      hits.length === 0
        ? res.embedded
          ? `🔍 Searched "${query}" → 0 semantic hits (corpus has ${allSources.length} source${plural(allSources.length)}; list without query, or read by filename)`
          : `🔍 Searched "${query}" → corpus not embedded yet (${allSources.length} source${plural(allSources.length)} present; embed first, or list without query)`
        : `🔍 Searched "${query}" → ${hits.length} semantic hit${plural(hits.length)}`;
    return {
      ok: true,
      summary,
      retention: "keep",
      data: { count: hits.length, corpusTotal: allSources.length, hits },
    };
  }

  const filename = (args.filename as string | undefined)?.toLowerCase().trim();
  const author = (args.author as string | undefined)?.toLowerCase().trim();
  const title = (args.title as string | undefined)?.toLowerCase().trim();
  const refsAvailable = refBySrc.size > 0;
  const matched = allSources.filter((s) => {
    if (filename && !s.filename.toLowerCase().includes(filename)) return false;
    if (refsAvailable && (author || title)) {
      const r = refBySrc.get(s.id);
      if (
        author &&
        !(r?.authors.some((a) =>
          `${a.family ?? ""} ${a.given ?? ""}`.toLowerCase().includes(author)
        ))
      )
        return false;
      if (title && !((r?.title ?? "").toLowerCase().includes(title))) return false;
    }
    return true;
  });
  const hits = matched
    .slice(0, limit)
    .map((s) => hitFromSource(s, refBySrc.get(s.id)));
  const plural = (n: number) => (n === 1 ? "" : "s");
  return {
    ok: true,
    summary: `📚 Listed corpus → ${hits.length} source${plural(hits.length)} (of ${allSources.length})`,
    retention: "keep",
    data: { count: hits.length, corpusTotal: allSources.length, hits },
  };
}

async function readTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = (args.id as string | undefined)?.trim();
  const wantPage =
    (typeof args.page === "number" ? args.page : 1) || 1;

  let handle: Handle;
  if (raw) {
    const h = resolveHandle(raw);
    if (!h) {
      return {
        ok: false,
        summary: "read: not found",
        error: `id ${raw} not found (pass a source-file id, filename, or citekey)`,
      };
    }
    handle = h;
  } else {
    if (!ctx.activeSourceId) {
      return { ok: false, summary: "read: no id", error: "no id (pass `id`, or open a source)" };
    }
    const src = getSourceById(ctx.activeSourceId);
    if (!src) {
      return { ok: false, summary: "read: active missing", error: `active manuscript ${ctx.activeSourceId} not found` };
    }
    handle = mdOrNot(src);
  }

  if (handle.kind === "non-md-source" && (handle.source.pageCount ?? 0) > 0) {
    const { text, pageCount } = getSourceText(handle.source.id);
    const total = pageCount;
    const page = Math.min(Math.max(1, wantPage), total);
    let shown = slicePage(text, page);
    const truncated = shown.length > DOC_READ_CAP;
    if (truncated) shown = shown.slice(0, DOC_READ_CAP);
    return {
      ok: true,
      summary: `📖 Read ${handle.source.filename} p.${page}${truncated ? " (truncated)" : ""}`,
      retention: "default",
      data: {
        filename: handle.source.filename,
        pages: { given: page, total },
        truncated,
      },
      rawContent: shown,
    };
  }

  let text: string;
  if (handle.kind === "source") {
    try {
      text = await readSourceMarkdown(handle.source);
    } catch (e) {
      return { ok: false, summary: "read: read failed", error: (e as Error)?.message ?? String(e) };
    }
  } else {
    text = getSourceText(handle.source.id).text;
  }

  const total = Math.max(1, Math.ceil(text.length / BODY_PAGE_SIZE));
  const page = Math.min(Math.max(1, wantPage), total);
  let shown = text.slice((page - 1) * BODY_PAGE_SIZE, page * BODY_PAGE_SIZE);
  const truncated = shown.length > DOC_READ_CAP;
  if (truncated) shown = shown.slice(0, DOC_READ_CAP);

  return {
    ok: true,
    summary: `📄 Read "${handle.source.filename}" p.${page}/${total}`,
    retention: "default",
    data: {
      filename: handle.source.filename,
      pages: { given: page, total },
      truncated,
    },
    rawContent: shown,
  };
}

async function createTool(args: Record<string, unknown>): Promise<ToolResult> {
  const title = (args.title as string)?.trim();
  if (!title) return { ok: false, summary: "create: title required", error: "title required" };
  const text = typeof args.text === "string" ? args.text : "";
  const src = await createManuscript({ title, bodyMd: text });
  const t = src.filename.replace(/\.[^.]+$/, "");
  return {
    ok: true,
    summary: `📄 Created manuscript "${t}"`,
    retention: "default",
    data: { id: src.id, title: t, bodyMd: text },
    source: { id: src.id, title: t, bodyMd: text },
  };
}

async function editTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const op = args.op as "replace" | "insert" | undefined;
  if (op !== "replace" && op !== "insert")
    return { ok: false, summary: "edit: bad op", error: "op must be replace|insert" };
  const text = args.text as string | undefined;
  if (text === undefined) return { ok: false, summary: "edit: text required", error: "text required" };
  const anchor = typeof args.anchor === "string" ? args.anchor : "";
  const raw = (args.id as string | undefined)?.trim();
  let target: Handle;
  if (raw) {
    const h = resolveHandle(raw);
    if (!h) return { ok: false, summary: "edit: not found", error: `id ${raw} not found` };
    target = h;
  } else {
    if (!ctx.activeSourceId) return { ok: false, summary: "edit: no id", error: "no id (pass `id`, or open a source)" };
    const src = getSourceById(ctx.activeSourceId);
    if (!src) return { ok: false, summary: "edit: active missing", error: `active manuscript ${ctx.activeSourceId} not found` };
    target = mdOrNot(src);
  }
  const summaryFor = (n: string) =>
    op === "replace" ? `✏️ Replaced text in "${n}"` : `✏️ Inserted text into "${n}"`;
  return mutateBody(target, ctx, summaryFor, (body) => {
    if (op === "replace") {
      if (!anchor) return { error: "anchor required for replace" };
      const { idx, len } = looseIndex(body, anchor);
      if (idx === -1) return { error: "anchor not found in body — the user may have edited it; read again" };
      return { next: body.slice(0, idx) + text + body.slice(idx + len) };
    }
    if (!anchor.trim()) {
      return { next: text + (text.endsWith("\n") ? "" : "\n") + body };
    }
    const { idx, len } = looseIndex(body, anchor);
    if (idx === -1) return { error: "anchor not found in body — read to see current text" };
    const insertAt = idx + len;
    return { next: body.slice(0, insertAt) + text + body.slice(insertAt) };
  });
}

function showTool(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const raw = (args.id as string | undefined)?.trim();
  if (!raw) return { ok: false, summary: "show: id required", error: "id required" };
  const h = resolveHandle(raw);
  if (!h) return { ok: false, summary: "show: not found", error: `id ${raw} not found` };
  ctx.emitGui({ kind: "open", sourceId: h.source.id });
  const label = h.source.filename.replace(/\.[^.]+$/, "");
  return { ok: true, summary: `📂 Opened "${label}"`, retention: "ephemeral", data: { opened: true } };
}

function suggestTool(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw
    .filter((o): o is { short: string; prompt: string } =>
      o && typeof o === "object" && typeof (o as { short?: unknown }).short === "string" && typeof (o as { prompt?: unknown }).prompt === "string"
    )
    .slice(0, 5)
    .map((o) => ({ short: o.short, prompt: o.prompt }));
  if (options.length === 0)
    return { ok: false, summary: "suggest: no valid options", error: "options must be a non-empty array of {short, prompt}" };
  ctx.emitGui({ kind: "suggest_replies", options });
  return { ok: true, summary: `🔘 Offered ${options.length} option${options.length === 1 ? "" : "s"}`, retention: "ephemeral", data: { offered: options.length } };
}

function toastTool(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const action = args.action as "warn" | "celebrate" | "info" | undefined;
  const text = args.text as string | undefined;
  if (!action || !text) return { ok: false, summary: "toast: action + text required", error: "action and text required" };
  if (action !== "warn" && action !== "celebrate" && action !== "info")
    return { ok: false, summary: "toast: bad action", error: `action must be warn|celebrate|info` };
  ctx.emitGui({ kind: "action", action, text });
  return { ok: true, summary: `${action === "celebrate" ? "🎉" : action === "warn" ? "⚠️" : "ℹ️"} ${text}`, retention: "ephemeral", data: { narrated: true } };
}

async function prefAdd(args: Record<string, unknown>): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return { ok: false, summary: "pref_add: text required", error: "text required" };
  await appendPreference(text);
  return { ok: true, summary: `📝 Noted preference`, retention: "ephemeral", data: { recorded: true } };
}
