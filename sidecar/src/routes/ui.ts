import type { Hono } from "hono";
import { getCurrentProject, getUiTabs, setUiTabs } from "../db";

// Working-docs persistence (UI tabs). The frontend stores the open-tab list
// + active tab so reopening a project restores the user's working set.
// Lives in the project DB (settings table); never sent to the LLM.
export function registerUi(app: Hono): void {
  app.get("/ui/tabs", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(getUiTabs());
  });

  app.put("/ui/tabs", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req.json<{
      tabs?: Array<{ sourceId: string; kind: string; title: string }>;
      activeTabId?: string | null;
    }>().catch(() => ({}) as Record<string, never>);
    setUiTabs(body.tabs ?? [], body.activeTabId ?? null);
    return c.json({ ok: true });
  });
}
