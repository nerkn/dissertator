import type { Hono } from "hono";
import { isKeylessProviderType } from "@dissertator/shared";
import {
  createProvider,
  deleteProvider,
  getCurrentProject,
  getProvider,
  listProviders,
  updateProvider,
} from "../db";

/** Probe `{apiUrl}/models` with a Bearer key. Returns a Hono-style
 *  `{ status, body }` so callers can relay it directly. Used by both the
 *  saved-provider model list and the pre-save connection test. */
async function probeModels(
  apiUrl: string,
  apiKey: string,
): Promise<{ status: number; body: { models: string[]; error?: string } }> {
  const base = apiUrl.replace(/\/$/, "");
  try {
    const resp = await fetch(`${base}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
    if (!resp.ok) {
      return { status: 502, body: { error: `upstream ${resp.status}`, models: [] } };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string }> };
    const models = (data.data ?? [])
      .map((m) => m.id)
      .filter((x): x is string => typeof x === "string");
    return { status: 200, body: { models } };
  } catch (e) {
    return {
      status: 502,
      body: { error: (e as Error)?.message ?? String(e), models: [] },
    };
  }
}

// ---------------------------------------------------------------------------
// Providers (P6): named, user-editable provider rows. The frontend builds a
// list of these (multiple OpenAI accounts, a work Claude, an embedding
// backend, …); the Functions tab assigns one chat-kind row to `chat` and one
// embedding-kind row to `vectorizer` via PUT /settings. The API key is NEVER
// in the row — it lives in the OS keychain under the row's `keyUser` slot,
// managed by the frontend.
// ---------------------------------------------------------------------------

export function registerProviders(app: Hono): void {
  app.get("/providers", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json(listProviders());
  });

  app.post("/providers", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req.json<{
      name?: string;
      type?: string;
      apiUrl?: string;
      isDefault?: boolean;
    }>().catch(() => ({}) as Record<string, never>);
    if (!body.type) return c.json({ error: "type required" }, 400);
    try {
      const created = createProvider({
        name: body.name ?? "",
        type: body.type,
        apiUrl: body.apiUrl,
        isDefault: body.isDefault,
      });
      return c.json(created, 201);
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  app.put("/providers/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const body = await c.req.json<{
      name?: string;
      type?: string;
      apiUrl?: string;
      isDefault?: boolean;
    }>().catch(() => ({}) as Record<string, never>);
    const updated = updateProvider(id, {
      name: body.name,
      type: body.type,
      apiUrl: body.apiUrl,
      isDefault: body.isDefault,
    });
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/providers/:id", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const res = deleteProvider(c.req.param("id"));
    if (!res.ok) return c.json({ error: res.error ?? "delete failed" }, 400);
    return c.json({ ok: true });
  });

  // Live model list for a provider — proxies GET {apiUrl}/models with the
  // caller's Authorization key. Powers the Functions-tab model dropdowns.
  app.get("/providers/:id/models", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const prov = getProvider(c.req.param("id"));
    if (!prov) return c.json({ error: "not found" }, 404);
    if (isKeylessProviderType(prov.type)) return c.json({ models: [] });
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const r = await probeModels(prov.apiUrl, apiKey);
    return c.json(r.body, r.status as 200 | 502);
  });

  // Pre-save connection test (Add-provider dialog). Probes /models for an
  // endpoint + key that don't have a provider row yet.
  app.post("/providers/test", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const body = await c.req
      .json<{ apiUrl?: string; apiKey?: string }>()
      .catch(() => ({}) as { apiUrl?: string; apiKey?: string });
    const apiUrl = (body.apiUrl ?? "").trim();
    if (!apiUrl) return c.json({ error: "apiUrl required" }, 400);
    const r = await probeModels(apiUrl, (body.apiKey ?? "").trim());
    return c.json(r.body, r.status as 200 | 502);
  });
}
