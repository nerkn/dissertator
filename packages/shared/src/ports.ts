// Shared contract between the React frontend and the Bun sidecar.
// Imported directly as TypeScript by both (no build step needed in dev).

/** Preferred port the Bun sidecar HTTP server listens on (127.0.0.1). */
export const SIDECAR_PORT = 4319;

/**
 * How many consecutive ports above `SIDECAR_PORT` to probe before giving up.
 * The sidecar binds the first free one; the frontend scans the same range to
 * discover it, so a busy preferred port never blocks startup.
 */
export const SIDECAR_PORT_RANGE = 12;

/** Fresh per-provider keychain slot for a user-added provider. */
export function providerKeyUser(id: string): string {
  return `dissertator:provider:${id}`;
}
