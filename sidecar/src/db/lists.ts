// Lists & notes subsystem (collect-while-reading → cite-while-writing).
// This module: lists CRUD + the built-in-list seed. (Notes live in notes.ts.)

import type { Database } from "bun:sqlite";
import { LIST_SEEDS, type List } from "@dissertator/shared";
import { current } from "./_core.ts";

/** Snake_case shape of a `lists` row. `system` is 0/1 (mapped to bool). */
interface ListRow {
  id: number;
  label: string;
  icon: string;
  color: string;
  ord: number;
  system: number;
}

function mapList(r: ListRow): List {
  return {
    id: r.id,
    label: r.label,
    icon: r.icon,
    color: r.color,
    ord: r.ord,
    system: !!r.system,
  };
}

/** Seed the 4 built-in lists (system=1). Idempotent by id. */
export function seedLists(db: Database): void {
  const ins = db.prepare(
    "INSERT OR IGNORE INTO lists(id, label, icon, color, ord, system) VALUES (?,?,?,?,?,1)"
  );
  for (const s of LIST_SEEDS) ins.run(s.id, s.label, s.icon, s.color, s.ord);
}

/** All lists, ordered by display order then id. */
export function listLists(): List[] {
  if (!current) return [];
  return (current.db
    .prepare("SELECT * FROM lists ORDER BY ord ASC, id ASC")
    .all() as ListRow[]).map(mapList);
}

/** Create a user list (system=0). `ord` is appended after the current max. */
export function createList(input: {
  label: string;
  icon?: string;
  color?: string;
}): List {
  if (!current) throw new Error("no project initialized");
  const label = input.label?.trim();
  if (!label) throw new Error("list label is required");
  const maxOrd = (
    current.db.prepare("SELECT COALESCE(MAX(ord), 0) AS m FROM lists").get() as {
      m: number;
    }
  ).m;
  const res = current.db
    .prepare(
      "INSERT INTO lists(label, icon, color, ord, system) VALUES (?,?,?,?,0)"
    )
    .run(label, input.icon ?? "BookmarkSimple", input.color ?? "#4a90e2", maxOrd + 1);
  return mapList(
    current.db.prepare("SELECT * FROM lists WHERE id = ?").get(
      Number(res.lastInsertRowid),
    ) as ListRow,
  );
}

/** Patch a list's label/icon/color/ord. Returns null if not found. */
export function updateList(
  id: number,
  patch: { label?: string; icon?: string; color?: string; ord?: number },
): List | null {
  if (!current) throw new Error("no project initialized");
  const existing = current.db.prepare("SELECT * FROM lists WHERE id = ?").get(
    id,
  ) as ListRow | undefined;
  if (!existing) return null;
  const label =
    patch.label !== undefined ? patch.label.trim() || existing.label : existing.label;
  const icon = patch.icon ?? existing.icon;
  const color = patch.color ?? existing.color;
  const ord = patch.ord ?? existing.ord;
  current.db
    .prepare("UPDATE lists SET label = ?, icon = ?, color = ?, ord = ? WHERE id = ?")
    .run(label, icon, color, ord, id);
  return mapList(
    current.db.prepare("SELECT * FROM lists WHERE id = ?").get(id) as ListRow,
  );
}

/** Delete a USER list (cascades its notes). Built-in (system=1) lists refuse. */
export function deleteList(id: number): boolean {
  if (!current) throw new Error("no project initialized");
  const existing = current.db.prepare("SELECT * FROM lists WHERE id = ?").get(
    id,
  ) as ListRow | undefined;
  if (!existing) return false;
  if (existing.system) throw new Error("cannot delete a built-in list");
  current.db.prepare("DELETE FROM lists WHERE id = ?").run(id);
  return true;
}
