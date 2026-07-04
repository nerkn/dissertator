// Tests for the hand-rolled BibTeX parser/serializer (P2 Track 3).
//
// Pure logic, NO dependencies, NO network. Pins the public contract:
//   - `parseBibtex(text)`  → Reference[]  (entry key → citekey)
//   - `toBibtex(ref)`      → string       (single-entry serialization)
//   - `exportBibtex(refs)` → string       (joined with blank lines)
//   - `foldLatexAccents(s)` → Unicode on the PARSE direction
//
// MALFORMED ENTRIES ARE SKIPPED, never thrown — a half-broken .bib still
// imports the good entries (matches the Crossref "never crash" discipline).

import { describe, expect, test } from "bun:test";
import type { Reference } from "@dissertator/shared";
import { exportBibtex, foldLatexAccents, parseBibtex, toBibtex } from "./bibtex.ts";

/** Build a Reference with sensible defaults so test cases stay terse. */
function ref(over: Partial<Reference>): Reference {
  return {
    id: "",
    citekey: "",
    title: null,
    authors: [],
    year: null,
    doi: null,
    type: null,
    venue: null,
    csl_json: null,
    source_file_id: null,
    ...over,
  };
}

describe("foldLatexAccents", () => {
  test("acute accents: \\'e → é", () => {
    expect(foldLatexAccents("Jos\\'e")).toBe("José");
  });

  test("umlauts: \\\"o → ö, \\\"u → ü, \\\"a → ä", () => {
    expect(foldLatexAccents("M\\\"uller")).toBe("Müller");
    expect(foldLatexAccents("\\\"osterreich")).toBe("österreich"); // contrived but valid
    expect(foldLatexAccents("\\\"anderung")).toBe("änderung");
  });

  test("tilde + cedilla: \\~n → ñ, \\c{c} → ç", () => {
    expect(foldLatexAccents("Espa\\~na")).toBe("España");
    expect(foldLatexAccents("fa\\c{c}ade")).toBe("façade");
  });

  test("unknown escapes left verbatim (backslash preserved)", () => {
    expect(foldLatexAccents("foo \\xyz bar")).toBe("foo \\xyz bar");
  });

  test("empty string passthrough", () => {
    expect(foldLatexAccents("")).toBe("");
  });
});

describe("parseBibtex", () => {
  test("parses a simple article: key → citekey, fields mapped", () => {
    const text = `@article{smith2020,
      title = {Crime and the City},
      author = {Smith, Jane},
      year = {2020},
      journal = {Journal of Sociology},
      doi = {10.1000/xyz123}
    }`;
    const refs = parseBibtex(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual(
      ref({
        citekey: "smith2020",
        title: "Crime and the City",
        authors: [{ family: "Smith", given: "Jane" }],
        year: 2020,
        doi: "10.1000/xyz123",
        type: "article-journal",
        venue: "Journal of Sociology",
      })
    );
  });

  test("multi-author: splits on ' and ', both name orders", () => {
    const refs = parseBibtex(`@book{multi,
      author = {Family, Given and Other Author and Doe, John},
      title = {T}
    }`);
    expect(refs[0].authors).toEqual([
      { family: "Family", given: "Given" }, // comma form
      { family: "Author", given: "Other" }, // space form → last token = family
      { family: "Doe", given: "John" },
    ]);
  });

  test("quoted values (double-quote delimiter) parse like brace values", () => {
    const refs = parseBibtex(`@article{q,
      title = "Quoted Title",
      year = "1999"
    }`);
    expect(refs[0].title).toBe("Quoted Title");
    expect(refs[0].year).toBe(1999);
  });

  test("nested braces inside a value are preserved (not treated as delimiters)", () => {
    const refs = parseBibtex(`@article{nest,
      title = {A {Special} Title}
    }`);
    expect(refs[0].title).toBe("A {Special} Title");
  });

  test("LaTeX accents folded on parse (Jos\\'e → José)", () => {
    const refs = parseBibtex(`@article{accent,
      author = {Jos\\'e, Mar\\'ia},
      title = {Caf\\'e}
    }`);
    expect(refs[0].authors[0].family).toBe("José");
    expect(refs[0].authors[0].given).toBe("María");
    expect(refs[0].title).toBe("Café");
  });

  test("entry type maps to CSL (book → book, inproceedings → paper-conference)", () => {
    const refs = parseBibtex(
      `@book{b, title = {B}}\n@inproceedings{p, title = {P}}\n@misc{u, title = {U}}`
    );
    expect(refs[0].type).toBe("book");
    expect(refs[1].type).toBe("paper-conference");
    expect(refs[2].type).toBe("misc"); // unmapped type passes through
  });

  test("multiple entries parsed in order", () => {
    const refs = parseBibtex(`@article{a, title = {First}}
      @book{b, title = {Second}}`);
    expect(refs).toHaveLength(2);
    expect(refs[0].citekey).toBe("a");
    expect(refs[1].citekey).toBe("b");
  });

  test("malformed entry (missing close brace) is skipped, good entries still parsed", () => {
    const text = `@article{good, title = {Good}}
      @article{bad, title = {Never Closed`;
    const refs = parseBibtex(text);
    expect(refs).toHaveLength(1);
    expect(refs[0].citekey).toBe("good");
  });

  test("garbage before @ is ignored, no entries → []", () => {
    expect(parseBibtex("just some prose, no entries")).toEqual([]);
    expect(parseBibtex("")).toEqual([]);
  });

  test("year non-numeric → null (no NaN leaks out)", () => {
    const refs = parseBibtex(`@article{ny, year = {forthcoming}}`);
    expect(refs[0].year).toBeNull();
  });
});

describe("toBibtex", () => {
  test("serializes a reference with all fields", () => {
    const out = toBibtex(
      ref({
        citekey: "smith2020",
        title: "Crime and the City",
        authors: [
          { family: "Smith", given: "Jane" },
          { family: "Jones", given: "Bob" },
        ],
        year: 2020,
        doi: "10.1000/xyz123",
        type: "article-journal",
        venue: "Journal of Sociology",
      })
    );
    // Article type + key.
    expect(out.startsWith("@article{smith2020,\n")).toBe(true);
    // Authors joined with " and ", comma form.
    expect(out).toContain("author = {Smith, Jane and Jones, Bob}");
    expect(out).toContain("title = {Crime and the City}");
    expect(out).toContain("year = {2020}");
    // Article uses `journal`, not `booktitle`.
    expect(out).toContain("journal = {Journal of Sociology}");
    expect(out).toContain("doi = {10.1000/xyz123}");
    // Closes cleanly.
    expect(out.endsWith("}\n")).toBe(true);
  });

  test("non-article type uses `booktitle` for venue", () => {
    const out = toBibtex(
      ref({ citekey: "p1", type: "paper-conference", venue: "Proceedings" })
    );
    expect(out).toContain("booktitle = {Proceedings}");
    expect(out.startsWith("@inproceedings{p1,")).toBe(true);
  });

  test("empty citekey → key 'untitled'", () => {
    const out = toBibtex(ref({ title: "X" }));
    expect(out.startsWith("@misc{untitled,")).toBe(true);
  });

  test("omits absent fields (no empty lines)", () => {
    const out = toBibtex(ref({ citekey: "bare", title: "Only Title" }));
    expect(out).toContain("title = {Only Title}");
    expect(out).not.toContain("author");
    expect(out).not.toContain("year");
    expect(out).not.toContain("doi");
  });
});

describe("exportBibtex", () => {
  test("joins multiple entries with blank lines", () => {
    const out = exportBibtex([
      ref({ citekey: "a", title: "First" }),
      ref({ citekey: "b", title: "Second" }),
    ]);
    // Two entries separated by exactly one blank line.
    expect(out).toContain("@misc{a,\n");
    expect(out).toContain("@misc{b,\n");
    expect(out.match(/\n\n/g)?.length).toBe(1);
  });

  test("empty input → empty string", () => {
    expect(exportBibtex([])).toBe("");
  });
});

describe("round-trip", () => {
  test("parse → serialize → re-parse recovers citekey, title, year, doi", () => {
    const original = `@article{doe2021,
      title = {Round Trip},
      author = {Doe, John},
      year = {2021},
      doi = {10.1/rt},
      journal = {JoT}
    }`;
    const parsed1 = parseBibtex(original);
    expect(parsed1).toHaveLength(1);
    const serialized = toBibtex(parsed1[0]);
    const parsed2 = parseBibtex(serialized);
    expect(parsed2).toHaveLength(1);
    expect(parsed2[0].citekey).toBe("doe2021");
    expect(parsed2[0].title).toBe("Round Trip");
    expect(parsed2[0].year).toBe(2021);
    expect(parsed2[0].doi).toBe("10.1/rt");
    expect(parsed2[0].authors[0].family).toBe("Doe");
  });
});
