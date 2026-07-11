import type { Hono } from "hono";
import type { DocType } from "@dissertator/shared";
import {
  createDocument,
  deleteDocument,
  getCurrentProject,
  getDocument,
  listDocuments,
  updateDocument,
} from "../db";

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

export function registerDocuments(app: Hono): void {
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
}
