import type { Hono } from "hono";
import type { Reference } from "@dissertator/shared";
import {
  getCurrentProject,
  getReferenceByCitekey,
  getReferenceById,
  getSettings,
  listReferences,
  upsertReference,
} from "../db";
import { crossrefByDoi, crossrefSearch } from "../cite/crossref.ts";
import { exportBibtex, parseBibtex } from "../cite/bibtex.ts";

// ---------------------------------------------------------------------------
// Citations & references (P2 Track 3): CRUD + Crossref lookup + BibTeX I/O.
//
// Citekey discipline: `upsertReference` regenerates the citekey from
// author/year/title on every write and rewrites `[@citekey]` tokens in
// manuscripts when the key changes (no dangling citations). The
// Crossref routes read `contactEmail` from settings to route through
// Crossref's polite pool; Crossref is a FREE PUBLIC API (no keychain key).
// NEVER block on network errors: lookup routes return `[]` / null on failure
// (the adapter logs + swallows). Route ordering matters: the static
// `export.bibtex` and action paths must precede `:id` so Hono doesn't capture
// them as an id.
// ---------------------------------------------------------------------------

export function registerReferences(app: Hono): void {
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
      // have addressed it by citekey). Citekey follows author/year/title.
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
}
