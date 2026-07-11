import type { Hono } from "hono";
import { getCurrentProject, getProjectStatus, initProject } from "../db";
import { start } from "../ingest/index.ts";

export function registerProject(app: Hono): void {
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
}
