import type { Hono } from "hono";
import { getCurrentProject, getEmbeddingStatus } from "../db";
import { searchCorpus } from "../search";

// ---------------------------------------------------------------------------
// Semantic search (P2 Track 2): /search runs cosine KNN over the embedded
// corpus. The embedding key is sourced ONLY from the request Authorization
// header (same discipline as /embed) — never read from settings, never
// logged, never persisted. When the corpus isn't embedded yet, returns an
// empty result with `embedded:false` (no error) so the UI can show "embed
// first". When the corpus IS embedded but no key is supplied, returns a
// clean 400 (the query needs to be embedded too).
// ---------------------------------------------------------------------------

export function registerSearch(app: Hono): void {
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
}
