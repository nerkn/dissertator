import type { Hono } from "hono";
import { AI_FUNCTIONS, type AiFunction } from "@dissertator/shared";
import {
  getCurrentProject,
  getBindings,
  getResolvedBindings,
  setBinding,
} from "../db";

// Multi-provider (P-multi): function↔provider bindings.
export function registerBindings(app: Hono): void {
  app.get("/bindings", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json({ bindings: getBindings(), resolved: getResolvedBindings() });
  });

  app.put("/bindings/:fn", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const fn = c.req.param("fn") as AiFunction;
    if (!AI_FUNCTIONS.includes(fn)) {
      return c.json({ error: "unknown function" }, 400);
    }
    const body = await c.req
      .json<{ providerId?: string; model?: string }>()
      .catch(() => ({}) as { providerId?: string; model?: string });
    if (!body.providerId || typeof body.model !== "string") {
      return c.json({ error: "providerId + model required" }, 400);
    }
    try {
      return c.json(
        setBinding(fn, { providerId: body.providerId, model: body.model }),
      );
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });
}
