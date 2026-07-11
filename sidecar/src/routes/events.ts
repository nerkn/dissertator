import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { getCurrentProject } from "../db";
import { onEvent, type IngestEvent } from "../ingest/index.ts";

// Ingest events SSE (P1): fans out per-file status transitions to the UI.
export function registerEvents(app: Hono): void {
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
}
