// Deterministic citekey generation (P2 Track 3).
//
// A citekey is the stable handle embedded in citation tokens `[@citekey:page]`
// throughout a manuscript (DESIGN.md §8). It is FROZEN after first assignment
// (decision #9) so existing tokens never break — `upsertReference` regenerates
// it only when a reference has none yet, and never overwrites an existing one.
//
// Format: `Çengelköylü2022` — first-author family + 4-digit year. The family
// name is kept VERBATIM: case and accents are PRESERVED (citekey-model
// decision "B-cap": citekeys are author-faithful, so `Çengelköylü2022` is NOT
// mangled to `cengelkoylu2022`). Only non-alphanumeric characters (spaces,
// punctuation) are stripped. If the first author's family is missing, the
// first significant word of the title is used as the family fallback (matches
// the DESIGN.md §8 "fallback to filename slug" spirit for fileless refs),
// again verbatim.
//
// NOTE on the internal/external boundary: the citekey is the INTERNAL handle
// (see docs/citekey.md). It must be a stable, unique string — it does not have
// to be ASCII. Export-time rendering (BibTeX/CSL) consumes the stored CSL
// metadata, not the citekey's surface form, so accented citekeys are safe
// internally. (BibTeX key emission preserves the citekey verbatim; modern
// biber/biblatex accept Unicode keys.)
//
// Collisions (two `Smith2020`) are NOT resolved here — the DB UNIQUE
// constraint is the source of truth, and the caller appends a BibTeX-style
// alpha suffix (`b`, `c`, …; see `alphaSuffix` below) until free. Keeping
// this module pure (no DB access) makes it trivially testable offline.

/**
 * Strip every non-alphanumeric character from `s`, preserving case AND Unicode
 * letters (accents). Whitespace, punctuation, and symbols are dropped; letters
 * and digits — including accented letters (`Ç`, `ü`, `é`) — are kept as-is.
 *
 * Used by {@link generateCitekey} to clean the family-name / title-fallback
 * input while staying author-faithful (no folding, no lowercasing). Empty
 * string stays empty.
 *
 *   alnumOnly("O'Brien")     → "OBrien"
 *   alnumOnly("Çengelköylü") → "Çengelköylü"   (unchanged)
 *   alnumOnly("Smith, J.")   → "SmithJ"
 */
export function alnumOnly(s: string): string {
  if (!s) return "";
  // Unicode-aware: keep any letter (\p{L}) or number (\p{N}). Case and accent
  // marks on letters are preserved verbatim (B-cap decision).
  return s.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Pull the first "significant" word out of a title: skip leading articles
 * (`a`, `an`, `the`, matched case-insensitively), then take the first run of
 * letters — preserving case and accents. Returns the empty string if no
 * significant word is found.
 *
 *   firstSignificantWord("The Crime of Cities") → "Crime"
 *   firstSignificantWord("Çocuk istismarı")     → "Çocuk"
 */
function firstSignificantWord(title: string): string {
  // Match runs of Unicode letters (\p{L}); case + accents preserved. Digits
  // are intentionally excluded so a leading "1984" doesn't become a "word".
  const words = title.match(/[\p{L}]+/gu);
  if (!words || words.length === 0) return "";
  const ARTICLES = new Set(["a", "an", "the"]);
  for (const w of words) {
    if (!ARTICLES.has(w.toLowerCase())) return w;
  }
  // All words were articles — fall back to the first one rather than nothing.
  return words[0];
}

/** Citekey inputs. All fields optional; falls back gracefully. */
export interface CitekeyInput {
  /** First author's family name (surname). */
  family?: string;
  /** Publication year (4-digit). */
  year?: number | null;
  /** Title — used as the family fallback when no author family is present. */
  title?: string | null;
}

/**
 * Generate a deterministic citekey from author/year/title.
 *
 * Format: `Çengelköylü2022` (first-author family, VERBATIM — case + accents
 * preserved, non-alnum stripped) + 4-digit year. If `family` is missing or
 * strips to empty, the first significant word of `title` is used instead
 * (also verbatim). If the year is missing or not a 4-digit number, no year
 * suffix is appended (so the result may be just `Çengelköylü`). All inputs
 * missing → empty string (the caller must then supply a citekey explicitly,
 * since a DB UNIQUE NOT NULL column rejects `""`).
 *
 * Collisions are NOT handled here — the DB UNIQUE constraint is authoritative;
 * the caller appends a BibTeX-style alpha suffix (`b`, `c`, …; see {@link
 * alphaSuffix}) on conflict.
 */
export function generateCitekey(input: CitekeyInput): string {
  let family = "";
  const famRaw = input.family?.trim();
  if (famRaw) {
    family = alnumOnly(famRaw);
  }
  if (!family && input.title) {
    family = firstSignificantWord(input.title);
  }
  if (!family) return "";

  const year = input.year;
  if (
    typeof year === "number" &&
    Number.isFinite(year) &&
    Number.isInteger(year)
  ) {
    const y = Math.trunc(year);
    if (y >= 0 && y <= 9999) {
      // 4-digit zero-padded form (year 50 → "0050"). Matches DESIGN.md's
      // "4-digit year" expectation while tolerating non-modern years.
      return `${family}${String(y).padStart(4, "0")}`;
    }
  }
  return family;
}

/**
 * Disambiguation suffix for a colliding citekey: `0` → `b`, `1` → `c`, …,
 * `24` → `z`, `25` → `aa`, `26` → `ab`, … (bijective base-26, like Excel
 * column letters).
 *
 * BibTeX-style alphabetic suffixing, with one deliberate twist: it SKIPS
 * `a`. The bare citekey (e.g. `Tek2025`) plays the role of `a` for the FIRST
 * reference of a surname+year group; only the SECOND and later colliding
 * refs get a suffix (`Tek2025b`, `Tek2025c`, …). This keeps the scheme
 * APPEND-ONLY — existing citekeys are never renamed, so the FROZEN invariant
 * (docs/citekey.md §5) holds and no `[@citekey]` token ever needs rewriting
 * when a new collision appears.
 *
 * `n` is the 0-based collision index (0 = first collision → `b`).
 *
 *   alphaSuffix(0)  → "b"
 *   alphaSuffix(1)  → "c"
 *   alphaSuffix(24) → "z"
 *   alphaSuffix(25) → "aa"
 *   alphaSuffix(26) → "ab"
 */
export function alphaSuffix(n: number): string {
  // Shift by 2 so index 0 maps to 'b' (skipping 'a'), then encode in
  // bijective base-26 (a=1..z=26, aa=27…). 'a'.charCodeAt(0) === 97.
  let m = n + 2;
  let s = "";
  while (m > 0) {
    m -= 1;
    s = String.fromCharCode(97 + (m % 26)) + s;
    m = Math.floor(m / 26);
  }
  return s;
}
