// Bun sidecar — HTTP server (Hono on Bun.serve).
// Owns: extraction, OCR, chunking, embeddings, agent loop, sqlite-vec queries.
// (P0 implements project init + settings only; the rest arrives in P1+.)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { SIDECAR_PORT, type Settings } from "@dissertator/shared";
import {
  getCurrentProject,
  getProjectStatus,
  getSettings,
  initProject,
  saveSettings,
} from "./db";
import {
  start,
  scanAll,
  ocrSource,
  listSources,
  listAttention,
  getSourceCounts,
  onEvent,
  type IngestEvent,
} from "./ingest/index.ts";
import type { OcrEngine, OcrOptions } from "./ocr/index.ts";

const app = new Hono();

// Frontend (localhost:1420) calls the sidecar (localhost:4319) cross-origin.
app.use("*", cors());

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

app.get("/settings", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json(getSettings());
});

app.put("/settings", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const body = await c.req.json<Partial<Settings>>().catch(
    () => ({}) as Partial<Settings>
  );
  const current = getSettings();
  const merged: Settings = {
    provider: body.provider ?? current.provider,
    apiUrl: body.apiUrl ?? current.apiUrl,
    model: body.model ?? current.model,
    ocrStrategy: body.ocrStrategy ?? current.ocrStrategy,
  };
  return c.json(saveSettings(merged));
});

// ---------------------------------------------------------------------------
// Ingest surface (Track F): sources / ingest / attention / ocr / events.
// Every route below requires an open project (returns 400 otherwise).
// ---------------------------------------------------------------------------

app.get("/sources", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json({ items: listSources(), counts: getSourceCounts() });
});

app.post("/ingest", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  try {
    const enqueued = await scanAll();
    return c.json({ enqueued });
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.get("/attention", (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return c.json({ items: listAttention() });
});

app.post("/sources/:id/ocr", async (c) => {
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  const id = c.req.param("id");
  const body = await c.req.json<{ engine?: OcrEngine }>().catch(
    () => ({}) as { engine?: OcrEngine }
  );
  const settings = getSettings();
  const engine = body.engine;
  // Vision needs the provider API key. It is sourced ONLY from the request
  // Authorization header here — never read from settings, never logged, never
  // persisted. Tesseract ignores `opts` entirely.
  const useVision =
    engine === "vision" ||
    (engine === undefined && settings.ocrStrategy === "vision");
  let opts: OcrOptions | undefined;
  if (useVision) {
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    opts = {
      apiKey,
      provider: settings.provider,
      apiUrl: settings.apiUrl,
      model: settings.model,
    };
  }
  try {
    await ocrSource(id, engine, opts);
    return c.json({ ok: true, id });
  } catch (e) {
    return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
  }
});

app.get("/events", (c) => {
  // SSE fans out per-file ingest status transitions; it needs an open
  // project (the orchestrator emits against the active project's DB).
  if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
  return streamSSE(c, async (stream) => {
    const pending: IngestEvent[] = [];
    let notify: (() => void) | null = null;
    let alive = true;

    const wake = (): void => {
      notify?.();
    };

    // Fan every ingest status event into the SSE stream.
    const unsubscribe = onEvent((e) => {
      pending.push(e);
      wake();
    });

    // Heartbeat: an SSE comment (`:`-prefixed) every ~15s keeps proxies and
    // the browser's EventSource from timing out without emitting a
    // client-visible event. We send one immediately on connect too, which
    // flushes the response headers through any buffering proxy and tells the
    // client the stream is live before the first real event. A failed write
    // means the client is gone, so we tear the stream down.
    const beat = (): void => {
      stream.write(": heartbeat\n\n").catch(() => {
        alive = false;
        wake();
      });
    };
    beat();
    const heartbeat = setInterval(beat, 15000);

    // Client disconnect (newer Bun) — also flip the loop off.
    stream.onAbort(() => {
      alive = false;
      wake();
    });

    try {
      while (alive && !stream.aborted && !stream.closed) {
        // Drain any buffered events first.
        while (pending.length > 0) {
          const e = pending.shift();
          if (!e) break;
          try {
            await stream.writeSSE({
              event: "ingest",
              data: JSON.stringify(e),
            });
          } catch {
            // Client gone mid-write — stop the loop; finally cleans up.
            alive = false;
            break;
          }
        }
        if (!alive || stream.aborted || stream.closed) break;
        // Block until a new event arrives, the heartbeat ticks, or the
        // client aborts — each path calls `wake()`.
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = null;
      }
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
});

export default {
  port: SIDECAR_PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};

console.log(`[sidecar] listening on http://127.0.0.1:${SIDECAR_PORT}`);
