import { SIDECAR_PORT, SIDECAR_PORT_RANGE } from "@dissertator/shared";

/**
 * Sidecar base URL. Resolved lazily:
 *   1. explicit `VITE_SIDECAR_URL` env override wins;
 *   2. otherwise we scan `SIDECAR_PORT..SIDECAR_PORT+SIDECAR_PORT_RANGE`,
 *      hitting `/health` on each until the sidecar answers, then cache it;
 *   3. as a last resort we fall back to the preferred port so the UI shows
 *      its usual connection error rather than a wrong-URL one.
 *
 * The sidecar binds the first free port in that same range, so a busy
 * preferred port never blocks the app from starting.
 */
const PREFERRED_BASE = `http://127.0.0.1:${SIDECAR_PORT}`;
const envBase = import.meta.env.VITE_SIDECAR_URL as string | undefined;
let resolvedBase: string | null = envBase ?? null;

const baseForPort = (p: number) => `http://127.0.0.1:${p}`;

async function probeSidecar(base: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${base}/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return false;
    // Confirm it's our sidecar (not some other app squatting on the port)
    // by checking the documented HealthResponse shape.
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
    } | null;
    return !!body?.ok;
  } catch {
    return false;
  }
}

/**
 * Scan the sidecar port range for a live server and cache its base URL.
 * Idempotent — subsequent calls return the cached value. Callers (the App
 * health poller) should `await resolveSidecarBase()` before issuing requests.
 *
 * Resolution order:
 *   1. explicit `VITE_SIDECAR_URL` env override (cached at module load);
 *   2. the port Tauri hands us over IPC — Tauri owns the sidecar process, so
 *      this is authoritative and never ambiguous, even with many app windows
 *      each running their own sidecar on a different port;
 *   3. web/standalone fallback: probe `/health` across the port range.
 */
export async function resolveSidecarBase(): Promise<string> {
  if (resolvedBase) return resolvedBase;

  // 2. Tauri spawned the sidecar and knows its port — trust it directly.
  const tauri = await baseFromTauri();
  if (tauri) {
    resolvedBase = tauri;
    return tauri;
  }

  // 3. Not under Tauri (e.g. `dev:web` + a standalone `dev:sidecar`) — scan.
  for (let p = SIDECAR_PORT; p < SIDECAR_PORT + SIDECAR_PORT_RANGE; p++) {
    const base = baseForPort(p);
    if (await probeSidecar(base)) {
      resolvedBase = base;
      return base;
    }
  }
  // Nothing answered yet (sidecar may still be booting). Return the
  // preferred base WITHOUT caching so the next poll re-scans the range
  // and picks up the sidecar once it's up — possibly on a shifted port.
  return PREFERRED_BASE;
}

/** Ask Tauri for the sidecar port. Returns null under web (no Tauri runtime). */
async function baseFromTauri(): Promise<string | null> {
  try {
    const { ipc } = await import("../../ipc");
    const port = await ipc.sidecarPort();
    if (typeof port === "number" && port > 0) return `http://127.0.0.1:${port}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Drop any cached base so the next `resolveSidecarBase()` re-scans. Call when
 * the sidecar is known to be down (e.g. health failed) so a restart on a
 * shifted port is picked up. An explicit `VITE_SIDECAR_URL` override is
 * always honored and never cleared.
 */
export function resetSidecarBase(): void {
  if (!envBase) resolvedBase = null;
}

/** Current sidecar base URL (preferred port until `resolveSidecarBase()` runs). */
export function base(): string {
  return resolvedBase ?? PREFERRED_BASE;
}

/** Stable base URL for SSE/file-URL callers (resolved after health probe). */
export function sidecarBase(): string {
  return base();
}

/**
 * Fetch helper. `opts` is spread AFTER the default `Content-Type` header, but
 * caller-supplied headers are merged explicitly so a full `headers` object on
 * `opts` does NOT clobber `Content-Type` (required e.g. for the OCR vision
 * call, which also sends `Authorization`).
 */
export async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const { headers: callerHeaders, ...rest } = opts ?? {};
  const res = await fetch(`${base()}${path}`, {
    headers: { "Content-Type": "application/json", ...callerHeaders },
    ...rest,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text}`.trim());
  }
  return (await res.json()) as T;
}
