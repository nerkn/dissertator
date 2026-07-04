// Recursive file watcher + tree walker for the watched project root.
//
// Two things live here:
//   1. Path exclusion — `<root>/Dissertator` and `<root>/documents` (and
//      everything under them) are never watched or scanned. The cache/log
//      writes the orchestrator makes land under `Dissertator/`, so excluding
//      it prevents feedback loops.
//   2. `fs.watch({ recursive: true })` on the root, debounced per path. The
//      watcher itself does no DB/extract work — it hands a relative path to
//      the `onFile` callback (wired to `enqueuePath` by the orchestrator),
//      which is responsible for stat/delete/extract. This keeps the watcher
//      free of imports from the orchestrator (no cycle).

import { watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/** Debounce window for coalescing rapid create/modify events on one path. */
const DEBOUNCE_MS = 400;

/**
 * True if `absPath` is `<root>/Dissertator`, `<root>/documents`, or anywhere
 * beneath them. Both sides are resolved with `node:path.resolve` first.
 */
export function isExcludedPath(absPath: string, root: string): boolean {
  const dissertatorDir = resolve(root, "Dissertator");
  const documentsDir = resolve(root, "documents");
  const p = resolve(absPath);
  return underDir(p, dissertatorDir) || underDir(p, documentsDir);
}

/** `p === dir` or `p` is a descendant of `dir` (path-separator aware). */
function underDir(p: string, dir: string): boolean {
  if (p === dir) return true;
  return p.startsWith(dir + sep);
}

/**
 * Recursively walk `root`, returning absolute file paths. Skips excluded
 * dirs, `node_modules`, and anything unreadable. Directory order is
 * alphabetical (readdir default) for deterministic enqueue order.
 */
export async function scanFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  await walk(resolve(root), root, out);
  return out;
}

async function walk(
  dir: string,
  root: string,
  out: string[]
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable or gone — skip silently
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (isExcludedPath(full, root)) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}

let watcher: FSWatcher | null = null;
const debounces = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Begin watching `root` recursively. `onFile(relPath)` is invoked (debounced)
 * for any create/modify/rename on a non-excluded path. The callback decides
 * what to do — the watcher does not stat or filter by file type, so deletions
 * and directories also flow through (the orchestrator no-ops on both).
 *
 * Calling again with a new root closes the previous watcher first.
 */
export function startWatcher(
  root: string,
  onFile: (relPath: string) => void
): void {
  stopWatcher();
  const r = resolve(root);
  try {
    watcher = watch(
      r,
      { recursive: true },
      (_eventType, filename) => {
        if (!filename) return;
        const abs = resolve(r, filename);
        if (isExcludedPath(abs, r)) return;
        schedule(abs, r, onFile);
      }
    );
  } catch (e) {
    // Watch failures are non-fatal — scanAll still drives the initial ingest.
    console.warn(`[ingest/watch] fs.watch failed: ${(e as Error)?.message}`);
    watcher = null;
  }
}

/** Debounce per absolute path; fires the callback once after `DEBOUNCE_MS`. */
function schedule(
  abs: string,
  root: string,
  onFile: (relPath: string) => void
): void {
  const existing = debounces.get(abs);
  if (existing) clearTimeout(existing);
  debounces.set(
    abs,
    setTimeout(() => {
      debounces.delete(abs);
      if (isExcludedPath(abs, root)) return;
      onFile(relative(root, abs));
    }, DEBOUNCE_MS)
  );
}

/** Close the watcher and clear pending debounces. Safe to call when stopped. */
export function stopWatcher(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  for (const t of debounces.values()) clearTimeout(t);
  debounces.clear();
}
