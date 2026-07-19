import { describe, expect, test } from "bun:test";
import { parseAuthors } from "@dissertator/shared";

describe("shared parseAuthors", () => {
  test("paper-style comma-separated given-first (the copy-paste default)", () => {
    expect(
      parseAuthors("Farveh Farivar, Sergio de Cesare, Najmeh Hafezieh"),
    ).toEqual([
      { given: "Farveh", family: "Farivar" },
      { given: "Sergio de", family: "Cesare" },
      { given: "Najmeh", family: "Hafezieh" },
    ]);
  });

  test("paper order preserved — first author drives citekey", () => {
    const a = parseAuthors("Jane Doe, John Smith");
    expect(a[0]).toEqual({ given: "Jane", family: "Doe" });
  });

  test("arXiv semicolon-separated 'A; B; C'", () => {
    expect(parseAuthors("Nikhil Sethi; Max Lodel; Laura Ferranti")).toEqual([
      { given: "Nikhil", family: "Sethi" },
      { given: "Max", family: "Lodel" },
      { given: "Laura", family: "Ferranti" },
    ]);
  });

  test("BibTeX 'Family, Given; ...' via internal comma", () => {
    expect(parseAuthors("Smith, Jane; Doe, John")).toEqual([
      { family: "Smith", given: "Jane" },
      { family: "Doe", given: "John" },
    ]);
  });

  test("newline is also a separator", () => {
    expect(parseAuthors("Jane Doe\nJohn Smith")).toEqual([
      { given: "Jane", family: "Doe" },
      { given: "John", family: "Smith" },
    ]);
  });

  test("single token becomes family-only", () => {
    expect(parseAuthors("huso")).toEqual([{ family: "huso" }]);
  });

  test("single 'Given Family' (one author)", () => {
    expect(parseAuthors("Jane Doe")).toEqual([
      { given: "Jane", family: "Doe" },
    ]);
  });

  test("empty / whitespace", () => {
    expect(parseAuthors("")).toEqual([]);
    expect(parseAuthors("   ")).toEqual([]);
  });

  test("trailing separators + empty chunks dropped", () => {
    expect(parseAuthors("Jane Doe, , John Smith,")).toEqual([
      { given: "Jane", family: "Doe" },
      { given: "John", family: "Smith" },
    ]);
  });
});
