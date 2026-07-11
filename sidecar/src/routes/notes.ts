import type { Hono } from "hono";
import type { Note } from "@dissertator/shared";
import {
  createNote,
  deleteNote,
  getCurrentProject,
  listNotes,
  updateNote,
} from "../db";

export function registerNotes(app: Hono): void {
  app.get("/notes", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const listIdRaw = c.req.query("listId");
    const sourceId = c.req.query("sourceId") || undefined;
    const listId = listIdRaw ? parseInt(listIdRaw, 10) : undefined;
    return c.json(
      listNotes({
        listId: listId !== undefined && Number.isFinite(listId) ? listId : undefined,
        sourceId,
      }),
    );
  });

  app.post("/notes", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<Partial<Note>>()
      .catch(() => ({}) as Partial<Note>);
    try {
      const note = createNote({
        sourceId: body.sourceId ?? "",
        page: Number(body.page) || 1,
        excerpt: body.excerpt ?? null,
        body: body.body ?? null,
        listId: Number(body.listId) || 1,
        rect: body.rect ?? null,
      });
      return c.json(note, 201);
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 400);
    }
  });

  app.put("/notes/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const body = await c.req
      .json<Partial<Note>>()
      .catch(() => ({}) as Partial<Note>);
    const updated = updateNote(id, {
      excerpt: body.excerpt,
      body: body.body,
      listId: body.listId !== undefined ? Number(body.listId) : undefined,
      rect: body.rect,
    });
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/notes/:id", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    deleteNote(c.req.param("id"));
    return c.body(null, 204);
  });
}
