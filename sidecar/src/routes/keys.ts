import type { Hono } from "hono";
import { deleteKey, listKeys, setKey } from "../db";

export function registerKeys(app: Hono): void {
  app.get("/keys", (c) => c.json(listKeys()));

  app.put("/keys/:keyUser", async (c) => {
    const keyUser = c.req.param("keyUser");
    const body = await c.req
      .json<{ value?: string }>()
      .catch(() => ({}) as { value?: string });
    setKey(keyUser, body.value ?? "");
    return c.json({ ok: true });
  });

  app.delete("/keys/:keyUser", (c) => {
    deleteKey(c.req.param("keyUser"));
    return c.json({ ok: true });
  });
}
