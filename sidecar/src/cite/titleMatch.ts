// Fuzzy title equality — used to verify that a Crossref hit resolved from a
// DOI candidate actually describes THIS source, not a cited work.
//
// Why this exists: DOI candidates are scoped to the title page
// (`firstPageRegion` in doi.ts), but a stray cited DOI can still appear there
// (e.g. in an abstract). When we ALSO have a trusted title anchor (from PDF
// /info metadata), a resolved Crossref hit is accepted only if its title
// matches the anchor — so a different paper's DOI is rejected even if it sits
// on page 1. This is the "Option 3" belt-and-suspenders layer.
//
// Two titles "match" if, after normalization, one contains the other, or their
// token-overlap (Jaccard) is ≥ 0.6 — tolerant of subtitles, casing,
// punctuation, and truncation, strict enough to reject a different paper.
// Pure + deterministic; exported for unit testing.

/** Lowercase, strip non-alphanumerics, collapse whitespace. */
export function normTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token-overlap (Jaccard) ratio between two normalized titles, in [0,1].
 * Returns 0 if either side has no tokens. Used by {@link titlesMatch}.
 */
function jaccard(a: string, b: string): number {
  const ta = new Set(a.split(" ").filter(Boolean));
  const tb = new Set(b.split(" ").filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Jaccard threshold above which two different-length titles are considered
 *  the same paper. 0.6 absorbs subtitle/truncation drift while rejecting an
 *  unrelated paper (which typically shares only stop-words). */
const MATCH_THRESHOLD = 0.6;

/**
 * True if `a` and `b` plausibly describe the same paper's title. Accepts null
 * inputs (returns false) so callers can write `titlesMatch(ref.title, anchor)`
 * without a separate null guard for the anchor.
 */
export function titlesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const na = normTitle(a);
  const nb = normTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring (either direction) catches truncation / subtitle appendage.
  if (na.includes(nb) || nb.includes(na)) return true;
  return jaccard(na, nb) >= MATCH_THRESHOLD;
}
