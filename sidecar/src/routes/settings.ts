import type { Hono } from "hono";
import type { Settings } from "@dissertator/shared";
import { getSettings, saveSettings } from "../db";

export function registerSettings(app: Hono): void {
  app.get("/settings", (c) => {
    return c.json(getSettings());
  });

  app.put("/settings", async (c) => {
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
