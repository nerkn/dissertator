// Shared contract between the React frontend and the Bun sidecar.
// Imported directly as TypeScript by both (no build step needed in dev).
//
// This file is a re-export BARREL only: every symbol lives in a per-domain
// module under packages/shared/src/. Add new exports to the relevant module,
// not here. The barrel preserves the package's public surface so any
// `import { ... } from "@dissertator/shared"` keeps resolving unchanged
// across both consumers (sidecar + web frontend).

export * from "./ports";
export * from "./providers";
export * from "./functions";
export * from "./settings";
export * from "./project";
export * from "./sources";
export * from "./chat";
export * from "./prompts";
export * from "./references";
export * from "./documents";
