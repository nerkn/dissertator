interface Entry {
  relPath: string;
  body: string;
  ts: number;
}

const cache = new Map<string, Entry>();
const READ_CACHE_CAP_CHARS = 40000;

function norm(relPath: string): string {
  return relPath.replace(/\\/g, "/").toLowerCase();
}

export function cacheRead(relPath: string, body: string): void {
  const key = norm(relPath);
  if (!key) return;
  cache.set(key, { relPath, body, ts: Date.now() });
}

export function clearReadCache(): void {
  cache.clear();
}

export function serializeReadCache(): string | null {
  if (cache.size === 0) return null;
  const entries = [...cache.values()].sort((a, b) => b.ts - a.ts);
  let budget = READ_CACHE_CAP_CHARS;
  const blocks: string[] = [];
  for (const e of entries) {
    if (budget <= 0) break;
    const header = `--- ${e.relPath} ---`;
    const body = e.body.length > budget - header.length - 6
      ? e.body.slice(0, Math.max(0, budget - header.length - 6)) + "\n…[truncated]"
      : e.body;
    blocks.push(`${header}\n${body}`);
    budget -= header.length + body.length + 6;
  }
  if (blocks.length === 0) return null;
  return blocks.join("\n\n");
}
