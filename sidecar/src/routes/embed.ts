import type { Hono } from "hono";
import { getCurrentProject, getEmbeddingStatus } from "../db";
import { embedPending } from "../ingest/index.ts";

// ---------------------------------------------------------------------------
// Embedding surface (P2 Track 1): /embed runs pending chunks, /embed/status
// reports counts + the dimension lock. Mirrors the OCR key discipline: the
// embedding key is sourced ONLY from the request Authorization header — never
// read from settings, never logged, never persisted.
// ---------------------------------------------------------------------------

export function registerEmbed(app: Hono): void {
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
}
