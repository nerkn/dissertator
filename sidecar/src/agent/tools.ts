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

import type { GuiEvent, Reference, SourceFile } from "@dissertator/shared";
import type { ToolSpec } from "../chat/openai.ts";
import {
  createDocument,
  getDocument,
  getReferenceByCitekey,
  getReferenceById,
  listReferences,
  getSourceById,
  getSourceText,
  updateDocument,
  upsertReference,
} from "../db";
import { listSources } from "../ingest/index.ts";
import { searchCorpus } from "../search.ts";
import { appendPreference } from "../agent-files.ts";

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
        "List/search the CORPUS (your ingested source files). With `query`: " +
        "semantic (vector) search over embedded chunks — each hit is a source " +
        "file plus its best-matching `snippet`, `physicalPage`, and `score`. " +
        "Without `query`: list source files, optionally filtered by `filename` " +
        "substring. Every hit ALWAYS carries `sourceFileId` + `filename` (+ " +
        "`kind`, `relPath`) so you can call doc_read(sourceFileId) next; " +
        "`snippet`/`physicalPage`/`score` appear ONLY on semantic hits. " +
        "Bibliographic fields (`citekey`, `authors`, `year`) are overlaid ONLY " +
        "when a reference has been curated for that source — their ABSENCE " +
        "does NOT mean the source is missing, only that no citation metadata " +
        "exists yet. Use doc_read(sourceFileId) for a source's full text.",
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
      name: "corpus_write",
      description:
        "Update a reference's metadata (title/authors/year/doi). The citekey " +
        "is regenerated from author/year/title; existing `[@citekey]` tokens " +
        "in manuscripts are rewritten to match. Use for cleaning up import errors.",
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
        "~12k chars (pass `page` to page through). `id` accepts a source-file " +
        "id OR a citekey (e.g. from the corpus index).",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Source-file id or citekey." },
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
  {
    type: "function",
    function: {
      name: "pref_add",
      description:
        "Record ONE durable user preference or correction as a single bullet in " +
        "the project's preferences file (read into every future chat). Call ONLY " +
        "when the user states a lasting preference (tone, format, citation style, " +
        "workflow, hard constraint) — NEVER for one-off or transient requests. " +
        "You cannot delete or rewrite; you only append. Keep `text` to one concise " +
        "line.",
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

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

/** Cap on doc_read text returned to the model (keeps context window sane). */
const DOC_READ_CAP = 12000;

/** Format a reference as the short metadata shape returned by corpus_write. */
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

/**
 * A corpus hit: one source file, optionally enriched with the semantic match
 * (`snippet`/`physicalPage`/`score` — present only on `query` hits) and/or
 * curated reference metadata (`citekey`/`authors`/`year` — present only when a
 * `references` row exists for this source_file_id). `sourceFileId` +
 * `filename` are ALWAYS present so the model can call doc_read next.
 */
interface CorpusHit {
  sourceFileId: string;
  filename: string;
  relPath: string;
  kind: string;
  /** Semantic-only (present on `query` hits): */
  score?: number;
  physicalPage?: number | null;
  printedPage?: string | null;
  snippet?: string;
  /** Reference overlay (present only when a reference row exists): */
  referenceId?: string;
  citekey?: string;
  title?: string;
  authors?: string[];
  year?: number;
}

/** Build a base CorpusHit from a source file (+ optional reference overlay). */
function hitFromSource(s: SourceFile, r?: Reference): CorpusHit {
  const h: CorpusHit = {
    sourceFileId: s.id,
    filename: s.filename,
    relPath: s.relPath,
    kind: s.kind,
  };
  if (r) {
    h.referenceId = r.id;
    h.citekey = r.citekey;
    if (typeof r.title === "string") h.title = r.title;
    h.authors = r.authors.map((a) =>
      [a.given, a.family].filter(Boolean).join(" ")
    );
    if (typeof r.year === "number") h.year = r.year;
  }
  return h;
}

/** Resolve a source id from either a source-file id or a citekey. The corpus
 *  index advertises citekeys; if the model passes one to a doc_* tool, fall
 *  back to the reference row's linked source_file_id rather than failing.
 *  Returns the resolved source id, or null if neither matches. */
function resolveSourceId(id: string): string | null {
  if (!id) return null;
  if (getSourceById(id)) return id;
  const ref = getReferenceByCitekey(id);
  return ref?.source_file_id ?? null;
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

async function corpusList(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<ToolResult> {
  const query = (args.query as string | undefined)?.trim();
  const limit = Math.min(20, Math.max(1, (args.limit as number) || 10));

  // The CORPUS = the source files (chunked + embedded). References are an
  // OPTIONAL bibliographic overlay: build a source_file_id → Reference map so
  // we can attach citekey/authors/year when a reference happens to exist, but
  // NEVER drop a source just because it has no reference row.
  const allSources = listSources();
  const refBySrc = new Map<string, Reference>();
  for (const r of listReferences()) {
    if (r.source_file_id) refBySrc.set(r.source_file_id, r);
  }

  if (query) {
    // Semantic vector search. searchCorpus returns chunk-level hits keyed by
    // source_file_id; we de-dup to one hit per source and overlay reference
    // metadata when available. We over-fetch (limit*4) so de-dup still fills
    // the requested limit.
    const res = await searchCorpus(query, {
      apiKey: ctx.embeddingApiKey,
      limit: limit * 4,
    });
    const srcById = new Map(allSources.map((s) => [s.id, s] as const));
    const hits: CorpusHit[] = [];
    const seen = new Set<string>();
    for (const h of res.hits) {
      if (seen.has(h.sourceId)) continue;
      const s = srcById.get(h.sourceId);
      if (!s) continue; // stale chunk whose source_file was deleted
      seen.add(h.sourceId);
      const hit = hitFromSource(s, refBySrc.get(h.sourceId));
      hit.score = Math.round(h.score * 1000) / 1000;
      hit.physicalPage = h.physicalPage;
      hit.printedPage = h.printedPage;
      hit.snippet = h.text;
      hits.push(hit);
      if (hits.length >= limit) break;
    }
    const plural = (n: number) => (n === 1 ? "" : "s");
    const note =
      hits.length === 0
        ? res.embedded
          ? `0 semantic hits (corpus has ${allSources.length} source${plural(allSources.length)}; list without query, or doc_read by id)`
          : `corpus not embedded yet (${allSources.length} source${plural(allSources.length)} present; embed first, or list without query)`
        : `${hits.length} semantic hit${plural(hits.length)}`;
    return {
      ok: true,
      summary: `🔍 Searched "${query}" → ${note}`,
      data: {
        count: hits.length,
        embedded: res.embedded,
        dimensions: res.dimensions,
        corpusTotal: allSources.length,
        hits,
      },
    };
  }

  // No query → list/filter the corpus (source files). `filename` is the
  // natural corpus filter; `author`/`title` are reference-based and only
  // applied when references exist (so an uncurated corpus stays visible).
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
    data: { count: hits.length, corpusTotal: allSources.length, hits },
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
  const raw = (args.id as string)?.trim();
  if (!raw) return { ok: false, summary: "doc_read: id required", error: "id required" };
  const id = resolveSourceId(raw);
  if (!id) return { ok: false, summary: "doc_read: not found", error: `source ${raw} not found (pass a source-file id or citekey from corpus_list)` };
  const src = getSourceById(id);
  if (!src) return { ok: false, summary: "doc_read: not found", error: `source ${raw} not found` };
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
  const raw = (args.id as string)?.trim();
  if (!raw) return { ok: false, summary: "gui_doc_open: id required", error: "id required" };
  const id = resolveSourceId(raw) ?? raw;
  const src = getSourceById(id);
  ctx.emitGui({ kind: "doc_open", sourceId: id });
  return { ok: true, summary: `📂 Opened source "${src?.filename ?? raw}"`, data: { opened: true } };
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

async function prefAdd(args: Record<string, unknown>): Promise<ToolResult> {
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) return { ok: false, summary: "pref_add: text required", error: "text required" };
  await appendPreference(text);
  return { ok: true, summary: `📝 Noted preference`, data: { recorded: true } };
}
