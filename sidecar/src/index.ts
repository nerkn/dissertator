// Bun sidecar — HTTP server (Hono on Bun.serve).
// Owns: extraction, OCR, chunking, embeddings, agent loop, sqlite-vec queries.
//
// This is the bootstrap only: it wires CORS, registers each domain's routes
// (each routes/*.ts exports a `register*(app)` that adds its routes with their
// FULL paths — keeping every method+path byte-identical for the web client),
// then finds a free port and starts the server.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { SIDECAR_PORT, SIDECAR_PORT_RANGE } from "@dissertator/shared";
import { findFreePort } from "./lib/port.ts";
import { ensureAgentFiles } from "./agent-files.ts";
import { registerAgentFiles } from "./routes/agent-files.ts";
import { registerBindings } from "./routes/bindings.ts";
import { registerChats } from "./routes/chats.ts";
import { registerDocuments } from "./routes/documents.ts";
import { registerEmbed } from "./routes/embed.ts";
import { registerEvents } from "./routes/events.ts";
import { registerExport } from "./routes/export.ts";
import { registerFunctions } from "./routes/functions.ts";
import { registerKeys } from "./routes/keys.ts";
import { registerLists } from "./routes/lists.ts";
import { registerNotes } from "./routes/notes.ts";
import { registerProject } from "./routes/project.ts";
import { registerPrompts } from "./routes/prompts.ts";
import { registerProviders } from "./routes/providers.ts";
import { registerReferences } from "./routes/references.ts";
import { registerSearch } from "./routes/search.ts";
import { registerSettings } from "./routes/settings.ts";
import { registerSources } from "./routes/sources.ts";
import { registerUi } from "./routes/ui.ts";

// Captured before any await: the Tauri process that spawned us. Used by the
// parent-death watchdog at the bottom of this file. (ppid is read once, early,
// so async work below can't race a dying parent.)
const PARENT_PID = process.ppid;

const app = new Hono();

// Frontend (localhost:1420) calls the sidecar (localhost:4319) cross-origin.
app.use("*", cors());

registerProject(app);
registerSettings(app);
registerProviders(app);
registerBindings(app);
registerFunctions(app);
registerKeys(app);
registerUi(app);
registerSources(app);
registerExport(app);
registerEmbed(app);
registerSearch(app);
registerReferences(app);
registerLists(app);
registerNotes(app);
registerDocuments(app);
registerChats(app);
registerPrompts(app);
registerAgentFiles(app);
registerEvents(app);

const port = await findFreePort(SIDECAR_PORT, SIDECAR_PORT_RANGE);

// idleTimeout: raise Bun's default (10s) so a momentary gap in SSE writes
// can't drop a long agent run. The /chat heartbeat (3s) already keeps the
// socket warm; this is belt-and-suspenders for slow tools / proxies. (Bun
// caps idleTimeout at 255s.)
Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch: app.fetch,
  idleTimeout: 255,
});

console.log(
  `[sidecar] listening on http://127.0.0.1:${port}` +
    (port === SIDECAR_PORT ? "" : ` (preferred ${SIDECAR_PORT} was busy)`),
);
// Machine-readable handshake for the Tauri parent process: it parses this
// line from stdout to learn which port we bound (we pick a free one), then
// hands the port to the frontend over IPC. One JSON object per line, first.
process.stdout.write(`${JSON.stringify({ sidecar: "ready", port })}\n`);

// Parent-death watchdog. The Rust parent kills us on a clean RunEvent::Exit,
// but a Ctrl-C / SIGKILL / crash / force-quit skips that handler and would
// leave us listening forever — a zombie still holding the project's SQLite DB
// open (the exact WAL/lock contention that hung a long agent turn). So poll
// the parent ourselves and self-exit when it's gone. Multi-instance safe: each
// sidecar watches only its OWN parent (PARENT_PID above), so this never kills
// a sibling app's sidecar. Skipped when launched detached (ppid === 1).
//
// Unix: a dead parent reparents us to init → process.ppid changes. Windows has
// no reparenting, so ppid goes stale → fall back to kill(pid, 0), which throws
// once the pid no longer exists.
if (PARENT_PID > 1) {
  const parentAlive = () => {
    if (process.ppid !== PARENT_PID) return false;
    try {
      process.kill(PARENT_PID, 0);
      return true;
    } catch {
      return false;
    }
  };
  setInterval(() => {
    if (!parentAlive()) {
      console.log("[sidecar] parent process gone — exiting to avoid zombie");
      process.exit(0);
    }
  }, 2000);
}
