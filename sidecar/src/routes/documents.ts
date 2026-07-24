import type { Hono } from "hono";
import {
  createDocument,
  deleteDocument,
  getCurrentProject,
  getDocument,
  listDocuments,
  updateDocument,
} from "../db";

export function registerDocuments(app: Hono): void {
  app.get("/documents", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(await listDocuments());
  });

  app.post("/documents", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ title?: string; text?: string }>()
      .catch(() => ({}) as { title?: string; text?: string });
    if (!body.title) return c.json({ error: "title required" }, 400);
    try {
      const doc = await createDocument({
        title: body.title,
        bodyMd: typeof body.text === "string" ? body.text : undefined,
      });
      return c.json(doc, 201);
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  app.get("/documents/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const doc = await getDocument(id);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json(doc);
  });

  app.put("/documents/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const body = await c.req
      .json<{ title?: string; bodyMd?: string }>()
      .catch(() => ({}) as Record<string, never>);
    const doc = await updateDocument(id, body);
    if (!doc) return c.json({ error: "not found" }, 404);
    return c.json(doc);
  });

  app.delete("/documents/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    await deleteDocument(id);
    return c.json({ ok: true });
  });
}
