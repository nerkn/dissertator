// Tests for citekey generation (P2 Track 3) — pure logic, no DB, no network.
//
// Pins the format contract (`Çengelköylü2022`: first-author family, VERBATIM —
// case + accents preserved, non-alnum stripped — + 4-digit year), the
// family→title fallback, the missing-year branch, accent/case preservation,
// and alnumOnly's punctuation stripping. Collisions are deliberately NOT
// tested here — they are resolved at the DB layer in `upsertReference`
// (db.ts), not in this pure helper.

import { describe, expect, test } from "bun:test";
import { alnumOnly, generateCitekey } from "./citekey.ts";

describe("generateCitekey", () => {
  test("family + year → `Smith2020` (case preserved, alnum-only)", () => {
    expect(
      generateCitekey({ family: "Smith", year: 2020, title: "A Study" })
    ).toBe("Smith2020");
  });

  test("preserves accents AND case (José→José, Müller→Müller, Çengelköylü→Çengelköylü)", () => {
    expect(
      generateCitekey({ family: "José", year: 2019, title: "X" })
    ).toBe("José2019");
    expect(
      generateCitekey({ family: "Müller", year: 2018, title: "X" })
    ).toBe("Müller2018");
    expect(
      generateCitekey({ family: "Çengelköylü", year: 2022, title: "X" })
    ).toBe("Çengelköylü2022");
  });

  test("strips non-alnum from the family but keeps case (O'Brien→OBrien, Garcia-Lopez→GarciaLopez)", () => {
    expect(
      generateCitekey({ family: "O'Brien", year: 2010, title: "X" })
    ).toBe("OBrien2010");
    expect(
      generateCitekey({ family: "Garcia-Lopez", year: 2005, title: "X" })
    ).toBe("GarciaLopez2005");
  });

  test("missing family → first significant word of title (case + accents preserved, skipping leading article)", () => {
    // "The Crime of ..." → first significant word "Crime".
    expect(
      generateCitekey({ title: "The Crime of Cities", year: 2021 })
    ).toBe("Crime2021");
    // No article at all.
    expect(
      generateCitekey({ title: "Quantitative Methods", year: 2022 })
    ).toBe("Quantitative2022");
    // Turkish title fallback, accent + case preserved.
    expect(
      generateCitekey({ title: "Çocuk istismarı vakası", year: 2025 })
    ).toBe("Çocuk2025");
  });

  test("missing year → just the family, no suffix", () => {
    expect(generateCitekey({ family: "Doe" })).toBe("Doe");
    expect(generateCitekey({ family: "Doe", year: null })).toBe("Doe");
  });

  test("all inputs missing → empty string (caller must supply a citekey)", () => {
    expect(generateCitekey({})).toBe("");
    expect(generateCitekey({ family: "  ", title: "   " })).toBe("");
  });
});

describe("alnumOnly", () => {
  test("strips non-alnum (punctuation, spaces, symbols), preserves case + accents", () => {
    expect(alnumOnly("Smith, J. 2020!")).toBe("SmithJ2020");
    expect(alnumOnly("O'Brien-2020")).toBe("OBrien2020");
    expect(alnumOnly("Çengelköylü")).toBe("Çengelköylü");
    expect(alnumOnly("Müller2020")).toBe("Müller2020");
  });

  test("empty string stays empty (no padding)", () => {
    expect(alnumOnly("")).toBe("");
    expect(alnumOnly("   ")).toBe("");
  });
});
