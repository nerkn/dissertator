import { describe, expect, test } from "bun:test";
import { isJunkAuthor, parseAuthors, parseYear } from "./pdfmeta.ts";
import { parseLlmReferenceJson } from "./llmExtract.ts";

describe("parseLlmReferenceJson", () => {
  test("parses a clean JSON object", () => {
    const r = parseLlmReferenceJson(
      '{"title":"On the electrodynamics of moving bodies","authors":[{"family":"Einstein","given":"Albert"}],"year":1905,"venue":"Annalen der Physik","doi":"10.1002/andp.19053221004"}',
    );
    expect(r).toEqual({
      title: "On the electrodynamics of moving bodies",
      authors: [{ family: "Einstein", given: "Albert" }],
      year: 1905,
      venue: "Annalen der Physik",
      doi: "10.1002/andp.19053221004",
    });
  });

  test("tolerates ```json fences and trailing prose", () => {
    const r = parseLlmReferenceJson(
      'Sure! Here is the metadata:\n```json\n{"title":"X","authors":[{"family":"Doe"}]}\n```\nLet me know.',
    );
    expect(r?.title).toBe("X");
    expect(r?.authors).toEqual([{ family: "Doe", given: undefined }]);
  });

  test("strips a doi: URL prefix the model may have added", () => {
    const r = parseLlmReferenceJson(
      '{"title":"T","authors":[{"family":"Doe"}],"doi":"https://doi.org/10.1038/nature123"}',
    );
    expect(r?.doi).toBe("10.1038/nature123");
  });

  test("rejects a non-10. doi string", () => {
    const r = parseLlmReferenceJson(
      '{"title":"T","authors":[{"family":"Doe"}],"doi":"not-a-doi"}',
    );
    expect(r?.doi).toBeUndefined();
  });

  test("extracts a 4-digit year from a string", () => {
    const r = parseLlmReferenceJson(
      '{"title":"T","authors":[{"family":"Doe"}],"year":"published 1999"}',
    );
    expect(r?.year).toBe(1999);
  });

  test("returns null when neither title nor authors survive", () => {
    expect(parseLlmReferenceJson('{"year":2020,"venue":"X"}')).toBeNull();
  });

  test("returns null on garbage / empty", () => {
    expect(parseLlmReferenceJson("")).toBeNull();
    expect(parseLlmReferenceJson("no json here at all")).toBeNull();
    expect(parseLlmReferenceJson("{not valid json}")).toBeNull();
  });
});

describe("parseAuthors", () => {
  test("arXiv semicolon-separated 'A; B; C'", () => {
    expect(parseAuthors("Nikhil Sethi; Max Lodel; Laura Ferranti")).toEqual([
      { family: "Sethi", given: "Nikhil" },
      { family: "Lodel", given: "Max" },
      { family: "Ferranti", given: "Laura" },
    ]);
  });

  test("'Family, Given; Family, Given'", () => {
    expect(parseAuthors("Smith, Jane; Doe, John")).toEqual([
      { family: "Smith", given: "Jane" },
      { family: "Doe", given: "John" },
    ]);
  });

  test("single token becomes family-only", () => {
    expect(parseAuthors("huso")).toEqual([{ family: "huso", given: undefined }]);
  });

  test("drops tooling artifacts", () => {
    expect(parseAuthors("Microsoft Word 2013; Jane Smith")).toEqual([
      { family: "Smith", given: "Jane" },
    ]);
    expect(isJunkAuthor("Microsoft® Word 2013")).toBe(true);
    expect(isJunkAuthor("Adobe Acrobat Pro")).toBe(true);
    expect(isJunkAuthor("Jane Smith")).toBe(false);
  });
});

describe("parseYear", () => {
  test("pdf CreationDate 'D:YYYYMMDD...'", () => {
    expect(parseYear("D:20170712180233+03'00'")).toBe(2017);
  });
  test("undefined → null", () => {
    expect(parseYear(undefined)).toBeNull();
  });
});
