// References (P2 Track 3): CRUD + citekey assignment.
//
// The `references` table is the citation index. `upsertReference`
// regenerates the citekey from author/year/title on every write and rewrites
// matching `[@citekey]` tokens across manuscript bodies when the key changes.
// Collisions (`smith2020` twice) are resolved by appending a BibTeX-style
// alpha suffix (`b`, `c`, …; the bare key plays the role of `a`) — the DB
// UNIQUE constraint is authoritative.
// No LEFT JOIN to `source_files` is needed: the only FK is `source_file_id`,
// filtered directly when requested.

import { randomUUID } from "node:crypto";
import { type Author, type Reference } from "@dissertator/shared";
import { alphaSuffix, generateCitekey } from "../cite/citekey.ts";
import { current } from "./_core.ts";
import { rewriteCitekeyInBodies } from "./documents.ts";

/**
 * Snake_case shape of a `references` row as returned by `bun:sqlite`.
 * `authors` and `csl_json` are JSON strings at this layer; parsed back to
 * objects by {@link mapReference}.
 */
export interface ReferenceRow {
  id: string;
  citekey: string;
  title: string | null;
  authors: string | null; // JSON "[{family,given}]"
  year: number | null;
  doi: string | null;
  type: string | null;
  venue: string | null;
  csl_json: string | null; // JSON CSL record
  source_file_id: string | null;
}

/** Options for {@link listReferences} (currently just source filtering). */
export interface ListReferencesOptions {
  sourceFileId?: string;
}

/** Max collision-resolution attempts before `upsertReference` gives up. */
const CITEKEY_MAX_ATTEMPTS = 20;

/**
 * Test whether `citekey` is already taken by a DIFFERENT reference id.
 * Used by the collision loop in {@link upsertReference}; the row's own id is
 * excluded so updating a reference in place never looks like a self-collision.
 */
function citekeyTaken(citekey: string, exceptId: string): boolean {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare(
      'SELECT id FROM "references" WHERE citekey = ? AND id != ?'
    )
    .get(citekey, exceptId) as { id?: string } | null;
  return !!row;
}

/**
 * Pick a free citekey by appending a BibTeX-style alpha suffix on collision.
 *
 * Starts from `base` (already generated / caller-supplied). If `base` is free
 * (excluding `exceptId`), returns it as-is. Otherwise appends `b`, `c`, …
 * (via {@link alphaSuffix}) for up to CITEKEY_MAX_ATTEMPTS attempts until a
 * free slot is found. The bare `base` plays the role of `a` — the FIRST
 * reference of a surname+year group keeps the unsuffixed key, so the scheme
 * is APPEND-ONLY: existing citekeys are never renamed and the FROZEN
 * invariant (docs/citekey.md §5) holds. Throws
 * `Error("citekey collision: ...")` if all attempts are taken — extremely
 * unlikely in practice (would need 20 near-identical refs).
 *
 *   resolve("Tek2025", …) → "Tek2025"   (free)
 *   resolve("Tek2025", …) → "Tek2025b"  (1st collision)
 *   resolve("Tek2025", …) → "Tek2025c"  (2nd collision)
 */
function resolveCitekey(
  base: string,
  exceptId: string
): string {
  if (!base) {
  // An empty base can't be used as a citekey (DB NOT NULL). Fall back to a
  // synthetic `ref-<uuid-prefix>` so insertion still succeeds.
    base = `ref-${exceptId.slice(0, 8)}`;
  }
  if (!citekeyTaken(base, exceptId)) return base;
  for (let i = 0; i < CITEKEY_MAX_ATTEMPTS; i++) {
    const candidate = `${base}${alphaSuffix(i)}`;
    if (!citekeyTaken(candidate, exceptId)) return candidate;
  }
  throw new Error(
    `citekey collision: could not find a free slot for "${base}" after ${CITEKEY_MAX_ATTEMPTS} attempts`
  );
}

/**
 * Map a snake_case `references` DB row to the {@link Reference} contract.
 * `authors` and `csl_json` are JSON-parsed back to objects (empty array / null
 * on parse failure — never throws).
 */
export function mapReference(row: ReferenceRow): Reference {
  let authors: Author[] = [];
  if (row.authors) {
    try {
      const parsed = JSON.parse(row.authors) as unknown;
      if (Array.isArray(parsed)) authors = parsed as Author[];
    } catch {
      authors = [];
    }
  }
  let csl: Record<string, unknown> | null = null;
  if (row.csl_json) {
    try {
      const parsed = JSON.parse(row.csl_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        csl = parsed as Record<string, unknown>;
      }
    } catch {
      csl = null;
    }
  }
  return {
    id: row.id,
    citekey: row.citekey,
    title: row.title,
    authors,
    year: row.year,
    doi: row.doi,
    type: row.type,
    venue: row.venue,
    csl_json: csl,
    source_file_id: row.source_file_id,
  };
}

/**
 * INSERT or UPDATE a reference by `id`.
 *
 * If `ref.id` is present and an existing row matches, the row is UPDATED
 * field-by-field (missing fields preserve their DB value); otherwise a new
 * row is INSERTed with a fresh `crypto.randomUUID()`. Citekey handling:
 *   - If updating an existing row, the citekey is regenerated from the
 *     merged author/year/title; if it changed, `[@citekey]` tokens in every
 *     manuscript body are rewritten in lockstep (no dangling citations).
 *   - Else if `ref.citekey` is supplied, it is used (and de-collided if taken).
 *   - Else (new row, no citekey), one is generated from the first author's
 *     family + year (falling back to the title), then de-collided.
 *
 * `authors` and `csl_json` are JSON-serialized for storage. Throws on citekey
 * collision exhaustion or if no project is initialized. Returns the full
 * post-write {@link Reference}.
 */
export function upsertReference(ref: Partial<Reference>): Reference {
  if (!current) throw new Error("no project initialized");
  const db = current.db;

  // Resolve the target id: keep the supplied id, else mint a fresh UUID.
  const id = ref.id?.trim() || randomUUID();

  const existing = db
    .prepare('SELECT * FROM "references" WHERE id = ?')
    .get(id) as ReferenceRow | null;

  let authors: Author[];
  if (ref.authors !== undefined) {
    authors = ref.authors;
  } else if (existing?.authors) {
    authors = JSON.parse(existing.authors) as Author[];
  } else {
    authors = [];
  }
  const year = ref.year ?? existing?.year ?? null;
  const title = ref.title ?? existing?.title ?? null;

  let citekey: string;
  if (existing) {
    const candidate = generateCitekey({
      family: authors[0]?.family,
      year,
      title,
    });
    citekey = candidate ? resolveCitekey(candidate, id) : existing.citekey;
  } else if (ref.citekey && ref.citekey.trim()) {
    citekey = resolveCitekey(ref.citekey.trim(), id);
  } else {
    citekey = resolveCitekey(
      generateCitekey({ family: authors[0]?.family, year, title }),
      id
    );
  }
  const csl = ref.csl_json ??
    (existing?.csl_json
      ? (JSON.parse(existing.csl_json as string) as Record<string, unknown>)
      : null);

  const row: ReferenceRow = {
    id,
    citekey,
    title: ref.title ?? existing?.title ?? null,
    authors: JSON.stringify(authors),
    year: ref.year ?? existing?.year ?? null,
    doi: ref.doi ?? existing?.doi ?? null,
    type: ref.type ?? existing?.type ?? null,
    venue: ref.venue ?? existing?.venue ?? null,
    csl_json: csl ? JSON.stringify(csl) : null,
    source_file_id: ref.source_file_id ?? existing?.source_file_id ?? null,
  };

  db.prepare(
    'INSERT INTO "references" ' +
      "(id, citekey, title, authors, year, doi, type, venue, csl_json, source_file_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
      'ON CONFLICT(id) DO UPDATE SET ' +
      "citekey = excluded.citekey, " +
      "title = excluded.title, " +
      "authors = excluded.authors, " +
      "year = excluded.year, " +
      "doi = excluded.doi, " +
      "type = excluded.type, " +
      "venue = excluded.venue, " +
      "csl_json = excluded.csl_json, " +
      "source_file_id = excluded.source_file_id"
  ).run(
    row.id,
    row.citekey,
    row.title,
    row.authors,
    row.year,
    row.doi,
    row.type,
    row.venue,
    row.csl_json,
    row.source_file_id
  );

  if (existing && citekey !== existing.citekey) {
    rewriteCitekeyInBodies(existing.citekey, citekey);
  }

  return mapReference(row);
}

/**
 * Guarantee a source has a linked reference so its notes carry a citekey (the
 * cite button is greyed without one). If the source already links to a
 * reference, it is returned unchanged; otherwise a minimal PLACEHOLDER
 * reference is minted whose citekey is derived from `title` (typically the
 * source's filename). Real bibliographic metadata (authors / year / DOI)
 * arrives later via Crossref or BibTeX, but the citekey — the internal handle
 * — is already stable and frozen. See docs/citekey.md §3.
 */
export function ensureReferenceForSource(
  sourceFileId: string,
  title: string
): Reference {
  if (!current) throw new Error("no project initialized");
  const existing = listReferences({ sourceFileId });
  if (existing.length > 0) return existing[0];
  return upsertReference({ source_file_id: sourceFileId, title });
}

/**
 * One-time data backfill run at project open: create a placeholder reference
 * for every source that lacks one, so every note has a citekey and every cite
 * button works. Idempotent — sources already linked to a reference are
 * skipped. Returns the number of references created (0 on a steady-state
 * reopen). Covers pre-feature DBs and the OCR/transcribe completion paths,
 * which mint their reference lazily here rather than inline. See
 * docs/citekey.md §3.
 */
export function backfillSourceReferences(): number {
  if (!current) throw new Error("no project initialized");
  const db = current.db;
  const orphans = db
    .prepare(
      'SELECT sf.id AS id, sf.filename AS filename, sf.ext AS ext ' +
        "FROM source_files sf " +
        'LEFT JOIN "references" r ON r.source_file_id = sf.id ' +
        "WHERE r.id IS NULL"
    )
    .all() as Array<{ id: string; filename: string; ext: string }>;
  let created = 0;
  for (const row of orphans) {
    // Derive a human-readable placeholder title by stripping the extension;
    // the citekey comes from this title's first significant word.
    const dotExt = row.ext ? `.${row.ext}` : "";
    const title =
      dotExt && row.filename.endsWith(dotExt)
        ? row.filename.slice(0, -dotExt.length)
        : row.filename;
    ensureReferenceForSource(row.id, title || row.filename);
    created++;
  }
  if (created > 0) {
    console.log(
      `[db] backfillSourceReferences: created ${created} placeholder reference(s)`
    );
  }
  return created;
}

/** Fetch a single reference by id, or null if not found. */
export function getReferenceById(id: string): Reference | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare('SELECT * FROM "references" WHERE id = ?')
    .get(id) as ReferenceRow | null;
  return row ? mapReference(row) : null;
}

/** Fetch a single reference by citekey, or null if not found. */
export function getReferenceByCitekey(citekey: string): Reference | null {
  if (!current) throw new Error("no project initialized");
  const row = current.db
    .prepare('SELECT * FROM "references" WHERE citekey = ?')
    .get(citekey) as ReferenceRow | null;
  return row ? mapReference(row) : null;
}

/**
 * List references, optionally filtered by `source_file_id`. Ordered by
 * `citekey` asc for a stable, predictable listing. Parses the JSON columns
 * back to objects via {@link mapReference}.
 */
export function listReferences(
  opts: ListReferencesOptions = {}
): Reference[] {
  if (!current) throw new Error("no project initialized");
  const sql = opts.sourceFileId
    ? 'SELECT * FROM "references" WHERE source_file_id = ? ORDER BY citekey ASC'
    : 'SELECT * FROM "references" ORDER BY citekey ASC';
  const rows = opts.sourceFileId
    ? (current.db.prepare(sql).all(opts.sourceFileId) as ReferenceRow[])
    : (current.db.prepare(sql).all() as ReferenceRow[]);
  return rows.map(mapReference);
}

/**
 * Link a reference to a source file (set `source_file_id`). Used by the
 * ingestion pipeline when a source resolves to a known reference. Throws if
 * the reference id does not exist.
 */
export function linkReferenceToSource(
  refId: string,
  sourceFileId: string | null
): void {
  if (!current) throw new Error("no project initialized");
  const res = current.db
    .prepare(
      'UPDATE "references" SET source_file_id = ? WHERE id = ?'
    )
    .run(sourceFileId, refId);
  if (res.changes === 0) {
    throw new Error(`linkReferenceToSource: reference ${refId} not found`);
  }
}
