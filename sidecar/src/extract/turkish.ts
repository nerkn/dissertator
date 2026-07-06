/**
 * Repair text extracted from Turkish PDFs that use broken/legacy Type1 fonts.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some old Turkish academic PDFs embed a Latin-1 font that was *hacked* in the
 * pre-Unicode era to support Turkish: the font author overwrote the outlines of
 * "expendable" glyph slots (ligatures `fi`/`fl`, `currency`, `fraction`,
 * single-guillemets) with Turkish letter shapes — but kept the ORIGINAL glyph
 * names. The font therefore DRAWS the correct letters (screen looks perfect) but
 * its glyph-name → Unicode mapping lies, so pdf.js text extraction returns junk:
 *
 *   ş → "fl"   Ş → "fi"     (the ligature slots)
 *   ğ → "¤"   Ğ → "⁄"       (currency / fraction)
 *   ı → "›"   İ → "‹"       (guilsinglright / guilsinglleft)
 *
 * while ç ö ü Ç Ö Ü extract fine (they exist in Latin-1).
 *
 * The mapping is a fixed table baked into the font, so it is deterministic and
 * fully repairable — except for the two ligature cases (`fl`→ş, `fi`→Ş), which
 * collide with REAL "fl"/"fi" sequences (fiyat, fikir, inflasyon, fizik…). Those
 * are disambiguated with a vowel-context rule + a small loanword protect-list.
 *
 * Everything is GATED behind a "does this look like a broken-font PDF?" test, so
 * clean / English / properly-encoded PDFs are never touched.
 */

const VOWELS = "aeıioöuüâîûAEIİOÖUÜ";
const V = `[${VOWELS}]`; // vowel class for regex

/**
 * Real Turkish words that legitimately begin "fl"+"vowel" or "fi"+"vowel" and
 * must NOT be converted. The set of such loanwords is tiny, so an explicit list
 * is cheap and bullet-proof. (Words like fiyat/fikir/fizik/fil begin fi +
 * CONSONANT, so the vowel-gate already protects them — they aren't listed here.)
 */
const LOANWORDS_FL_FI_VOWEL = new Set<string>([
  // fl + vowel
  "flamenco", "flaman", "flament", "flamingo", "fligran", "flor", "flora",
  "floresan", "florürlü", "florür", "flok", "flokülasyon", "flüt",
  // fi + vowel (very rare)
  "fiyonk", "fiyonklu",
]);

/** Does this text look like it came from a broken-font Turkish PDF? */
export function looksLikeBrokenTurkishPdf(text: string): boolean {
  // The unambiguous markers (¤ › ‹ ⁄ and Latin-1 confusions ð þ ý Ý) essentially
  // never appear in real text. A handful of occurrences ⇒ broken font.
  const n = (
    text.match(/[\u00A4\u2044\u203A\u2039\u00F0\u00DE\u00FE\u00FD\u00DD\u00D0]/g) ||
    []
  ).length;
  return n >= 5;
}

/**
 * Repair ONE ligature pair (e.g. slot "fl" → target "ş").
 *
 * Rules:
 *  (a) MID-WORD: ligature preceded by a vowel  → convert (overwhelmingly corrupt)
 *  (b) WORD-INITIAL: ligature + vowel, and the whole word isn't a known loanword
 *      → convert. (ş/Ş are always followed by a vowel in Turkish.)
 */
function repairLigature(text: string, slot: string, target: string): string {
  // (a) vowel before
  text = text.replace(new RegExp(`(?<=${V})${slot}`, "g"), target);
  // (b) word-initial + vowel after, protecting loanwords. Capture the rest of
  //     the word so we can test the full token against the loanword list.
  const re = new RegExp(`(?<!\\p{L})(${slot})(\\p{L}*)`, "gu");
  text = text.replace(re, (full, lig: string, rest: string) => {
    if (rest.length === 0) return full; // nothing follows
    if (!VOWELS.includes(rest[0])) return full; // lig + consonant ⇒ real word
    const word = (lig + rest).toLowerCase();
    if (LOANWORDS_FL_FI_VOWEL.has(word)) return full; // protected loanword
    return target + rest;
  });
  return text;
}

/**
 * Force the repair on text that is already KNOWN to be from a broken-font PDF
 * (i.e. `looksLikeBrokenTurkishPdf` returned true for the document). Does NOT
 * re-check the gate, so every page gets repaired once the doc is classified.
 */
export function repairTurkishPdfText(input: string): string {
  let text = input;

  // ---- 1. Unambiguous single-codepoint repairs (100% safe) --------------
  // These codepoints never legitimately appear in Turkish/English body text.
  text = text
    .replace(/\u00A4/g, "ğ") // ¤ currency      -> ğ
    .replace(/\u2044/g, "Ğ") // ⁄ fraction       -> Ğ
    .replace(/\u203A/g, "ı") // › guilsinglright -> ı
    .replace(/\u2039/g, "İ") // ‹ guilsinglleft  -> İ
    // Classic ISO-8859-1 vs ISO-8859-9 (Latin-5 Turkish) confusions, in case a
    // given PDF mixes both encoding-bug families:
    .replace(/\u00F0/g, "ğ") // ð eth   -> ğ
    .replace(/\u00D0/g, "Ğ") // Ð Eth   -> Ğ
    .replace(/\u00FE/g, "ş") // þ thorn -> ş
    .replace(/\u00DE/g, "Ş") // Þ Thorn -> Ş
    .replace(/\u00FD/g, "ı") // ý y-acute -> ı
    .replace(/\u00DD/g, "İ"); // Ý Y-acute -> İ

  // ---- 2. Ligature-glyph repairs (vowel-gated, loanword-protected) ------
  text = repairLigature(text, "fl", "ş");
  text = repairLigature(text, "fi", "Ş");

  // ---- 3. De-hyphenate line-wrap breaks --------------------------------
  // PDFs split words across lines as "özellik-\nle". Join lowercase-letter +
  // hyphen + newline + lowercase-letter (avoids touching list-item dashes).
  text = text.replace(/([a-zğşıçöü])-\r?\n([a-zğşıçöü])/g, "$1$2");

  return text;
}

/**
 * Repair broken-font Turkish text. Returns the input UNCHANGED if it does not
 * look like a broken-font PDF (safe to call on any text). Legacy alias.
 */
export function normalizeTurkishPdfText(input: string): string {
  return looksLikeBrokenTurkishPdf(input)
    ? repairTurkishPdfText(input)
    : input;
}
