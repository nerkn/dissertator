// Barrel for the DB layer. Re-exports the full public surface so the only
// consumer (`sidecar/src/index.ts`, `import { ... } from "./db"`) and the
// test files (`from "./db.ts"`) keep resolving exactly as before — this
// directory replaces the old monolithic src/db.ts.
//
// Per-entity modules live alongside _core.ts (shared connection + migration +
// cross-cutting helpers). Entity modules import only from ./_core (and
// @dissertator/shared); project.ts is the lifecycle orchestrator and also
// reaches into providers/references at init/save time.

export * from "./_core.ts";
export * from "./project.ts";
export * from "./providers.ts";
export * from "./bindings.ts";
export * from "./ui.ts";
export * from "./sources.ts";
export * from "./references.ts";
export * from "./lists.ts";
export * from "./notes.ts";
export * from "./documents.ts";
export * from "./chats.ts";
