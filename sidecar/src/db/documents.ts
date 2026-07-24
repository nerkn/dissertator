import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Document } from "@dissertator/shared";
import { current, slugify } from "./_core.ts";
import { mapSourceFile, type SourceFileRow } from "./sources.ts";
import {
  readSourceMarkdown,
  scheduleReingest,
  writeSourceMarkdown,
} from "../ingest/index.ts";

const PAPERS_DIR = "papers";

function isManuscriptRow(row: { rel_path: string; ext: string }): boolean {
  return row.rel_path.startsWith(`${PAPERS_DIR}/`) && row.ext === "md";
}

function relPathFor(slug: string): string {
  return `${PAPERS_DIR}/${slug}.md`;
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function manuscriptDir(): string {
  if (!current) throw new Error("no project initialized");
  return join(current.projectPath, PAPERS_DIR);
}

export function mapDocument(row: SourceFileRow, bodyMd?: string): Document {
  return {
    id: row.id,
    title: titleFromFilename(row.filename),
    bodyMd: bodyMd ?? "",
    createdAt: row.added_at,
  };
}

export async function listDocuments(): Promise<Document[]> {
  if (!current) throw new Error("no project initialized");
  const rows = current.db
    .prepare(
      "SELECT * FROM source_files WHERE rel_path LIKE 'papers/%.md' ORDER BY added_at DESC, id ASC",
    )
    .all() as SourceFileRow[];
  return rows.map((r) => mapDocument(r));
}

export async function createDocument(input: {
  title: string;
  bodyMd?: string;
}): Promise<Document> {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const slug = slugify(input.title);
  const relPath = relPathFor(slug);
  const filename = `${slug}.md`;

  const existing = db
    .prepare("SELECT * FROM source_files WHERE rel_path = ?")
    .get(relPath) as SourceFileRow | undefined;
  if (existing) {
    let body = "";
    try {
      body = await readSourceMarkdown(mapSourceFile(existing));
    } catch {
      body = "";
    }
    return mapDocument(existing, body);
  }

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
  return mapDocument(
    db.prepare("SELECT * FROM source_files WHERE id = ?").get(id) as SourceFileRow,
    body,
  );
}

export async function getDocument(id: string): Promise<Document | null> {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row || !isManuscriptRow(row)) return null;
  let body = "";
  try {
    body = await readSourceMarkdown(mapSourceFile(row));
  } catch {
    body = "";
  }
  return mapDocument(row, body);
}

export async function updateDocument(
  id: string,
  patch: Partial<{
    title: string;
    bodyMd: string;
  }>,
): Promise<Document | null> {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const row = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row || !isManuscriptRow(row)) return null;

  if (patch.title !== undefined) {
    const slug = slugify(patch.title);
    const newRel = relPathFor(slug);
    if (newRel !== row.rel_path) {
      const oldAbs = join(current.projectPath, row.rel_path);
      const newAbs = join(current.projectPath, newRel);
      await mkdir(manuscriptDir(), { recursive: true });
      try {
        await rename(oldAbs, newAbs);
      } catch {
        /* source may not be on disk yet; ignore */
      }
      db.prepare(
        "UPDATE source_files SET rel_path = ?, filename = ? WHERE id = ?",
      ).run(newRel, `${slug}.md`, id);
      scheduleReingest(newRel);
    }
  }

  if (patch.bodyMd !== undefined) {
    const fresh = db
      .prepare("SELECT * FROM source_files WHERE id = ?")
      .get(id) as SourceFileRow;
    await writeSourceMarkdown(mapSourceFile(fresh), patch.bodyMd);
  }

  const finalRow = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow;
  let body = "";
  try {
    body = await readSourceMarkdown(mapSourceFile(finalRow));
  } catch {
    body = "";
  }
  return mapDocument(finalRow, body);
}

export async function deleteDocument(id: string): Promise<boolean> {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const row = db
    .prepare("SELECT * FROM source_files WHERE id = ?")
    .get(id) as SourceFileRow | undefined;
  if (!row) return false;
  if (isManuscriptRow(row)) {
    try {
      await unlink(join(current.projectPath, row.rel_path));
    } catch {
      /* already gone */
    }
  }
  const res = db.prepare("DELETE FROM source_files WHERE id = ?").run(id);
  return res.changes > 0;
}

export function rewriteCitekeyInBodies(oldKey: string, newKey: string): number {
  if (!current) throw new Error("no project initialized");
  if (!oldKey || oldKey === newKey) return 0;
  const rows = current.db
    .prepare(
      "SELECT id, rel_path FROM source_files WHERE rel_path LIKE 'papers/%.md'",
    )
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
