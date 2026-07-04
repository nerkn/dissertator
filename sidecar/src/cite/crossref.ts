// Crossref public REST API adapter (P2 Track 3).
//
// Crossref is a FREE PUBLIC API — no keychain key, no API key, no auth. We DO
// send a `User-Agent` identifying the app and (when available) a `mailto:`
// contact so Crossref routes us through its "polite pool" (shared rate limit,
// faster responses). The email comes from `settings.contactEmail`, NOT from
// `process.env` — it is a public contact address, not a secret, and it lives
// in the project DB so it travels with the project.
//
// PUBLIC CONTRACT:
//   - `crossrefSearch(query, opts)` → Reference[] (≤20 hits, no commit)
//   - `crossrefByDoi(doi, opts)`    → Reference | null
//   - `mapCrossrefToReference(work)`→ Reference (internal helper, exported for tests)
//
// FAILURE MODE (hard rule): these functions NEVER throw on a network/HTTP
// error. A failed search returns `[]`; a failed DOI lookup returns `null`.
// The error is logged via `console.error` so the route handler can return a
// clean empty result and the UI degrades gracefully ("no results"). This
// mirrors the embed/search adapters' "never crash the process" discipline,
// but UNLIKE those, there's no key to protect — so the error body can be
// echoed in full (no truncation needed).
//
// INJECTABLE `fetch`: `opts.fetch` defaults to the global `fetch`; tests pass
// a stub returning fixture JSON so the suite runs fully offline.

import type { Author, Reference } from "@dissertator/shared";

/** Crossref adapter options. */
export interface CrossrefOpts {
  /**
   * Contact email for Crossref's polite pool. Optional; when set, the
   * `User-Agent` includes `mailto:EMAIL` so Crossref routes us through the
   * faster shared-rate-limit pool. Sourced from `settings.contactEmail`.
   */
  contactEmail?: string;
  /**
   * Injectable `fetch` (defaults to the global). Narrower than `typeof fetch`
   * so a plain stub `async (url, init) => Response` satisfies it without a
   * cast — the global fetch is still assignable. Tests pass a stub returning
   * fixture JSON so no real network call is made.
   */
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

/** Crossref API base (free, public, no key). */
const CROSSREF_BASE = "https://api.crossref.org/works";

/** Cap on search rows (matches DESIGN.md §10 `corpus_list` ≤20 hits). */
const SEARCH_ROWS = 20;

/**
 * Build the `User-Agent` header. When `contactEmail` is present, includes the
 * app URL + `mailto:` so Crossref's polite pool engages. Otherwise sends a
 * bare app identifier (Crossref still works, just on the shared/public pool).
 */
function userAgent(contactEmail?: string): string {
  const e = (contactEmail ?? "").trim();
  if (e) {
    return `Dissertator/0.1 (https://github.com/nerkn/dissertator; mailto:${e})`;
  }
  return "Dissertator/0.1";
}

/** Crossref author entry (CSL-ish; we project to our `Author`). */
interface CrossrefAuthor {
  family?: string;
  given?: string;
}

/** Crossref date-parts container (`{ "date-parts": [[YYYY, MM, DD]] }`). */
interface CrossrefDate {
  "date-parts"?: number[][];
}

/** Shape of a Crossref `work` item (only the fields we read). */
export interface CrossrefWork {
  DOI?: string;
  type?: string;
  title?: string[];
  "container-title"?: string[];
  author?: CrossrefAuthor[];
  "published-print"?: CrossrefDate;
  "published-online"?: CrossrefDate;
  issued?: CrossrefDate;
  // The full record is preserved verbatim into `csl_json` for citeproc-js, so
  // we also accept any other fields ( CSL has ~40 of them).
  [k: string]: unknown;
}

/** Top-level search-response envelope (`{ message: { items: [...] } }`). */
interface CrossrefSearchEnvelope {
  message?: { items?: CrossrefWork[] };
}

/** DOI-lookup envelope (`{ message: { ...work } }`). */
interface CrossrefDoiEnvelope {
  message?: CrossrefWork;
}

/**
 * Extract a 4-digit year from a Crossref date container. Checks
 * `published-print` → `published-online` → `issued` (print is most authoritative
 * for citation; online/issued are progressively looser). Returns the first
 * non-zero year found in `date-parts[0][0]`, else null.
 */
function yearOf(work: CrossrefWork): number | null {
  const candidates = [
    work["published-print"],
    work["published-online"],
    work.issued,
  ];
  for (const d of candidates) {
    const y = d?.["date-parts"]?.[0]?.[0];
    if (typeof y === "number" && y > 0) return y;
  }
  return null;
}

/** Pick the first non-empty string from a Crossref string-array field. */
function first(arr: string[] | undefined): string | null {
  if (!arr || arr.length === 0) return null;
  const v = arr[0];
  return v && v.trim() ? v : null;
}

/**
 * Map a Crossref `work` to a partial {@link Reference} for display/upsert.
 *
 * `id` and `citekey` are deliberately LEFT BLANK — they are assigned on
 * commit by `upsertReference` (citekey is generated from author+year, and id
 * is a fresh UUID). `source_file_id` is also null: Crossref results are not
 * linked to a source until the user chooses to. `csl_json` carries the FULL
 * work record verbatim so citeproc-js can render APA/Chicago/etc. later.
 */
export function mapCrossrefToReference(work: CrossrefWork): Reference {
  const authors: Author[] = (work.author ?? []).map((a) => ({
    family: a.family,
    given: a.given,
  }));
  return {
    id: "",
    citekey: "",
    title: first(work.title),
    authors,
    year: yearOf(work),
    doi: work.DOI ?? null,
    type: work.type ?? null,
    venue: first(work["container-title"]),
    // Full record preserved for citeproc-js (round-trips to APA/Chicago/...).
    csl_json: work as Record<string, unknown>,
    source_file_id: null,
  };
}

/**
 * Search Crossref works by free-text query. Returns ≤20 partial References
 * (no `id`/`citekey` — assigned on commit). NEVER throws on network/HTTP
 * error: logs via `console.error` and returns `[]`. Empty results → `[]`.
 */
export async function crossrefSearch(
  query: string,
  opts: CrossrefOpts = {}
): Promise<Reference[]> {
  const doFetch = opts.fetch ?? fetch;
  const url = `${CROSSREF_BASE}?query=${encodeURIComponent(query)}&rows=${SEARCH_ROWS}`;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": userAgent(opts.contactEmail) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[crossref] search ${res.status} for "${query}": ${body.slice(0, 300)}`
      );
      return [];
    }
    const env = (await res.json()) as CrossrefSearchEnvelope;
    const items = env?.message?.items ?? [];
    return items.map(mapCrossrefToReference);
  } catch (e) {
    console.error(
      `[crossref] search failed for "${query}":`,
      (e as Error)?.message ?? String(e)
    );
    return [];
  }
}

/**
 * Look up a single Crossref work by DOI. Returns a partial {@link Reference}
 * (no `id`/`citekey`) or `null` on 404 / any error. NEVER throws.
 */
export async function crossrefByDoi(
  doi: string,
  opts: CrossrefOpts = {}
): Promise<Reference | null> {
  const doFetch = opts.fetch ?? fetch;
  const clean = doi.trim();
  if (!clean) return null;
  const url = `${CROSSREF_BASE}/${encodeURIComponent(clean)}`;
  try {
    const res = await doFetch(url, {
      headers: { "User-Agent": userAgent(opts.contactEmail) },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(
        `[crossref] doi ${res.status} for "${clean}": ${body.slice(0, 300)}`
      );
      return null;
    }
    const env = (await res.json()) as CrossrefDoiEnvelope;
    const work = env?.message;
    if (!work) return null;
    return mapCrossrefToReference(work);
  } catch (e) {
    console.error(
      `[crossref] doi lookup failed for "${clean}":`,
      (e as Error)?.message ?? String(e)
    );
    return null;
  }
}
