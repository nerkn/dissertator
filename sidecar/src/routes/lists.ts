import type { Hono } from "hono";
import {
  createList,
  deleteList,
  getCurrentProject,
  listLists,
  updateList,
} from "../db";

export function registerLists(app: Hono): void {
  app.get("/lists", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(listLists());
  });

  app.post("/lists", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req.json().catch(() => ({}));
    try {
      return c.json(createList(body), 201);
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 400);
    }
  });

  app.put("/lists/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    const body = await c.req.json().catch(() => ({}));
    const updated = updateList(id, body);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/lists/:id", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "bad id" }, 400);
    try {
      const ok = deleteList(id);
      if (!ok) return c.json({ error: "not found" }, 404);
      return c.body(null, 204);
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 400);
    }
  });
}
