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
import { registerBindings } from "./routes/bindings.ts";
import { registerChats } from "./routes/chats.ts";
import { registerDocuments } from "./routes/documents.ts";
import { registerEmbed } from "./routes/embed.ts";
import { registerEvents } from "./routes/events.ts";
import { registerExport } from "./routes/export.ts";
import { registerFunctions } from "./routes/functions.ts";
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

const app = new Hono();

// Frontend (localhost:1420) calls the sidecar (localhost:4319) cross-origin.
app.use("*", cors());

registerProject(app);
registerSettings(app);
registerProviders(app);
registerBindings(app);
registerFunctions(app);
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
