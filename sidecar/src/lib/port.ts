import { createServer } from "node:net";

/**
 * Find the first free port starting at `start`, probing up to `range`
 * consecutive ports. A busy preferred port (e.g. a crashed previous instance
 * or another app) must not block startup, so the sidecar falls through to
 * the next free one and the frontend discovers it by scanning the same range.
 */
export async function findFreePort(
  start: number,
  range: number,
): Promise<number> {
  for (let port = start; port < start + range; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error(
    `[sidecar] no free port found in range ${start}..${start + range - 1}`,
  );
}
