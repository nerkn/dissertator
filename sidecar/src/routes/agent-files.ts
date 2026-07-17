import type { Hono } from "hono";
import { getCurrentProject } from "../db";
import {
  getAgentPersona,
  readPreferences,
  saveAgentPersona,
} from "../agent-files.ts";
import {
  acceptPreferences,
  consolidatePreferences,
  dismissPreferences,
} from "../pref-consolidate.ts";

// ---------------------------------------------------------------------------
// Agent persona (personality + rules): user-editable markdown under
// `Dissertator/agent/`, surfaced by the Settings → Agent tab and read by the
// chat system-prompt builder. Mirrors the prompts.ts route shape.
// ---------------------------------------------------------------------------

export function registerAgentFiles(app: Hono): void {
  // Current persona ("" for either field if the file is absent). Never 500s
  // on a missing file — the tab seeds its textareas from this.
  app.get("/agent/persona", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(await getAgentPersona());
  });

  // Overwrite either/both blobs. Only present fields are written. Returns the
  // fresh full persona so the client can echo without a re-fetch.
  app.put("/agent/persona", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ personality?: string; rules?: string }>()
      .catch(() => ({}) as { personality?: string; rules?: string });
    const patch: { personality?: string; rules?: string } = {};
    if (typeof body.personality === "string") patch.personality = body.personality;
    if (typeof body.rules === "string") patch.rules = body.rules;
    if (patch.personality === undefined && patch.rules === undefined) {
      return c.json({ error: "personality or rules required" }, 400);
    }
    try {
      return c.json(await saveAgentPersona(patch));
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  app.get("/agent/preferences", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json({ contents: await readPreferences() });
  });

  app.post("/agent/preferences/consolidate", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!apiKey) return c.json({ error: "chat api key required" }, 400);
    try {
      return c.json(await consolidatePreferences(apiKey));
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  app.put("/agent/preferences", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ contents?: string }>()
      .catch(() => ({}) as { contents?: string });
    if (typeof body.contents !== "string")
      return c.json({ error: "contents required" }, 400);
    try {
      await acceptPreferences(body.contents);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  app.post("/agent/preferences/dismiss", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ rawHash?: string }>()
      .catch(() => ({}) as { rawHash?: string });
    if (typeof body.rawHash !== "string")
      return c.json({ error: "rawHash required" }, 400);
    try {
      await dismissPreferences(body.rawHash);
      return c.json({ ok: true });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });
}
