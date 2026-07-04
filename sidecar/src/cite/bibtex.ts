// Hand-rolled minimal BibTeX import/export (P2 Track 3). NO dependencies.
//
// BibTeX is the lingua franca of bibliographies, but pulling in a parser dep
// for what we need (a handful of entry types, brace/quoted values, a couple
// of LaTeX accent escapes) is overkill. This module covers the common 95%
// case: `@type{key, field = {value}, ...}` entries, with both brace-`{}`
// and quoted-`"` value delimiters, nested braces inside values, multi-author
// ` and `-separated lists, and the top ~10 LaTeX accent escapes on PARSE
// (so `Jos\'e` comes out as `José`). SERIALIZE stays plain ASCII (round-trip
// fidelity is enough; we don't aim to reproduce a specific BibTeX dialect).
//
// PUBLIC CONTRACT:
//   - `parseBibtex(text)`  → Reference[]   (entry key becomes citekey)
//   - `toBibtex(ref)`      → string        (single-entry serialization)
//   - `exportBibtex(refs)` → string        (joined with blank lines)
//
// MALFORMED ENTRIES (missing close brace, garbage before `@`, etc.) are
// SKIPPED, never thrown — a half-broken .bib still imports the good entries.
// This matches the "never crash" discipline used by the Crossref adapter.

import type { Author, Reference } from "@dissertator/shared";

/** Map common BibTeX entry types to CSL types for the `type` field. */
const TYPE_TO_CSL: Record<string, string> = {
  article: "article-journal",
  book: "book",
  booklet: "book",
  inbook: "chapter",
  incollection: "chapter",
  inproceedings: "paper-conference",
  conference: "paper-conference",
  manual: "book",
  mastersthesis: "thesis",
  phdthesis: "thesis",
  proceedings: "book",
  techreport: "report",
  unpublished: "manuscript",
};

/**
 * Fold the top ~10 LaTeX accent escapes to their Unicode equivalents, for the
 * PARSE direction only (so accented names/titles import correctly). Covers
 * the common Western-European accents: `\'e`→`é`, `\"o`→`ö`, `\"u`→`ü`,
 * `\`e`→`è`, `\^e`→`ê`, `\~n`→`ñ`, `\"a`→`ä`, `\"A`→`Ä`, `\'a`→`á`, `\'E`→`É`.
 * Unknown escapes are left verbatim (the backslash is preserved).
 *
 * SERIALIZE (`toBibtex`) goes the other way conceptually but stays plain
 * ASCII — we don't emit LaTeX escapes, we just write the Unicode through.
 */
export function foldLatexAccents(s: string): string {
  if (!s) return "";
  return s
    // Acute (´): \'x
    .replace(/\\'a/g, "á")
    .replace(/\\'e/g, "é")
    .replace(/\\'i/g, "í")
    .replace(/\\'o/g, "ó")
    .replace(/\\'u/g, "ú")
    .replace(/\\'A/g, "Á")
    .replace(/\\'E/g, "É")
    // Grave (`): \`x
    .replace(/\\`a/g, "à")
    .replace(/\\`e/g, "è")
    .replace(/\\`i/g, "ì")
    .replace(/\\`o/g, "ò")
    .replace(/\\`u/g, "ù")
    // Circumflex (^): \^x
    .replace(/\\\^a/g, "â")
    .replace(/\\\^e/g, "ê")
    .replace(/\\\^i/g, "î")
    .replace(/\\\^o/g, "ô")
    .replace(/\\\^u/g, "û")
    // Umlaut/diaeresis ("): \"x
    .replace(/\\"a/g, "ä")
    .replace(/\\"e/g, "ë")
    .replace(/\\"i/g, "ï")
    .replace(/\\"o/g, "ö")
    .replace(/\\"u/g, "ü")
    .replace(/\\"y/g, "ÿ")
    .replace(/\\"A/g, "Ä")
    .replace(/\\"O/g, "Ö")
    .replace(/\\"U/g, "Ü")
    // Tilde (~): \~x
    .replace(/\\~n/g, "ñ")
    .replace(/\\~N/g, "Ñ")
    .replace(/\\~a/g, "ã")
    .replace(/\\~o/g, "õ")
    // Cedilla: \c{c}
    .replace(/\\c\{c\}/g, "ç")
    .replace(/\\c\{C\}/g, "Ç")
    // aa / ae / oe / ss ligatures (common in names)
    .replace(/\\aa\b/g, "å")
    .replace(/\\AA\b/g, "Å")
    .replace(/\\ae\b/g, "æ")
    .replace(/\\AE\b/g, "Æ")
    .replace(/\\o\b/g, "ø")
    .replace(/\\O\b/g, "Ø")
    .replace(/\\ss\b/g, "ß");
}

/** Trim ASCII whitespace + one layer of matching braces/quotes (BibTeX value). */
function unwrapDelimiters(v: string): string {
  const t = v.trim();
  if (
    t.length >= 2 &&
    ((t[0] === "{" && t[t.length - 1] === "}") ||
      (t[0] === '"' && t[t.length - 1] === '"'))
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a BibTeX `author = "..."` value into {@link Author}[].
 *
 * Splits on top-level ` and ` (case-insensitive). Each name is either
 * `Family, Given` (comma first) or `Given Family` (space-separated, last
 * token = family). Empty parts are dropped. LaTeX accents are folded.
 */
function parseAuthors(raw: string): Author[] {
  if (!raw) return [];
  // Split on " and " / " AND " / " And " (case-insensitive), NOT inside braces.
  const parts = splitTopLevel(raw, /\s+and\s+/i, " and ");
  const out: Author[] = [];
  for (let p of parts) {
    p = foldLatexAccents(p.trim());
    if (!p) continue;
    const comma = p.indexOf(",");
    if (comma >= 0) {
      const family = p.slice(0, comma).trim();
      const given = p.slice(comma + 1).trim();
      out.push({ family: family || undefined, given: given || undefined });
    } else {
      // "Given Middle Family" → family = last token.
      const toks = p.split(/\s+/).filter(Boolean);
      if (toks.length === 0) continue;
      const family = toks[toks.length - 1];
      const given = toks.slice(0, -1).join(" ");
      out.push({ family, given: given || undefined });
    }
  }
  return out;
}

/**
 * Split `s` on `delim`, ignoring matches inside `{...}` brace groups (so a
 * delimiter that appears inside a value's braces is not treated as a
 * separator). `literal` is the substring used for the regex source when the
 * regex itself contains escapes; we re-scan char-by-char to honor braces.
 */
function splitTopLevel(
  s: string,
  _delim: RegExp,
  literal: string
): string[] {
  void _delim; // delimiter shape documented above; brace-aware scan is used.
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "{") {
      depth++;
      cur += ch;
      continue;
    }
    if (ch === "}") {
      depth = Math.max(0, depth - 1);
      cur += ch;
      continue;
    }
    if (depth === 0 && s.slice(i, i + literal.length).toLowerCase() === literal.toLowerCase()) {
      out.push(cur);
      cur = "";
      i += literal.length - 1;
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/** Parsed entry: type, citekey (the BibTeX key), and field map. */
interface BibtexEntry {
  type: string;
  citekey: string;
  fields: Record<string, string>;
}

/**
 * Parse a single BibTeX entry starting at index `i` (which MUST point at the
 * `@`). Returns the entry + the index past its closing `}`, or null if the
 * entry is malformed (no `{`, no key, no closing brace). Does not throw.
 */
function parseEntry(text: string, i: number): { entry: BibtexEntry; end: number } | null {
  // @type{key, ... } OR @type(key, ... ) — we support both delimiters, though
  // braces are by far the common form.
  const n = text.length;
  if (text[i] !== "@") return null;
  // Entry type: letters.
  let j = i + 1;
  while (j < n && /[A-Za-z]/.test(text[j]!)) j++;
  const type = text.slice(i + 1, j).toLowerCase();
  if (!type) return null;
  // Opening brace or paren.
  while (j < n && /\s/.test(text[j]!)) j++;
  const open = text[j];
  if (open !== "{" && open !== "(") return null;
  const close = open === "{" ? "}" : ")";
  j++;
  // Citekey: up to the first comma.
  const keyStart = j;
  while (j < n && text[j] !== "," && text[j] !== close) j++;
  if (j >= n) return null; // unterminated
  const citekey = text.slice(keyStart, j).trim();
  if (!citekey) return null;
  if (text[j] === close) {
    // Empty entry `@type{key}` — legal but bare; take it.
    return { entry: { type, citekey, fields: {} }, end: j + 1 };
  }
  // Past the comma: fields.
  j++; // consume the comma
  const fields: Record<string, string> = {};
  while (j < n) {
    // Skip whitespace + extra commas.
    while (j < n && /[\s,]/.test(text[j]!)) j++;
    if (j < n && text[j] === close) break;
    // Field name: letters/digits/underscore/dash.
    const nameStart = j;
    while (j < n && /[A-Za-z0-9_\-+:.]/.test(text[j]!)) j++;
    const name = text.slice(nameStart, j).toLowerCase();
    if (!name) break; // garbage — bail out, entry is malformed from here
    // '=' with optional surrounding whitespace.
    while (j < n && /\s/.test(text[j]!)) j++;
    if (text[j] !== "=") break;
    j++; // consume '='
    while (j < n && /\s/.test(text[j]!)) j++;
    // Value: brace-delimited, quote-delimited, or bare (until comma/close).
    const valRes = readValue(text, j, close);
    if (valRes == null) break;
    fields[name] = valRes.value;
    j = valRes.end;
    // Continue to next field (whitespace/commas skipped at loop top).
  }
  // Advance to the matching close brace (readValue may have stopped early on
  // a parse hiccup; find the true end so the outer scanner resyncs cleanly).
  let depth = 1;
  while (j < n && depth > 0) {
    const ch = text[j]!;
    if (ch === open) depth++;
    else if (ch === close) depth--;
    if (depth === 0) break;
    j++;
  }
  if (j >= n) return null; // never closed — malformed, skip
  return { entry: { type, citekey, fields }, end: j + 1 };
}

/**
 * Read a field value starting at `i`. Supports:
 *   - brace-delimited `{...}` (with nested braces — depth-tracked);
 *   - quote-delimited `"..."` (no nesting; stops at the next `"`);
 *   - bareword (until comma or the entry's close char).
 * Returns the RAW value string (delimiters preserved) + the index past it,
 * or null if there's no value to read.
 */
function readValue(
  text: string,
  i: number,
  close: string
): { value: string; end: number } | null {
  const n = text.length;
  if (i >= n) return null;
  const ch = text[i];
  if (ch === "{") {
    let depth = 1;
    let j = i + 1;
    while (j < n && depth > 0) {
      const c = text[j]!;
      if (c === "{") depth++;
      else if (c === "}") depth--;
      if (depth === 0) break;
      j++;
    }
    if (j >= n) return null; // unterminated braces
    // Keep the outer braces so unwrapDelimiters can strip them uniformly.
    return { value: text.slice(i, j + 1), end: j + 1 };
  }
  if (ch === '"') {
    let j = i + 1;
    while (j < n && text[j] !== '"') j++;
    if (j >= n) return null;
    return { value: text.slice(i, j + 1), end: j + 1 };
  }
  // Bareword: until comma or close (BibTeX concatenation `#` is not supported
  // in this minimal parser — rare in the wild for our use case).
  let j = i;
  while (j < n && text[j] !== "," && text[j] !== close) j++;
  if (j === i) return null;
  return { value: text.slice(i, j), end: j };
}

/**
 * Parse BibTeX text into {@link Reference}[].
 *
 * Recognizes `@type{key, field = {value}, ...}` entries (brace or paren
 * bodies, brace/quoted/bareword values, nested braces inside values). Maps
 * common fields: `author` (split on ` and `, `Family, Given` and `Given
 * Family`), `title`, `year`, `doi`, `journal`→venue, `booktitle`→venue. The
 * entry key becomes the citekey. LaTeX accents are folded. MALFORMED entries
 * (unterminated, no key, garbage) are skipped — the function never throws.
 *
 * The returned References have empty `id` (assigned on commit by
 * `upsertReference`) and the BibTeX key as `citekey` (caller may regenerate).
 */
export function parseBibtex(text: string): Reference[] {
  const out: Reference[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    // Find the next `@` that starts an entry.
    const at = text.indexOf("@", i);
    if (at < 0) break;
    const parsed = parseEntry(text, at);
    if (!parsed) {
      i = at + 1;
      continue;
    }
    const { type, citekey, fields } = parsed.entry;
    const get = (k: string): string =>
      unwrapDelimiters(foldLatexAccents(fields[k] ?? "")).trim();

    const yearRaw = get("year");
    const yearNum = yearRaw ? parseInt(yearRaw, 10) : NaN;
    const year =
      Number.isFinite(yearNum) && yearNum > 0 ? yearNum : null;

    const venue = get("journal") || get("booktitle") || null;
    const authors = parseAuthors(get("author"));
    const title = get("title") || null;
    const doi = get("doi") || get("DOI") || null;
    const cslType = TYPE_TO_CSL[type] ?? type ?? null;

    out.push({
      id: "",
      citekey,
      title,
      authors,
      year,
      doi,
      type: cslType,
      venue,
      // No CSL JSON is reconstructed from BibTeX — citeproc-js rendering of
      // imported .bib entries is a later concern (the structured fields above
      // are enough for the reference list + citekey generation).
      csl_json: null,
      source_file_id: null,
    });
    i = parsed.end;
  }
  return out;
}

/** BibTeX-safe string: collapse internal braces (round-trip fidelity only). */
function bibtexField(key: string, value: string): string {
  // Wrap in braces so values with spaces/special chars round-trip safely.
  // We don't escape LaTeX specials — round-trip fidelity is enough.
  const v = value.replace(/[\r\n]+/g, " ").trim();
  if (!v) return "";
  return `  ${key} = {${v}},\n`;
}

/** Map a CSL type back to a BibTeX entry type (best effort). */
function cslToBibtexType(csl: string | null): string {
  if (!csl) return "misc";
  const map: Record<string, string> = {
    "article-journal": "article",
    book: "book",
    chapter: "incollection",
    "paper-conference": "inproceedings",
    thesis: "phdthesis",
    report: "techreport",
    manuscript: "unpublished",
  };
  return map[csl] ?? "misc";
}

/**
 * Serialize a single {@link Reference} as one BibTeX entry.
 *
 * Format: `@article{key, field = {value}, ...}`. Authors are joined as
 * `Family, Given and ...`. The citekey is used verbatim. `year`/`doi`/`title`/
 * `venue` (as `journal` for articles, `booktitle` otherwise) are emitted when
 * present. Output is plain ASCII (no LaTeX accent escapes emitted); this
 * sacrifices dialect fidelity for round-trip simplicity.
 */
export function toBibtex(ref: Reference): string {
  const type = bibtexTypeFor(ref);
  const key = ref.citekey || "untitled";
  let out = `@${type}{${key},\n`;
  const authors = ref.authors
    .map((a) => {
      const f = (a.family ?? "").trim();
      const g = (a.given ?? "").trim();
      if (f && g) return `${f}, ${g}`;
      return f || g;
    })
    .filter(Boolean)
    .join(" and ");
  if (authors) out += bibtexField("author", authors);
  if (ref.title) out += bibtexField("title", ref.title);
  if (ref.year != null) out += bibtexField("year", String(ref.year));
  if (ref.venue) {
    out += bibtexField(type === "article" ? "journal" : "booktitle", ref.venue);
  }
  if (ref.doi) out += bibtexField("doi", ref.doi);
  // Trim the trailing comma+newline of the last field for a clean close.
  out = out.replace(/,\n$/, "\n");
  out += "}\n";
  return out;
}

/** Resolve the BibTeX entry type for serialization (article vs others). */
function bibtexTypeFor(ref: Reference): string {
  const t = cslToBibtexType(ref.type);
  // `article` uses `journal`; everything else uses `booktitle` for venue.
  return t;
}

/**
 * Serialize multiple References as a single BibTeX document. Entries are
 * joined with a single blank line between them. Empty input → empty string.
 */
export function exportBibtex(refs: Reference[]): string {
  return refs.map(toBibtex).join("\n");
}
