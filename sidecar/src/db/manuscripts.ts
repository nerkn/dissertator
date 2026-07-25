import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type SourceFile } from "@dissertator/shared";
import { current, filenameFromTitle } from "./_core.ts";
import { mapSourceFile, type SourceFileRow } from "./sources.ts";
import { scheduleReingest } from "../ingest/index.ts";

const PAPERS_DIR = "papers";

function slugRel(slug: string): string {
  return `${PAPERS_DIR}/${slug}.md`;
}

function manuscriptDir(): string {
  if (!current) throw new Error("no project initialized");
  return join(current.projectPath, PAPERS_DIR);
}

export async function createManuscript(input: {
  title: string;
  bodyMd?: string;
}): Promise<SourceFile> {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const name = filenameFromTitle(input.title);
  const relPath = slugRel(name);
  const filename = `${name}.md`;

  const existing = db
    .prepare("SELECT * FROM source_files WHERE rel_path = ?")
    .get(relPath) as SourceFileRow | undefined;
  if (existing) return mapSourceFile(existing);

  const body = input.bodyMd ?? "";
  await mkdir(manuscriptDir(), { recursive: true });
  await writeFile(join(manuscriptDir(), filename), body, "utf8");
  const id = randomUUID();
  const addedAt = Date.now();
  db.prepare(
    "INSERT INTO source_files (id, rel_path, filename, ext, kind, mime_type, content_hash, file_size, page_count, mtime, text_status, ocr_method, extracted_path, error, needs_ocr_reason, note, added_at) " +
      "VALUES (?, ?, ?, 'md', 'text', 'text/markdown', NULL, ?, NULL, NULL, 'new', NULL, NULL, NULL, NULL, NULL, ?)",
  ).run(id, relPath, filename, Buffer.byteLength(body, "utf8"), addedAt);
  scheduleReingest(relPath);
  return mapSourceFile(
    db.prepare("SELECT * FROM source_files WHERE id = ?").get(id) as SourceFileRow,
  );
}

export function rewriteCitekeyInBodies(oldKey: string, newKey: string): number {
  if (!current) throw new Error("no project initialized");
  if (!oldKey || oldKey === newKey) return 0;
  const rows = current.db
    .prepare("SELECT id, rel_path FROM source_files WHERE ext = 'md'")
    .all() as Array<{ id: string; rel_path: string }>;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`@${escape(oldKey)}(:\\d+)?(?![\\p{L}\\p{N}])`, "gu");
  let changed = 0;
  for (const row of rows) {
    const abs = join(current.projectPath, row.rel_path);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const next = body.replace(re, (_m, page) => `@${newKey}${page ?? ""}`);
    if (next !== body) {
      writeFileSync(abs, next, "utf8");
      scheduleReingest(row.rel_path);
      changed++;
    }
  }
  return changed;
}
