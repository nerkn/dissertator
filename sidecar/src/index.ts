// Bun sidecar — HTTP server (Hono on Bun.serve).
// Owns: extraction, OCR, chunking, embeddings, agent loop, sqlite-vec queries.
// (P0 implements project init + settings only; the rest arrives in P1+.)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { join } from "node:path";
import { createServer } from "node:net";
import { SIDECAR_PORT, SIDECAR_PORT_RANGE, type ChatRequest, type DocType, type Document, type ProviderConfig, type ProviderKind, type Reference, type Settings, resolveChatConfig } from "@dissertator/shared";
import {
  getCurrentProject,
  getProjectStatus,
  getSettings,
  getEmbeddingStatus,
  getReferenceById,
  getReferenceByCitekey,
  getUiTabs,
  initProject,
  listReferences,
  saveSettings,
  setUiTabs,
  upsertReference,
  createChat,
  deleteChat,
  getChat,
  insertChatMessage,
  listChatMessages,
  listChats,
  updateChat,
  buildOpenFilesContext,
  getSourceById,
  getSourceText,
  listDocuments,
  createDocument,
  getDocument,
  updateDocument,
  deleteDocument,
  listProviders,
  getProvider,
  createProvider,
  updateProvider,
  deleteProvider,
} from "./db";
import { getPrompts, readPromptsMarkdown, savePrompts } from "./prompts.ts";
import { searchCorpus } from "./search";
import { crossrefByDoi, crossrefSearch } from "./cite/crossref.ts";
import { exportBibtex, parseBibtex } from "./cite/bibtex.ts";
import {
  runAgentLoop,
  type AgentStreamEvent,
} from "./agent/loop.ts";
import { TOOL_SPECS } from "./agent/tools.ts";
import { streamOpenAIChat } from "./chat/openai.ts";
import type { ToolContext } from "./agent/tools.ts";
import type { LoopMessage, ToolSpec } from "./chat/openai.ts";
import {
  start,
  scanAll,
  ocrSource,
  listSources,
  listAttention,
  getSourceCounts,
  onEvent,
  embedPending,
  type IngestEvent,
} from "./ingest/index.ts";
import type { OcrEngine, OcrOptions } from "./ocr/index.ts";

const app = new Hono();

// Frontend (localhost:1420) calls the sidecar (localhost:4319) cross-origin.
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

app.post("/project/init", async (c) => {
  const body = await c.req.json<{ path?: string }>().catch(
    () => ({}) as { path?: string }
  );
  if (!body?.path) return c.json({ error: "path required" }, 400);
  try {
    const res = await initProject(body.path);
    // Kick off the orchestrator (recursive watcher + initial scan). A
    // watcher failure must NOT break project creation — log and continue.
    // `start` is idempotent for the same root and tears down a prior session
    // if the project changed, so re-opening a project is safe here.
    try {
      await start(body.path);
    } catch (e) {
      console.error(
        "[sidecar] orchestrator start failed:",
        (e as Error)?.message ?? String(e)
      );
    }
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.get("/project/status", (c) => c.json(getProjectStatus()));

app.get("/settings", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(getSettings());
});

app.put("/settings", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  // P6: settings is now a FOCUSED patch — only scalar prefs + the function-
  // selection pointers (chat_provider_id / embedding_provider_id) + the
  // embedding dimension lock. Provider/apiUrl/model/embedding.* are derived
  // from provider rows, so they are NOT accepted here; manage rows via
  // /providers. Unknown keys are ignored for forward-compat.
  const body = await c.req.json<Record<string, unknown>>().catch(
    () => ({}) as Record<string, unknown>
  );
  const patch: Parameters<typeof saveSettings>[0] = {};
  if (typeof body.ocrStrategy === "string") patch.ocrStrategy = body.ocrStrategy as Settings["ocrStrategy"];
  if (typeof body.contactEmail === "string") patch.contactEmail = body.contactEmail;
  if (typeof body.chatProviderId === "string") patch.chatProviderId = body.chatProviderId;
  if (typeof body.embeddingProviderId === "string") patch.embeddingProviderId = body.embeddingProviderId;
  if (typeof body.embeddingDimensions === "number") patch.embeddingDimensions = body.embeddingDimensions;
  return c.json(saveSettings(patch));
});

// ---------------------------------------------------------------------------
// Providers (P6): named, user-editable provider rows. The frontend builds a
// list of these (multiple OpenAI accounts, a work Claude, an embedding
// backend, …); the Functions tab assigns one chat-kind row to `chat` and one
// embedding-kind row to `vectorizer` via PUT /settings. The API key is NEVER
// in the row — it lives in the OS keychain under the row's `keyUser` slot,
// managed by the frontend.
// ---------------------------------------------------------------------------

app.get("/providers", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(listProviders());
});

app.post("/providers", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req.json<{
    name?: string;
    kind?: ProviderKind;
    type?: ProviderConfig["type"];
    apiUrl?: string;
    model?: string;
    isDefault?: boolean;
  }>().catch(() => ({}) as Record<string, never>);
  if (body.kind !== "chat" && body.kind !== "embedding") {
    return c.json({ error: "kind must be 'chat' or 'embedding'" }, 400);
  }
  if (!body.type) return c.json({ error: "type required" }, 400);
  try {
    const created = createProvider({
      name: body.name ?? "",
      kind: body.kind,
      type: body.type,
      apiUrl: body.apiUrl,
      model: body.model,
      isDefault: body.isDefault,
    });
    return c.json(created, 201);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.put("/providers/:id", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    kind?: ProviderKind;
    type?: ProviderConfig["type"];
    apiUrl?: string;
    model?: string;
    isDefault?: boolean;
  }>().catch(() => ({}) as Record<string, never>);
  const updated = updateProvider(id, {
    name: body.name,
    kind: body.kind,
    type: body.type,
    apiUrl: body.apiUrl,
    model: body.model,
    isDefault: body.isDefault,
  });
  if (!updated) return c.json({ error: "not found" }, 404);
  return c.json(updated);
});

app.delete("/providers/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const res = deleteProvider(c.req.param("id"));
  if (!res.ok) return c.json({ error: res.error ?? "delete failed" }, 400);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Working-docs persistence (UI tabs). The frontend stores the open-tab list
// + active tab so reopening a project restores the user's working set.
// Lives in the project DB (settings table); never sent to the LLM.
// ---------------------------------------------------------------------------

app.get("/ui/tabs", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(getUiTabs());
});

app.put("/ui/tabs", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req.json<{
    tabs?: Array<{ sourceId: string; kind: string; title: string }>;
    activeTabId?: string | null;
  }>().catch(() => ({}) as Record<string, never>);
  setUiTabs(body.tabs ?? [], body.activeTabId ?? null);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ingest surface (Track F): sources / ingest / attention / ocr / events.
// Every route below requires an open project (returns 400 otherwise).
// ---------------------------------------------------------------------------

app.get("/sources", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json({ items: listSources(), counts: getSourceCounts() });
});

// Raw file bytes for PDF/image viewing in the frontend. The Tauri asset
// protocol is NOT scoped in this project (and we avoid Rust/permission
// changes), so the sidecar streams bytes directly. Content-Type comes from
// the row's `mime_type` (set during extraction); falls back to a generic
// octet-stream. 404 if the source id or the file on disk is missing.
app.get("/files/:id", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const src = getSourceById(id);
  if (!src) return c.json({ error: "not found" }, 404);
  const absPath = join(getCurrentProject()!.projectPath, src.relPath);
  const file = Bun.file(absPath);
  if (!(await file.exists())) {
    return c.json({ error: "file missing on disk" }, 404);
  }
  // Hono forwards a raw `Response` to Bun.serve unchanged. Loading the bytes
  // into an ArrayBuffer is simplest and correct for typical document sizes;
  // Bun.file is already zero-copy on the runtime side.
  return new Response(await file.arrayBuffer(), {
    headers: {
      "Content-Type": src.mimeType ?? "application/octet-stream",
    },
  });
});

// ---------------------------------------------------------------------------
// Export: render an HTML manuscript to PDF / DOCX / DOC via headless
// LibreOffice (soffice). Pandoc is NOT assumed; LibreOffice's HTML import +
// export filters handle all three formats well enough for a first draft. The
// HTML is produced client-side from the Milkdown document (getHTML), so the
// authored formatting is preserved. `[@citekey]` tokens pass through as text.
// ---------------------------------------------------------------------------
const SOFFICE_FILTERS: Record<
  string,
  { filter: string; ext: string; mime: string }
> = {
  pdf: { filter: "pdf:writer_pdf_Export", ext: "pdf", mime: "application/pdf" },
  docx: {
    filter: "docx:MS Word 2007 XML",
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  },
  doc: { filter: "doc:MS Word 97", ext: "doc", mime: "application/msword" },
};

function escapeHtmlAttr(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!),
  );
}

// Detect LibreOffice once. Tries `soffice` then `libreoffice`; cached so we
// don't pay the --version startup cost on every export.
let _sofficeBin: string | null | undefined;
function findSoffice(): string | null {
  if (_sofficeBin !== undefined) return _sofficeBin;
  for (const bin of ["soffice", "libreoffice"]) {
    try {
      const r = Bun.spawnSync({
        cmd: [bin, "--version"],
        stdout: "pipe",
        stderr: "pipe",
      });
      if (r.exitCode === 0) {
        _sofficeBin = bin;
        return bin;
      }
    } catch {
      /* binary not present — try the next alias */
    }
  }
  _sofficeBin = null;
  return null;
}

app.post("/export", async (c) => {
  let body: { html?: string; format?: string; title?: string; outPath?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const fmt = SOFFICE_FILTERS[body.format ?? ""];
  if (!fmt) return c.json({ error: `unsupported format: ${body.format}` }, 400);
  if (typeof body.html !== "string")
    return c.json({ error: "missing html" }, 400);

  const rawTitle = (body.title ?? "manuscript").trim();
  const title =
    rawTitle.replace(/[^\w\- .()]/g, "_").slice(0, 80) || "manuscript";

  // Wrap the Milkdown HTML fragment in a full document with print-friendly
  // CSS so the conversion engine applies sensible typography + page margins.
  const fullDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtmlAttr(
    title,
  )}</title><style>
@page { margin: 2.5cm; }
body { font-family: "Liberation Serif", Georgia, serif; font-size: 12pt; line-height: 1.5; color: #000; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
code, pre { font-family: "Liberation Mono", monospace; font-size: 10.5pt; }
blockquote { margin-left: 1.5cm; color: #444; font-style: italic; }
table { border-collapse: collapse; } th, td { border: 1px solid #888; padding: 4px 8px; }
img { max-width: 100%; }
</style></head><body>${body.html}</body></html>`;

  const os = await import("node:os");
  const npath = await import("node:path");
  const fs = await import("node:fs/promises");
  const dir = npath.join(
    os.tmpdir(),
    `dissertator-export-${process.pid}-${Math.random().toString(36).slice(2)}`,
  );
  await fs.mkdir(dir, { recursive: true });
  const inPath = npath.join(dir, "input.html");
  const outPath = npath.join(dir, `input.${fmt.ext}`);
  await fs.writeFile(inPath, fullDoc, "utf8");

  const cleanup = () =>
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});

  const bin = findSoffice();
  if (!bin) {
    await cleanup();
    return c.json(
      { error: "LibreOffice (soffice) not found. Install libreoffice to export." },
      500,
    );
  }

  const r = Bun.spawnSync({
    cmd: [
      bin,
      "--headless",
      "--norestore",
      `-env:UserInstallation=file://${dir}/profile`,
      "--convert-to",
      fmt.filter,
      "--outdir",
      dir,
      inPath,
    ],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120000,
  });

  const outFile = Bun.file(outPath);
  if (!(await outFile.exists())) {
    const errText = Buffer.isBuffer(r.stderr)
      ? r.stderr.toString("utf8")
      : String(r.stderr ?? "");
    await cleanup();
    return c.json(
      { error: `conversion failed: ${errText.slice(0, 500)}` },
      500,
    );
  }

  const buf = await outFile.arrayBuffer();
  await cleanup();

  // If the client passed an absolute save path (from a Tauri Save dialog),
  // write the converted bytes there directly and report the path. This is the
  // reliable path in a Tauri webview — programmatic <a download> of a blob
  // URL is swallowed by the webview, so the client never gets a file. The
  // sidecar (a local process) can write anywhere on disk without IPC perms.
  if (typeof body.outPath === "string" && body.outPath.trim()) {
    try {
      await fs.writeFile(body.outPath, new Uint8Array(buf));
      return c.json({ ok: true, path: body.outPath });
    } catch (e) {
      return c.json(
        { error: `could not write to ${body.outPath}: ${(e as Error).message}` },
        500,
      );
    }
  }

  return new Response(buf, {
    headers: {
      "Content-Type": fmt.mime,
      "Content-Disposition": `attachment; filename="${title}.${fmt.ext}"`,
    },
  });
});

// Concatenated extracted text (page-tagged) for text/docx/xlsx viewer tabs.
// Reuses the chunks table (same source as `buildOpenFilesContext`). Returns
// HTTP 200 with empty `text` when the source exists but has no chunks yet
// (not extracted) — the UI shows "not extracted yet"; this is NOT an error.
app.get("/sources/:id/text", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const src = getSourceById(id);
  if (!src) return c.json({ error: "not found" }, 404);
  return c.json(getSourceText(id));
});

app.post("/ingest", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  try {
    const enqueued = await scanAll();
    return c.json({ enqueued });
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.get("/attention", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json({ items: listAttention() });
});

app.post("/sources/:id/ocr", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const body = await c.req.json<{ engine?: OcrEngine }>().catch(
    () => ({}) as { engine?: OcrEngine }
  );
  const settings = getSettings();
  const engine = body.engine;
  // Vision needs the provider API key. It is sourced ONLY from the request
  // Authorization header here — never read from settings, never logged, never
  // persisted. Tesseract ignores `opts` entirely.
  const useVision =
    engine === "vision" ||
    (engine === undefined && settings.ocrStrategy === "vision");
  let opts: OcrOptions | undefined;
  if (useVision) {
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    opts = {
      apiKey,
      provider: settings.provider,
      apiUrl: settings.apiUrl,
      model: settings.model,
    };
  }
  try {
    await ocrSource(id, engine, opts);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Embedding surface (P2 Track 1): /embed runs pending chunks, /embed/status
// reports counts + the dimension lock. Mirrors the OCR key discipline: the
// embedding key is sourced ONLY from the request Authorization header — never
// read from settings, never logged, never persisted.
// ---------------------------------------------------------------------------

app.get("/embed/status", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(getEmbeddingStatus());
});

app.post("/embed", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  // Embedding key travels ONLY as a Bearer header (x-goog-api-key is added
  // inside the Google adapter from this same value). Never logged.
  const auth = c.req.header("Authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  try {
    const res = await embedPending({ apiKey });
    return c.json(res);
  } catch (e) {
    // Setup errors (no project / vec extension missing) → 500. Per-batch
    // adapter errors (auth, network) are caught inside embedPending and
    // surfaced as a `failed` count, not an exception.
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Semantic search (P2 Track 2): /search runs cosine KNN over the embedded
// corpus. The embedding key is sourced ONLY from the request Authorization
// header (same discipline as /embed) — never read from settings, never
// logged, never persisted. When the corpus isn't embedded yet, returns an
// empty result with `embedded:false` (no error) so the UI can show "embed
// first". When the corpus IS embedded but no key is supplied, returns a
// clean 400 (the query needs to be embedded too).
// ---------------------------------------------------------------------------

app.get("/search", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "q required" }, 400);
  const limitRaw = c.req.query("limit");
  const sourceId = c.req.query("sourceId");
  // Embedding key travels ONLY as a Bearer header (the Google adapter adds
  // x-goog-api-key from this same value internally). Never logged.
  const auth = c.req.header("Authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;

  // If the corpus is embedded, a key is required to embed the query. Return a
  // clean 400 rather than letting the adapter throw → 500. (When the corpus
  // is NOT embedded, `searchCorpus` short-circuits to an empty result and
  // never touches the key — graceful degradation, no error.)
  const status = getEmbeddingStatus();
  if (status.done > 0 && !apiKey) {
    return c.json({ error: "embedding api key required" }, 400);
  }

  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  try {
    const res = await searchCorpus(q, {
      apiKey,
      limit: Number.isFinite(limit) ? limit : undefined,
      sourceId: sourceId || undefined,
    });
    return c.json(res);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Citations & references (P2 Track 3): CRUD + Crossref lookup + BibTeX I/O.
//
// Citekey discipline: `upsertReference` FREEZES the citekey after first
// assignment (DESIGN.md §8 decision #9) — tokens in docs never break. The
// Crossref routes read `contactEmail` from settings to route through
// Crossref's polite pool; Crossref is a FREE PUBLIC API (no keychain key).
// NEVER block on network errors: lookup routes return `[]` / null on failure
// (the adapter logs + swallows). Route ordering matters: the static
// `export.bibtex` and action paths must precede `:id` so Hono doesn't capture
// them as an id.
// ---------------------------------------------------------------------------

app.get("/references", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const sourceFileId = c.req.query("source_file_id") || undefined;
  return c.json(listReferences(sourceFileId ? { sourceFileId } : {}));
});

app.post("/references", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<Partial<Reference>>()
    .catch(() => ({}) as Partial<Reference>);
  try {
    const ref = upsertReference(body);
    return c.json(ref, 201);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// Static export path MUST come before `/references/:id` so the literal
// `export.bibtex` segment isn't captured as an id.
app.get("/references/export.bibtex", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const refs = listReferences();
  c.header("Content-Type", "text/plain; charset=utf-8");
  // Plain text body — no JSON wrapping so it drops straight into a .bib file.
  return c.body(exportBibtex(refs));
});

app.get("/references/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  // Accept either id or citekey for ergonomic deep-links.
  const ref = getReferenceById(id) ?? getReferenceByCitekey(id);
  if (!ref) return c.json({ error: "not found" }, 404);
  return c.json(ref);
});

app.put("/references/:id", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const existing = getReferenceById(id) ?? getReferenceByCitekey(id);
  if (!existing) return c.json({ error: "not found" }, 404);
  const body = await c.req
    .json<Partial<Reference>>()
    .catch(() => ({}) as Partial<Reference>);
  try {
    // Pin the resolved id so upsert updates the right row (the caller may
    // have addressed it by citekey). Citekey is FROZEN unless explicitly passed.
    const ref = upsertReference({ ...body, id: existing.id });
    return c.json(ref);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.delete("/references/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const existing = getReferenceById(id) ?? getReferenceByCitekey(id);
  if (!existing) return c.json({ error: "not found" }, 404);
  // Direct DB delete (no helper needed — one-shot). "references" is quoted
  // because it's a SQL-ish keyword.
  getCurrentProject()!.db.prepare('DELETE FROM "references" WHERE id = ?').run(
    existing.id
  );
  return c.body(null, 204);
});

// Crossref free-text search (no commit — caller POSTs the chosen hit to
// /references to persist). Never blocks on network errors → [].
app.post("/references/lookup", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{ query?: string }>()
    .catch(() => ({}) as { query?: string });
  const query = (body.query ?? "").trim();
  if (!query) return c.json({ error: "query required" }, 400);
  const email = getSettings().contactEmail || undefined;
  const hits = await crossrefSearch(query, { contactEmail: email });
  return c.json(hits);
});

// Crossref DOI lookup (no commit). Returns null on 404 / network error.
app.post("/references/lookup-doi", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{ doi?: string }>()
    .catch(() => ({}) as { doi?: string });
  const doi = (body.doi ?? "").trim();
  if (!doi) return c.json({ error: "doi required" }, 400);
  const email = getSettings().contactEmail || undefined;
  const ref = await crossrefByDoi(doi, { contactEmail: email });
  return c.json(ref);
});

// BibTeX import: parse + upsert each entry. Returns the upserted references
// (with their assigned ids + de-collided citekeys).
app.post("/references/import-bibtex", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{ text?: string }>()
    .catch(() => ({}) as { text?: string });
  const text = body.text ?? "";
  if (!text.trim()) return c.json({ error: "text required" }, 400);
  try {
    const parsed = parseBibtex(text);
    const upserted = parsed.map((r) => upsertReference(r));
    return c.json(upserted);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Documents (editor) (P3): manuscript editor CRUD.
//
// A Document is ONE body: the manuscript markdown lives on the document row
// as `bodyMd`. There are no section rows — markdown headers are just lines in
// the body, and "stats" are computed by the frontend by parsing the body. The
// manuscript editor loads `GET /documents/:id` and autosaves the body via
// `PUT /documents/:id` (typically just `{ bodyMd }`). Same guards / body-parse
// / 404 / 201 conventions as /references.
// ---------------------------------------------------------------------------

app.get("/documents", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(listDocuments());
});

app.post("/documents", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{
      title?: string;
      docType?: DocType;
      thesis?: string;
      researchQuestions?: string[];
      focusPrompt?: string;
    }>()
    .catch(
      () =>
        ({}) as {
          title?: string;
          docType?: DocType;
          thesis?: string;
          researchQuestions?: string[];
          focusPrompt?: string;
        }
    );
  if (!body.title) return c.json({ error: "title required" }, 400);
  try {
    const doc = createDocument({
      title: body.title,
      docType: body.docType,
      thesis: body.thesis,
      researchQuestions: body.researchQuestions,
      focusPrompt: body.focusPrompt,
    });
    return c.json(doc, 201);
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.get("/documents/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const doc = getDocument(id);
  if (!doc) return c.json({ error: "not found" }, 404);
  return c.json(doc);
});

app.put("/documents/:id", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const body = await c.req
    .json<{
      title?: string;
      docType?: DocType | null;
      thesis?: string | null;
      researchQuestions?: string[];
      focusPrompt?: string | null;
      bodyMd?: string;
    }>()
    .catch(() => ({}) as Record<string, never>);
  const doc = updateDocument(id, body);
  if (!doc) return c.json({ error: "not found" }, 404);
  return c.json(doc);
});

app.delete("/documents/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  deleteDocument(id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Chats (P4): freeform chat thread CRUD. A chat is NOT bound to a document;
// it carries its own pinned `contextSources` (source_file ids) for UI
// persistence, and owns a transcript of `chat_messages` (POST /chat appends).
// Mirrors the /documents guards (400 if no project, 404 if id unknown).
// ---------------------------------------------------------------------------

app.get("/chats", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(listChats());
});

app.post("/chats", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{ title?: string; contextSources?: string[] }>()
    .catch(
      () =>
        ({}) as { title?: string; contextSources?: string[] }
    );
  const chat = createChat({
    title: body.title,
    contextSources: Array.isArray(body.contextSources)
      ? body.contextSources
      : undefined,
  });
  return c.json(chat, 201);
});

app.get("/chats/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const chat = getChat(id);
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json(chat);
});

app.put("/chats/:id", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const body = await c.req
    .json<{ title?: string; contextSources?: string[] }>()
    .catch(
      () => ({}) as { title?: string; contextSources?: string[] }
    );
  const chat = updateChat(id, body);
  if (!chat) return c.json({ error: "not found" }, 404);
  return c.json(chat);
});

app.delete("/chats/:id", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const ok = deleteChat(id);
  if (!ok) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

app.get("/chats/:id/messages", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  if (!getChat(id)) return c.json({ error: "not found" }, 404);
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  return c.json(
    listChatMessages(id, Number.isFinite(limit) ? limit : undefined)
  );
});

// ---------------------------------------------------------------------------
// Prompts (P4): predefined prompt quick-pick from `Dissertator/prompts.md`.
// ---------------------------------------------------------------------------

app.get("/prompts", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(await getPrompts());
});

// Raw `prompts.md` markdown for the Prompts-tab editor (P6). "" if absent.
app.get("/prompts/raw", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(await readPromptsMarkdown());
});

// Write the raw `prompts.md` back (P6 Prompts tab). The frontend edits the
// markdown directly; this replaces the whole file. Re-parses on save so the
// response is the fresh Prompt[] the quick-pick menu consumes.
app.put("/prompts", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req
    .json<{ markdown?: string }>()
    .catch(() => ({}) as { markdown?: string });
  if (typeof body.markdown !== "string") {
    return c.json({ error: "markdown required" }, 400);
  }
  try {
    await savePrompts(body.markdown);
    return c.json(await getPrompts());
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

// ---------------------------------------------------------------------------
// Chat (P3 Track E): streaming `POST /chat` with open-files context.
//
// Streams an OpenAI-compatible chat completion. The chat provider/model/url
// come from `Settings` (optionally overridden by the P3 `chat_*` block —
// decision #1: fall back to the main provider if not specified). The API key
// travels ONLY as a Bearer header — never stored, never logged (mirrors the
// /embed + ocr/vision discipline).
//
// CONTEXT: `open_files` source ids are concatenated (their chunks, page-
// tagged) up to a char budget and injected as a system message. This is plain
// full-text injection, NOT semantic retrieval (that's /search). The full
// transcript is persisted to `chat_messages` AFTER the turn completes (user
// msg up-front, assistant msg once the stream ends — so an aborted stream
// still records the user turn + whatever completed).
//
// STREAM PROTOCOL: each delta is forwarded as an SSE `delta` event carrying
// the text fragment; a final `done` event carries usage + persisted message
// ids. Errors mid-stream are emitted as an `error` event then the stream
// closes (the client sees the partial text + the error message).
//
// SCOPING (P4): `chatId` is REQUIRED — the turn is persisted to + replayed
// from THAT chat only. `GET /chat/messages?chatId=` is retained as a thin
// backward-compat alias for `GET /chats/:id/messages` (canonical).
// ---------------------------------------------------------------------------

app.get("/chat/messages", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const chatId = c.req.query("chatId");
  if (!chatId) return c.json({ error: "chatId required" }, 400);
  const limitRaw = c.req.query("limit");
  const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
  return c.json(
    listChatMessages(chatId, Number.isFinite(limit) ? limit : undefined)
  );
});

app.post("/chat", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c
    .req.json<ChatRequest>()
    .catch(() => ({}) as ChatRequest);
  const chatId = (body.chatId ?? "").trim();
  if (!chatId) return c.json({ error: "chatId required" }, 400);
  if (!getChat(chatId)) return c.json({ error: "chat not found" }, 404);
  const message = (body.message ?? "").trim();
  if (!message) return c.json({ error: "message required" }, 400);
  const openFiles = Array.isArray(body.openFiles) ? body.openFiles : [];

  // API key travels ONLY as a Bearer header (same discipline as /embed +
  // ocr/vision). Never logged.
  const auth = c.req.header("Authorization") ?? "";
  const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
  if (!apiKey) return c.json({ error: "chat api key required" }, 400);

  // P5: the document the user is currently editing (default p_* target) + the
  // embedding key (separate secret slot) for corpus_list vector search. Both
  // are optional; corpus_list degrades to metadata-only without the embed key.
  const activeDocId = (body.activeDocumentId ?? "").trim() || undefined;
  const embedKeyRaw = c.req.header("X-Embedding-Key") ?? "";
  const embeddingApiKey = embedKeyRaw.trim() || undefined;

  const settings = getSettings();
  const config = resolveChatConfig(settings);

  return streamSSE(c, async (stream) => {
    // Persist the user turn immediately (so an aborted stream still records it).
    const userMsg = insertChatMessage({
      chatId,
      role: "user",
      content: message,
      openFiles,
    });

    // Build the system message: role + tool guidance + active-doc + context.
    const systemParts: string[] = [
      "You are Dissertator, a research writing assistant. You help the user read sources and write their manuscript.",
      "",
      "You have tools — use them proactively:",
      "- corpus_list({query}) semantic-searches the embedded corpus; ({author,title}) filters the reference index. Returns short metadata; call doc_read for full text.",
      "- doc_read({id, page?}) reads a source's extracted text.",
      "- p_read({id?}) reads the manuscript body (id defaults to the active document).",
      "- p_create({title, text?}) creates a new manuscript.",
      "- p_write({id?, oldtext, text}) REPLACES the first occurrence of `oldtext` (must exist verbatim) with `text`.",
      "- p_insert({id?, anchor, text}) INSERTs `text` right after the first occurrence of `anchor` (empty anchor = top of the body).",
      "- gui_doc_open / gui_p_open open things for the user; gui_options offers quick-reply choices (does NOT pause); gui_action narrates milestones.",
      "",
      "Manuscript edits are CONTENT-ADDRESSED: pass the exact `oldtext`/`anchor` you got from p_read. If p_write/p_insert fails because the text wasn't found, p_read again — the user may have edited meanwhile.",
      "Cite sources inline as [@citekey] or [@citekey:42] (page). Prefer grounded claims; say plainly when the sources are insufficient.",
    ];
    if (activeDocId) {
      const d = getDocument(activeDocId);
      systemParts.push(
        `The user is currently editing the manuscript "${d?.title ?? "(unknown)"}" (id: ${activeDocId}). p_* tools without an explicit \`id\` act on it.`
      );
    }
    const ctx = buildOpenFilesContext(openFiles);
    if (ctx) {
      systemParts.push(
        `\nThe user has the following source files open as grounding context:\n\n${ctx}`
      );
    }
    const messages: LoopMessage[] = [
      { role: "system", content: systemParts.join("\n") },
      // Replay THIS chat's recent turns for conversational continuity (omit
      // system rows; we synthesize our own above). Only text content is
      // replayed — the tool-call trace lives in the current run only.
      ...listChatMessages(chatId, 20)
        .filter((m) => m.role !== "system" && m.id !== userMsg.id)
        .slice(-12)
        .map(
          (m): LoopMessage => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content ?? "",
          })
        ),
      { role: "user", content: message },
    ];

    const ac = new AbortController();
    let aborted = false;
    stream.onAbort(() => {
      aborted = true;
      ac.abort();
    });

    // P5: single SSE fan-in. Every beat (deltas, tool calls/results, live
    // edits, gui side-effects) flows through here as a named event.
    const onEvent = async (e: AgentStreamEvent): Promise<void> => {
      switch (e.type) {
        case "delta":
          await stream.writeSSE({ event: "delta", data: e.text });
          break;
        case "tool_call":
          await stream.writeSSE({
            event: "tool_call",
            data: JSON.stringify({
              id: e.id,
              name: e.name,
              args: e.args,
            }),
          });
          break;
        case "tool_result":
          await stream.writeSSE({
            event: "tool_result",
            data: JSON.stringify({
              id: e.id,
              name: e.name,
              ok: e.ok,
              summary: e.summary,
              ...(e.error ? { error: e.error } : {}),
            }),
          });
          break;
        case "edit":
          await stream.writeSSE({
            event: "edit",
            data: JSON.stringify({
              documentId: e.documentId,
              title: e.title,
              bodyMd: e.bodyMd,
            }),
          });
          break;
        case "gui":
          await stream.writeSSE({
            event: "gui",
            data: JSON.stringify(e.gui),
          });
          break;
      }
    };

    // Dev debug: surface exactly what's sent to the LLM. We wrap the
    // streaming adapter so every agent step fires a `debug` SSE event with
    // the model config, the full message array (roles + content + tool-call
    // traces), and the tool advertisements. The API key is NOT in the
    // payload (it travels only as a header).
    //
    // Also appended to `Dissertator/logs/agent.log` so a dev can `tail -f`
    // the exact LLM payloads during local debugging. ON by default; set
    // DEBUG=0 to disable (e.g. to keep the project folder quiet in prod).
    let debugStep = 0;
    const debugToFile = process.env.DEBUG !== "0";
    const wrapStream = (opts: Parameters<typeof streamOpenAIChat>[0]) => {
      const step = ++debugStep;
      const payload = {
        step,
        config: {
          provider: opts.config.provider,
          apiUrl: opts.config.apiUrl,
          model: opts.config.model,
        },
        toolChoice: opts.toolChoice ?? (opts.tools && opts.tools.length ? "auto" : undefined),
        tools: (opts.tools ?? []).map((t: ToolSpec) => t.function.name),
        messages: opts.messages,
      };
      // Emit as a first-class SSE event the client can render in a dev panel.
      stream.writeSSE({ event: "debug", data: JSON.stringify(payload) }).catch(() => {});
      if (debugToFile) {
        try {
          const project = getCurrentProject();
          if (project) {
            const logsDir = join(project.dissertatorDir, "logs");
            const logPath = join(logsDir, "agent.log");
            const stamp = new Date().toISOString();
            const line = `${stamp} [agent step ${step}] model=${opts.config.model} tools=${payload.tools.length} msgs=${opts.messages.length}\n` +
              JSON.stringify(payload, null, 2) + "\n";
            void import("node:fs/promises").then(async (fs) => {
              await fs.mkdir(logsDir, { recursive: true });
              await fs.appendFile(logPath, line, "utf8");
            }).catch(() => {});
          }
        } catch {
          /* logging must never throw */
        }
      }
      return streamOpenAIChat(opts);
    };
    const toolContext: ToolContext = {
      embeddingApiKey,
      activeDocumentId: activeDocId,
      emitGui: (gui) => {
        void onEvent({ type: "gui", gui });
      },
    };

    let content = "";
    let usage = { prompt: 0, completion: 0 };
    let toolCalls = 0;
    let capped = false;
    // Keep the SSE connection alive across model "thinking" gaps and slow
    // tool/embedding calls. Bun.serve's default idleTimeout (10s) drops an
    // idle socket, and a reasoning model (e.g. glm-5.2) can spend >10s
    // emitting nothing before its first token on a synthesis step. That gap
    // looked exactly like the client giving up: Hono's stream.onAbort fired
    // → ac.abort() → the in-flight model fetch aborted → empty reply.
    // An SSE comment (`: ping`) every 3s keeps the socket warm and is
    // silently ignored by the client's SSE parser (only `event:`/`data:`
    // lines are dispatched). Mirrors the /events heartbeat on a tighter
    // cadence (well under the 10s idle limit).
    const heartbeat = setInterval(() => {
      if (stream.aborted || stream.closed) return;
      stream.write(": ping\n\n").catch(() => {});
    }, 3000);
    try {
      const res = await runAgentLoop({
        apiKey,
        config,
        messages,
        toolContext,
        signal: ac.signal,
        onEvent,
        streamFn: wrapStream,
      });
      content = res.content;
      usage = res.usage;
      toolCalls = res.toolCalls;
      capped = res.capped;
      aborted = aborted || res.aborted;
    } catch (e) {
      const errMsg = (e as Error)?.message ?? String(e);
      // Surface the error but still persist whatever streamed before the
      // failure, so the transcript isn't lost.
      const partial = content
        ? insertChatMessage({
            chatId,
            role: "assistant",
            content,
            openFiles,
            costTokens: usage,
          })
        : null;
      // Touch the chat's updated_at even on failure.
      updateChat(chatId, {});
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({
          message: errMsg,
          assistantMessageId: partial?.id ?? null,
        }),
      });
      return;
    } finally {
      clearInterval(heartbeat);
    }

    const assistantMsg = insertChatMessage({
      chatId,
      role: "assistant",
      content: content || "",
      openFiles,
      costTokens: usage,
    });
    // Touch the chat's updated_at so it floats to the top of the sidebar.
    updateChat(chatId, {});
    // Dev debug: append a one-line turn summary to agent.log so a dev can
    // scan the tail of the log without expanding JSON blobs. (Full per-step
    // payloads are appended by wrapStream above.)
    if (debugToFile) {
      try {
        const project = getCurrentProject();
        if (project) {
          const logPath = join(project.dissertatorDir, "logs", "agent.log");
          const stamp = new Date().toISOString();
          const summary =
            `${stamp} [turn done] steps=${debugStep} tools_used=${toolCalls} ` +
            `tokens=${usage.prompt}↑/${usage.completion}↓ ` +
            `capped=${capped} aborted=${aborted}\n` +
            `  reply: ${JSON.stringify(content.slice(0, 200))}${content.length > 200 ? " …" : ""}\n`;
          void import("node:fs/promises").then((fs) => fs.appendFile(logPath, summary, "utf8")).catch(() => {});
        }
      } catch {
        /* logging must never throw */
      }
    }
    await stream.writeSSE({
      event: "done",
      data: JSON.stringify({
        userMessageId: userMsg.id,
        assistantMessageId: assistantMsg.id,
        aborted,
        usage,
        toolCalls,
        capped,
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Ingest events SSE (P1): fans out per-file status transitions to the UI.
app.get("/events", (c) => {
  // SSE fans out per-file ingest status transitions; it needs an open
  // project (the orchestrator emits against the active project's DB).
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return streamSSE(c, async (stream) => {
    const pending: IngestEvent[] = [];
    let notify: (() => void) | null = null;
    let alive = true;

    const wake = (): void => {
      notify?.();
    };

    // Fan every ingest status event into the SSE stream.
    const unsubscribe = onEvent((e) => {
      pending.push(e);
      wake();
    });

    // Heartbeat: an SSE comment (`:`-prefixed) every ~15s keeps proxies and
    // the browser's EventSource from timing out without emitting a
    // client-visible event. We send one immediately on connect too, which
    // flushes the response headers through any buffering proxy and tells the
    // client the stream is live before the first real event. A failed write
    // means the client is gone, so we tear the stream down.
    const beat = (): void => {
      stream.write(": heartbeat\n\n").catch(() => {
        alive = false;
        wake();
      });
    };
    beat();
    const heartbeat = setInterval(beat, 15000);

    // Client disconnect (newer Bun) — also flip the loop off.
    stream.onAbort(() => {
      alive = false;
      wake();
    });

    try {
      while (alive && !stream.aborted && !stream.closed) {
        // Drain any buffered events first.
        while (pending.length > 0) {
          const e = pending.shift();
          if (!e) break;
          try {
            await stream.writeSSE({
              event: "ingest",
              data: JSON.stringify(e),
            });
          } catch {
            // Client gone mid-write — stop the loop; finally cleans up.
            alive = false;
            break;
          }
        }
        if (!alive || stream.aborted || stream.closed) break;
        // Block until a new event arrives, the heartbeat ticks, or the
        // client aborts — each path calls `wake()`.
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

/**
 * Find the first free port starting at `SIDECAR_PORT`, probing up to
 * `SIDECAR_PORT_RANGE` consecutive ports. A busy preferred port (e.g. a
 * crashed previous instance or another app) must not block startup, so the
 * sidecar falls through to the next free one and the frontend discovers it
 * by scanning the same range.
 */
async function findFreePort(start: number, range: number): Promise<number> {
  for (let port = start; port < start + range; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(
    `[sidecar] no free port found in range ${start}..${start + range - 1}`,
  );
}

const port = await findFreePort(SIDECAR_PORT, SIDECAR_PORT_RANGE);

// idleTimeout: raise Bun's default (10s) so a momentary gap in SSE writes
// can't drop a long agent run. The /chat heartbeat (3s) already keeps the
// socket warm; this is belt-and-suspenders for slow tools / proxies. (Bun
// caps idleTimeout at 255s.)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  idleTimeout: 255,
});

console.log(
  `[sidecar] listening on http://127.0.0.1:${port}` +
    (port === SIDECAR_PORT ? "" : ` (preferred ${SIDECAR_PORT} was busy)`),
);
// Machine-readable handshake for the Tauri parent process: it parses this
// line from stdout to learn which port we bound (we pick a free one), then
// hands the port to the frontend over IPC. One JSON object per line, first.
process.stdout.write(`${JSON.stringify({ sidecar: "ready", port })}\n`);
