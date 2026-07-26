import { randomUUID } from "node:crypto";
import { current } from "./_core.ts";

export interface SourceHistoryRow {
  id: string;
  sourceId: string;
  relPath: string;
  author: "agent" | "user";
  op: string;
  summary: string;
  bodyAfter: string;
  createdAt: number;
  ids: string[];
  editCount: number;
}

export type SourceHistoryAuthor = "agent" | "user";

const COALESCE_WINDOW_MS = 5000;

export function insertSourceHistory(input: {
  sourceId: string;
  relPath: string;
  author: SourceHistoryAuthor;
  op?: string;
  summary?: string;
  bodyAfter: string;
}): void {
  if (!current) throw new Error("no project initialized");
  current.db
    .prepare(
      "INSERT INTO source_history (id, source_id, rel_path, author, op, summary, body_after, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      randomUUID(),
      input.sourceId,
      input.relPath,
      input.author,
      input.op ?? "manual",
      input.summary ?? "",
      input.bodyAfter,
      Date.now(),
    );
}

export function listSourceHistory(sourceId: string): SourceHistoryRow[] {
  if (!current) throw new Error("no project initialized");
  const raw = current.db
    .prepare(
      "SELECT id, source_id AS sourceId, rel_path AS relPath, author, op, summary, " +
        "body_after AS bodyAfter, created_at AS createdAt " +
        "FROM source_history WHERE source_id = ? ORDER BY created_at DESC, rowid DESC",
    )
    .all(sourceId) as Omit<SourceHistoryRow, "ids" | "editCount">[];

  const out: SourceHistoryRow[] = [];
  let prev: (typeof raw)[number] | null = null;
  for (const row of raw) {
    const join =
      prev !== null &&
      prev.author === row.author &&
      prev.createdAt - row.createdAt <= COALESCE_WINDOW_MS;
    if (join) {
      const g = out[out.length - 1];
      g.ids.push(row.id);
      g.editCount += 1;
    } else {
      out.push({ ...row, ids: [row.id], editCount: 1 });
    }
    prev = row;
  }
  return out;
}

export function deleteSourceHistoryByIds(ids: string[]): number {
  if (!current) throw new Error("no project initialized");
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const r = current.db
    .prepare(`DELETE FROM source_history WHERE id IN (${placeholders})`)
    .run(...ids);
  return r.changes;
}
