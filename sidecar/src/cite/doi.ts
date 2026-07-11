// DOI extraction from free text (auto reference detection — "Option A").
//
// Used by `POST /sources/:id/detect-reference` to find a source's own DOI in
// its already-extracted text, then resolve it via Crossref (`crossrefByDoi`)
// to build a full Reference. We surface candidates in order of FIRST
// appearance and the route tries them one by one until Crossref resolves one
// — the paper's own DOI almost always appears on the title page, ahead of any
// cited-works DOIs buried in the bibliography, so "first hit that resolves"
// is a strong heuristic for the right one.
//
// Spec followed (DOI Handbook): `10.` + registrant code (4–9 digits) + `/` +
// suffix (printable, non-space). DOIs are case-insensitive — we lowercase for
// de-dup and for the Crossref lookup.
//
// This module is PURE (no DB, no network) so it is trivially testable offline.

/**
 * Match a DOI core: `10.\d{4,9}/` + a suffix that runs to the next whitespace,
 * quote, or angle bracket (the common text delimiters). Trailing punctuation
 * that isn't part of the DOI is reconciled by {@link trimTail} — DOIs may
 * legitimately contain parens/brackets, so we balance rather than blindly chop.
 *
 * A stray whitespace run is tolerated RIGHT AFTER the slash
 * (`10.33417/ tsh.1081422`) and collapsed away — printed/OCR'd title pages
 * occasionally split the DOI this way, and a missed own-DOI sends auto-detect
 * down a wrong-title Crossref path. DOIs never legitimately contain spaces
 * (DOI Handbook), so the collapse is always safe, and any false positive is
 * rejected by Crossref on lookup.
 */
const DOI_RE = /10\.\d{4,9}\/\s*[^\s"'<>]+/g;

/**
 * Strip trailing sentence/bracket punctuation that was swept up by the greedy
 * suffix match, WITHOUT breaking balanced parens/brackets that belong to the
 * DOI (e.g. `10.1000/(stub)` keeps its closing paren; `10.1038/nature123).`
 * drops the `).`).
 */
function trimTail(raw: string): string {
  // Drop trailing dots/commas/semicolons first (never legal DOI terminators).
  let s = raw.replace(/[.,;]+$/, "");
  // Then drop trailing closers (`)` or `]`) that have no matching opener in the
  // remainder — those came from surrounding prose, not the DOI.
  while (/[)\]]$/.test(s)) {
    const core = s.slice(0, -1);
    const opens = (core.match(/[[(]/g) || []).length;
    const closes = (core.match(/[)\]]/g) || []).length;
    if (opens > closes) break; // this closer balances an opener → keep it
    s = core;
  }
  return s;
}

/**
 * Extract unique DOI candidates from `text`, in order of first appearance,
 * lowercased. Returns `[]` when none are found. Pure & deterministic.
 *
 * @example
 *   extractDois("see doi: 10.1038/nature123. the rest…")
 *   // → ["10.1038/nature123"]
 */
export function extractDois(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(DOI_RE)) {
    const doi = trimTail(m[0]).replace(/\s+/g, "").toLowerCase();
    if (!doi || seen.has(doi)) continue;
    seen.add(doi);
    out.push(doi);
  }
  return out;
}
