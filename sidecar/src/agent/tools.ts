// P5 agent tools — the `{domain}_{verb}` tool surface the LLM uses to read the
// corpus, read/write the manuscript, and trigger user-facing side-effects.
//
// Each tool is (a) advertised to the model via TOOL_SPECS (OpenAI function
// format) and (b) executed by `dispatchTool(name, args, ctx)`. Dispatch returns
// a {@link ToolResult}: a short `summary` for the chat narration + a JSON
// `data` payload that becomes the tool-result message the model sees next.
//
// Domains (DESIGN.md §10):
//   corpus_* — the reference index (metadata + vector search)
//   doc_*    — source bundles (read-only)
//   p_*      — the manuscript (read/write; content-addressed via oldtext/anchor)
//   gui_*    — user-facing side-effects (relayed as `gui` SSE events; no pause)
//
// Manuscript addressing: one document = one body_md blob (no sections). Writes
// are CONTENT-ADDRESSED: `p_write` replaces the first occurrence of `oldtext`;
// `p_insert` inserts after the first occurrence of `anchor`. This makes the
// optimistic-concurrency check explicit (oldtext must still be present) without
// line numbers that drift as the body changes.

import type { GuiEvent, Reference } from "@dissertator/shared";
import type { ToolSpec } from "../chat/openai.ts";
import {
  createDocument,
  getDocument,
  getReferenceById,
  listReferences,
  getSourceById,
  getSourceText,
  updateDocument,
  upsertReference,
} from "../db.ts";
import { searchCorpus } from "../search.ts";

/** Per-run context handed to every tool. */
export interface ToolContext {
  /** Embedding API key (corpus_list vector search). Bearer-only, never logged. */
  embeddingApiKey?: string;
  /** The document the user is editing — default `id` for p_* tools. */
  activeDocumentId?: string;
  /** Relay a gui_* side-effect to the frontend (SSE `gui` event). */
  emitGui: (e: GuiEvent) => void;
}

/** Outcome of a tool call. `summary` is chat-narration; `data` is the model's
 *  observation. `document` (set by mutating p_* tools) lets the loop emit a
 *  live `edit` SSE event so the editor refreshes. */
export interface ToolResult {
  ok: boolean;
  summary: string;
  data?: unknown;
  error?: string;
  /** Present when a p_* tool mutated a document — the loop emits `edit`. */
  document?: { id: string; title: string; bodyMd: string };
}

// ---------------------------------------------------------------------------
// Tool advertisements (OpenAI function specs).
// ---------------------------------------------------------------------------

export const TOOL_SPECS: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "corpus_list",
      description:
        "Search the reference index. With `query`: semantic (vector) search " +
        "over the embedded corpus. Without `query`: list/filter references by " +
        "author or title substring. Returns ≤20 hits with short metadata only " +
        "(id, citekey, title, authors, year, sourceFileId). Use doc_read for " +
        "a source's full text.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic search query." },
          author: { type: "string", description: "Author surname substring." },
          title: { type: "string", description: "Title substring." },
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
      name: "corpus_write",
      description:
        "Update a reference's metadata (title/authors/year/doi). The citekey " +
        "is frozen and never changes. Use for cleaning up import errors.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Reference id." },
          title: { type: "string" },
          year: { type: "integer" },
          doi: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "doc_read",
      description:
        "Read a source bundle's extracted text (read-only). Returns the text, " +
        "page-tagged as [p.N]. Optionally filter to one page. Truncated past " +
        "~12k chars (pass `page` to page through).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Source-file id." },
          page: { type: "integer", description: "Optional physical page." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "p_read",
      description:
        "Read the manuscript body (markdown). `id` defaults to the document " +
        "the user is currently editing. Returns title + full body_md.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document id (default: active)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "p_create",
      description:
        "Create a new manuscript document with a title (and optional initial " +
        "body text). Returns the new document id. Follow with gui_p_open to " +
        "show it to the user.",
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
      name: "p_write",
      description:
        "Replace the FIRST occurrence of `oldtext` in the manuscript body with " +
        "`text`. `oldtext` must be present verbatim (optimistic-concurrency " +
        "check) — if the user edited the body, this fails and you should " +
        "p_read again. `id` defaults to the active document.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document id (default: active)." },
          oldtext: {
            type: "string",
            description: "Exact existing text to replace (must be present).",
          },
          text: { type: "string", description: "The replacement text." },
        },
        required: ["oldtext", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "p_insert",
      description:
        "Insert `text` immediately AFTER the first occurrence of `anchor` in " +
        "the manuscript body. `anchor` must be present verbatim. Omit/empty " +
        "`anchor` to prepend at the very top. `id` defaults to the active " +
        "document.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document id (default: active)." },
          anchor: {
            type: "string",
            description: "Existing text to insert after (empty = top).",
          },
          text: { type: "string", description: "Text to insert." },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gui_doc_open",
      description: "Open a source file in the user's viewer (pdf.js / text).",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "Source-file id." } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gui_p_open",
      description:
        "Open a manuscript document in the editor. `id` defaults to the active.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Document id (default: active)." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gui_options",
      description:
        "Show the user quick-reply option buttons. The run does NOT pause — " +
        "clicking a button sends its `prompt` as the user's next message. Use " +
        "for 'pick one of these directions' moments.",
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
      name: "gui_action",
      description:
        "Non-blocking narration beat (toast). Use sparingly for milestones: " +
        "celebrate a finished draft, warn before a risky edit, info otherwise.",
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
];

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Cap on doc_read text returned to the model (keeps context window sane). */
const DOC_READ_CAP = 12000;

/** Format a reference as the short metadata shape returned by corpus_list. */
function refShort(r: Reference): Record<string, unknown> {
  return {
    id: r.id,
    citekey: r.citekey,
    title: r.title,
    authors: r.authors.map((a) => [a.given, a.family].filter(Boolean).join(" ")),
    year: r.year,
    sourceFileId: r.source_file_id,
  };
}

/** Slice a page-tagged source text to one physical page (if present). */
function slicePage(text: string, page: number): string {
  // Segments look like "[p.12] ...text... [p.13] ...". Split keeping tags.
  const parts = text.split(/(?=\[p\.\d+\])/);
  const want = `[p.${page}]`;
  const seg = parts.find((p) => p.startsWith(want));
  return seg ?? "";
}

/** Resolve the document id for a p_* tool (explicit id wins, else active). */
function resolveDocId(
  args: { id?: string },
  ctx: ToolContext
): string | null {
  return args.id?.trim() || ctx.activeDocumentId || null;
}

// ---------------------------------------------------------------------------
// Dispatch.
// ---------------------------------------------------------------------------

/**
 * Execute one tool call. `args` is the already-parsed arguments object (the
 * loop handles JSON parse errors). Unknown tool names return ok=false with a
 * clear error so the model can self-correct on the next turn.
 */
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | null,
  ctx: ToolContext
): Promise<ToolResult> {
  const a = args ?? {};
  try {
    switch (name) {
      case "corpus_list":
        return await corpusList(a, ctx);
      case "corpus_write":
        return await corpusWrite(a);
      case "doc_read":
        return await docRead(a);
      case "p_read":
        return await pRead(a, ctx);
      case "p_create":
        return await pCreate(a);
      case "p_write":
        return await pWrite(a, ctx);
      case "p_insert":
        return await pInsert(a, ctx);
      case "gui_doc_open":
        return guiDocOpen(a, ctx);
      case "gui_p_open":
        return guiPOpen(a, ctx);
      case "gui_options":
        return guiOptions(a, ctx);
      case "gui_action":
        return guiAction(a, ctx);
      default:
        return { ok: false, summary: `Unknown tool: ${name}`, error: `unknown tool: ${name}` };
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e);
    return { ok: false, summary: `⚠️ ${name} failed`, error: msg };
  }
}

async function corpusList(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = (args.query as string | undefined)?.trim();
  const limit = Math.min(20, Math.max(1, (args.limit as number) || 10));
  let refs: Reference[];
  if (query) {
    // Semantic vector search. searchCorpus returns chunk-level hits keyed by
    // source_file_id; we resolve those to reference rows for a uniform short
    // shape (and de-dup by reference).
    const res = await searchCorpus(query, {
      apiKey: ctx.embeddingApiKey,
      limit,
    });
    const bySrc = new Map<string, Reference>();
    for (const r of listReferences()) {
      if (r.source_file_id) bySrc.set(r.source_file_id, r);
    }
    const seen = new Set<string>();
    refs = [];
    for (const h of res.hits) {
      const r = h.sourceId ? bySrc.get(h.sourceId) : undefined;
      if (!r || seen.has(r.id)) continue;
      seen.add(r.id);
      refs.push(r);
      if (refs.length >= limit) break;
    }
  } else {
    const author = (args.author as string | undefined)?.toLowerCase();
    const title = (args.title as string | undefined)?.toLowerCase();
    refs = listReferences().filter((r) => {
      if (
        author &&
        !r.authors.some((a) =>
          `${a.family ?? ""} ${a.given ?? ""}`.toLowerCase().includes(author)
        )
      )
        return false;
      if (title && !(r.title ?? "").toLowerCase().includes(title)) return false;
      return true;
    });
    refs = refs.slice(0, limit);
  }
  return {
    ok: true,
    summary: `🔍 ${query ? `Searched "${query}"` : "Listed corpus"} → ${refs.length} hit${refs.length === 1 ? "" : "s"}`,
    data: { count: refs.length, hits: refs.map(refShort) },
  };
}

async function corpusWrite(args: Record<string, unknown>): Promise<ToolResult> {
  const id = (args.id as string)?.trim();
  if (!id) return { ok: false, summary: "corpus_write: id required", error: "id required" };
  const existing = getReferenceById(id);
  if (!existing) return { ok: false, summary: "corpus_write: not found", error: `reference ${id} not found` };
  const patch: Partial<Reference> = { id };
  if (typeof args.title === "string") patch.title = args.title;
  if (typeof args.year === "number") patch.year = args.year;
  if (typeof args.doi === "string") patch.doi = args.doi;
  const updated = upsertReference(patch);
  return {
    ok: true,
    summary: `✏️ Updated reference @${updated.citekey}`,
    data: refShort(updated),
  };
}

async function docRead(args: Record<string, unknown>): Promise<ToolResult> {
  const id = (args.id as string)?.trim();
  if (!id) return { ok: false, summary: "doc_read: id required", error: "id required" };
  const src = getSourceById(id);
  if (!src) return { ok: false, summary: "doc_read: not found", error: `source ${id} not found` };
  const { text, pageCount } = getSourceText(id);
  const page = args.page as number | undefined;
  const body = page ? slicePage(text, page) : text;
  const capped = body.length > DOC_READ_CAP;
  const shown = capped ? body.slice(0, DOC_READ_CAP) : body;
  return {
    ok: true,
    summary: `📖 Read ${src.filename}${page ? ` p.${page}` : ""}${capped ? " (truncated)" : ""}`,
    data: {
      filename: src.filename,
      pageCount,
      ...(page ? { page } : {}),
      truncated: capped,
      text: shown,
    },
  };
}

async function pRead(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const id = resolveDocId(args as { id?: string }, ctx);
  if (!id) return { ok: false, summary: "p_read: no document id", error: "no document id (pass `id` or open a document)" };
  const doc = getDocument(id);
  if (!doc) return { ok: false, summary: "p_read: not found", error: `document ${id} not found` };
  return {
    ok: true,
    summary: `📄 Read manuscript "${doc.title}"`,
    data: { id: doc.id, title: doc.title, bodyMd: doc.bodyMd },
  };
}

async function pCreate(args: Record<string, unknown>): Promise<ToolResult> {
  const title = (args.title as string)?.trim();
  if (!title) return { ok: false, summary: "p_create: title required", error: "title required" };
  const text = typeof args.text === "string" ? args.text : "";
  const doc = createDocument({ title });
  const updated = text ? updateDocument(doc.id, { bodyMd: text }) : doc;
  const fin = updated ?? doc;
  return {
    ok: true,
    summary: `📄 Created manuscript "${fin.title}"`,
    data: { id: fin.id, title: fin.title, bodyMd: fin.bodyMd },
    document: { id: fin.id, title: fin.title, bodyMd: fin.bodyMd },
  };
}

async function pWrite(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const id = resolveDocId(args as { id?: string }, ctx);
  if (!id) return { ok: false, summary: "p_write: no document id", error: "no document id (pass `id` or open a document)" };
  const oldtext = args.oldtext as string | undefined;
  const text = args.text as string | undefined;
  if (oldtext === undefined || text === undefined)
    return { ok: false, summary: "p_write: oldtext + text required", error: "oldtext and text required" };
  const doc = getDocument(id);
  if (!doc) return { ok: false, summary: "p_write: not found", error: `document ${id} not found` };
  const idx = doc.bodyMd.indexOf(oldtext);
  if (idx === -1) {
    return {
      ok: false,
      summary: `⚠️ p_write: oldtext not found (body changed?)`,
      error: "oldtext not found in body — the user may have edited it; p_read again",
    };
  }
  const next = doc.bodyMd.slice(0, idx) + text + doc.bodyMd.slice(idx + oldtext.length);
  const updated = updateDocument(id, { bodyMd: next });
  if (!updated) return { ok: false, summary: "p_write: update failed", error: "update returned null" };
  return {
    ok: true,
    summary: `✏️ Replaced text in "${updated.title}"`,
    data: { id: updated.id, title: updated.title, ok: true },
    document: { id: updated.id, title: updated.title, bodyMd: updated.bodyMd },
  };
}

async function pInsert(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const id = resolveDocId(args as { id?: string }, ctx);
  if (!id) return { ok: false, summary: "p_insert: no document id", error: "no document id (pass `id` or open a document)" };
  const text = args.text as string | undefined;
  if (text === undefined) return { ok: false, summary: "p_insert: text required", error: "text required" };
  const anchor = typeof args.anchor === "string" ? args.anchor : "";
  const doc = getDocument(id);
  if (!doc) return { ok: false, summary: "p_insert: not found", error: `document ${id} not found` };
  let next: string;
  if (!anchor.trim()) {
    // Empty anchor → prepend at the very top.
    next = text + (text.endsWith("\n") ? "" : "\n") + doc.bodyMd;
  } else {
    const idx = doc.bodyMd.indexOf(anchor);
    if (idx === -1) {
      return {
        ok: false,
        summary: `⚠️ p_insert: anchor not found`,
        error: "anchor not found in body — p_read to see current text",
      };
    }
    const insertAt = idx + anchor.length;
    next = doc.bodyMd.slice(0, insertAt) + text + doc.bodyMd.slice(insertAt);
  }
  const updated = updateDocument(id, { bodyMd: next });
  if (!updated) return { ok: false, summary: "p_insert: update failed", error: "update returned null" };
  return {
    ok: true,
    summary: `✏️ Inserted text into "${updated.title}"`,
    data: { id: updated.id, title: updated.title, ok: true },
    document: { id: updated.id, title: updated.title, bodyMd: updated.bodyMd },
  };
}

function guiDocOpen(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const id = (args.id as string)?.trim();
  if (!id) return { ok: false, summary: "gui_doc_open: id required", error: "id required" };
  const src = getSourceById(id);
  ctx.emitGui({ kind: "doc_open", sourceId: id });
  return { ok: true, summary: `📂 Opened source "${src?.filename ?? id}"`, data: { opened: true } };
}

function guiPOpen(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const id = resolveDocId(args as { id?: string }, ctx);
  if (!id) return { ok: false, summary: "gui_p_open: no document id", error: "no document id" };
  const doc = getDocument(id);
  ctx.emitGui({ kind: "p_open", documentId: id });
  return { ok: true, summary: `📂 Opened manuscript "${doc?.title ?? id}"`, data: { opened: true } };
}

function guiOptions(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const raw = Array.isArray(args.options) ? args.options : [];
  const options = raw
    .filter((o): o is { short: string; prompt: string } =>
      o && typeof o === "object" && typeof (o as { short?: unknown }).short === "string" && typeof (o as { prompt?: unknown }).prompt === "string"
    )
    .slice(0, 5)
    .map((o) => ({ short: o.short, prompt: o.prompt }));
  if (options.length === 0)
    return { ok: false, summary: "gui_options: no valid options", error: "options must be a non-empty array of {short, prompt}" };
  ctx.emitGui({ kind: "options", options });
  return { ok: true, summary: `🔘 Offered ${options.length} option${options.length === 1 ? "" : "s"}`, data: { offered: options.length } };
}

function guiAction(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const action = args.action as "warn" | "celebrate" | "info" | undefined;
  const text = args.text as string | undefined;
  if (!action || !text) return { ok: false, summary: "gui_action: action + text required", error: "action and text required" };
  if (action !== "warn" && action !== "celebrate" && action !== "info")
    return { ok: false, summary: "gui_action: bad action", error: `action must be warn|celebrate|info` };
  ctx.emitGui({ kind: "action", action, text });
  return { ok: true, summary: `${action === "celebrate" ? "🎉" : action === "warn" ? "⚠️" : "ℹ️"} ${text}`, data: { narrated: true } };
}
