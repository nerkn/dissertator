// Deterministic citekey generation (P2 Track 3).
//
// A citekey is the stable handle embedded in citation tokens `[@citekey:page]`
// throughout a manuscript (DESIGN.md §8). It is FROZEN after first assignment
// (decision #9) so existing tokens never break — `upsertReference` regenerates
// it only when a reference has none yet, and never overwrites an existing one.
//
// Format: `smith2020` — first-author family (ASCII-folded, lowercased,
// alnum-only) + 4-digit year. If the first author's family is missing, the
// first significant word of the title is used as the family fallback (matches
// the DESIGN.md §8 "fallback to filename slug" spirit for fileless refs).
//
// Collisions (two `smith2020`) are NOT resolved here — the DB UNIQUE constraint
// is the source of truth, and the caller appends `-2`, `-3`, ... until free.
// Keeping this module pure (no DB access) makes it trivially testable offline.

/**
 * Fold common Latin-1 accented letters to their ASCII base (`José`→`Jose`,
 * `Müller`→`Muller`). Covers the top ~30 cases (grave/acute/circumflex/tilde/
 * umlaut on the common Latin-1 vowels, plus ñ, ç, ø, å, æ, ß and capitals).
 * Unknown characters are left verbatim — this is a best-effort fold for
 * readable citekeys, not full Unicode normalization (NFC is applied first as
 * a baseline; the fold table handles the residual combining-form differences).
 */
export function asciiFold(s: string): string {
  // Normalize first so decomposed (NFD) accents (e + combining ´) collapse to
  // the precomposed (NFC) forms the table below handles.
  const nfc = s.normalize("NFC");
  let out = "";
  for (const ch of nfc) {
    out += FOLD[ch] ?? ch;
  }
  return out;
}

/** Fold table: accented Latin-1 letter → ASCII base. ~30 entries. */
const FOLD: Record<string, string> = {
  // grave
  à: "a", è: "e", ì: "i", ò: "o", ù: "u",
  À: "a", È: "e", Ì: "i", Ò: "o", Ù: "u",
  // acute
  á: "a", é: "e", í: "i", ó: "o", ú: "u", ý: "y",
  Á: "a", É: "e", Í: "i", Ó: "o", Ú: "u", Ý: "y",
  // circumflex
  â: "a", ê: "e", î: "i", ô: "o", û: "u",
  Â: "a", Ê: "e", Î: "i", Ô: "o", Û: "u",
  // tilde
  ã: "a", ñ: "n", õ: "o",
  Ã: "a", Ñ: "n", Õ: "o",
  // umlaut / diaeresis
  ä: "a", ë: "e", ï: "i", ö: "o", ü: "u", ÿ: "y",
  Ä: "a", Ë: "e", Ï: "i", Ö: "o", Ü: "u",
  // ring / slash / ligatures / sharp-s
  å: "a", Å: "a", æ: "ae", Æ: "ae", ø: "o", Ø: "o", ß: "ss",
  // cedilla
  ç: "c", Ç: "c",
};

/**
 * Lowercase + strip every non-alphanumeric (used for citekey validation and
 * the post-fold cleanup in {@link generateCitekey}). Empty string stays empty;
 * punctuation, whitespace, and symbols are all dropped. Unicode letters that
 * survived {@link asciiFold} verbatim are left in place by `toLowerCase` —
 * callers should fold first if they want pure-ASCII output.
 */
export function normalizeCitekey(s: string): string {
  if (!s) return "";
  // Unicode-aware: keep any letter (\p{L}) or number (\p{N}), strip the
  // rest. `generateCitekey` folds to ASCII first (so generated keys stay
  // ASCII), but direct calls should not silently delete non-ASCII letters —
  // "Müller2020" → "müller2020", not "mller2020".
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Pull the first "significant" word out of a title: skip leading articles
 * (`a`, `an`, `the`, plus common English equivalents), then take the first
 * run of letters (after ASCII folding). Returns the empty string if no
 * significant word is found.
 */
function firstSignificantWord(title: string): string {
  const folded = asciiFold(title);
  // Match runs of letters (post-fold, so accented letters already became ASCII).
  const words = folded.match(/[A-Za-z]+/g);
  if (!words || words.length === 0) return "";
  const ARTICLES = new Set(["a", "an", "the"]);
  for (const w of words) {
    const lower = w.toLowerCase();
    if (!ARTICLES.has(lower)) return lower;
  }
  // All words were articles — fall back to the first one rather than nothing.
  return words[0].toLowerCase();
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
 * Format: `smith2020` (first-author family, ASCII-folded, lowercased,
 * alnum-only) + 4-digit year. If `family` is missing or folds to empty, the
 * first significant word of `title` is used instead. If the year is missing or
 * not a 4-digit number, no year suffix is appended (so the result may be just
 * `smith`). All inputs missing → empty string (the caller must then supply a
 * citekey explicitly, since a DB UNIQUE NOT NULL column rejects `""`).
 *
 * Collisions are NOT handled here — the DB UNIQUE constraint is authoritative;
 * the caller appends `-2`, `-3`, ... on conflict.
 */
export function generateCitekey(input: CitekeyInput): string {
  let family = "";
  const famRaw = input.family?.trim();
  if (famRaw) {
    family = normalizeCitekey(asciiFold(famRaw));
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
