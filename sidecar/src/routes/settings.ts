import type { Hono } from "hono";
import type { Settings } from "@dissertator/shared";
import { getCurrentProject, getSettings, saveSettings } from "../db";

export function registerSettings(app: Hono): void {
  app.get("/settings", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(getSettings());
  });

  app.put("/settings", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    // P6: settings is now a FOCUSED patch — only scalar prefs + the function-
    // selection pointers (chat_provider_id / embedding_provider_id) + the
    // embedding dimension lock. Provider/apiUrl/model/embedding.* are derived
    // from provider rows, so they are NOT accepted here; manage rows via
    // /providers. Unknown keys are ignored for forward-compat.
    const body = await c.req.json<Record<string, unknown>>().catch(
      () => ({}) as Record<string, unknown>
    );
    const patch: Parameters<typeof saveSettings>[0] = {};
    if (typeof body.ocrStrategy === "string") patch.ocrStrategy = body.ocrStrategy as Settings["ocrStrategy"];
    if (typeof body.contactEmail === "string") patch.contactEmail = body.contactEmail;
    if (typeof body.chatProviderId === "string") patch.chatProviderId = body.chatProviderId;
    if (typeof body.embeddingProviderId === "string") patch.embeddingProviderId = body.embeddingProviderId;
    if (typeof body.embeddingDimensions === "number") patch.embeddingDimensions = body.embeddingDimensions;
    return c.json(saveSettings(patch));
  });
}
