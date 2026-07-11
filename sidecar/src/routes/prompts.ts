import type { Hono } from "hono";
import { getCurrentProject } from "../db";
import { getPrompts, readPromptsMarkdown, savePrompts } from "../prompts.ts";

// ---------------------------------------------------------------------------
// Prompts (P4): predefined prompt quick-pick from `Dissertator/prompts.md`.
// ---------------------------------------------------------------------------

export function registerPrompts(app: Hono): void {
  app.get("/prompts", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(await getPrompts());
  });

  // Raw `prompts.md` markdown for the Prompts-tab editor (P6). "" if absent.
  app.get("/prompts/raw", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(await readPromptsMarkdown());
  });

  // Write the raw `prompts.md` back (P6 Prompts tab). The frontend edits the
  // markdown directly; this replaces the whole file. Re-parses on save so the
  // response is the fresh Prompt[] the quick-pick menu consumes.
  app.put("/prompts", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ markdown?: string }>()
      .catch(() => ({}) as { markdown?: string });
    if (typeof body.markdown !== "string") {
      return c.json({ error: "markdown required" }, 400);
    }
    try {
      await savePrompts(body.markdown);
      return c.json(await getPrompts());
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });
}
