// Bun sidecar — HTTP server (Hono on Bun.serve).
// Owns: extraction, OCR, chunking, embeddings, agent loop, sqlite-vec queries.
// (P0 implements project init + settings only; the rest arrives in P1+.)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { SIDECAR_PORT, type Reference, type Settings } from "@dissertator/shared";
import {
  getCurrentProject,
  getProjectStatus,
  getSettings,
  getEmbeddingStatus,
  getReferenceById,
  getReferenceByCitekey,
  initProject,
  listReferences,
  saveSettings,
  upsertReference,
} from "./db";
import { searchCorpus } from "./search";
import { crossrefByDoi, crossrefSearch } from "./cite/crossref.ts";
import { exportBibtex, parseBibtex } from "./cite/bibtex.ts";
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
  const body = await c.req.json<Partial<Settings>>().catch(
    () => ({}) as Partial<Settings>
  );
  const current = getSettings();
  // The embedding block is DECOUPLED from chat settings and is usually edited
  // on its own screen — so if the body omits it, preserve the existing block
  // (and its locked `dimensions`). A body that DOES include `embedding`
  // overrides field-by-field.
  const embedding = body.embedding
    ? {
        provider: body.embedding.provider ?? current.embedding.provider,
        apiUrl: body.embedding.apiUrl ?? current.embedding.apiUrl,
        model: body.embedding.model ?? current.embedding.model,
        dimensions: body.embedding.dimensions ?? current.embedding.dimensions,
      }
    : current.embedding;
  const merged: Settings = {
    provider: body.provider ?? current.provider,
    apiUrl: body.apiUrl ?? current.apiUrl,
    model: body.model ?? current.model,
    ocrStrategy: body.ocrStrategy ?? current.ocrStrategy,
    embedding,
    contactEmail: body.contactEmail ?? current.contactEmail,
  };
  return c.json(saveSettings(merged));
});

// ---------------------------------------------------------------------------
// Ingest surface (Track F): sources / ingest / attention / ocr / events.
// Every route below requires an open project (returns 400 otherwise).
// ---------------------------------------------------------------------------

app.get("/sources", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json({ items: listSources(), counts: getSourceCounts() });
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

export default {
  port: SIDECAR_PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};

console.log(`[sidecar] listening on http://127.0.0.1:${SIDECAR_PORT}`);
