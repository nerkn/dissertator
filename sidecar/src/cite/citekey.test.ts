// Tests for citekey generation (P2 Track 3) — pure logic, no DB, no network.
//
// Pins the format contract (`smith2020`: first-author family, ASCII-folded,
// lowercased, alnum-only + 4-digit year), the family→title fallback, the
// missing-year branch, accent folding (José/Müller), and normalize's
// punctuation stripping. Collisions are deliberately NOT tested here — they
// are resolved at the DB layer in `upsertReference` (db.ts), not in this
// pure helper.

import { describe, expect, test } from "bun:test";
import {
  asciiFold,
  generateCitekey,
  normalizeCitekey,
} from "./citekey.ts";

describe("generateCitekey", () => {
  test("family + year → `smith2020` (lowercased, alnum-only)", () => {
    expect(
      generateCitekey({ family: "Smith", year: 2020, title: "A Study" })
    ).toBe("smith2020");
  });

  test("folds accents before lowercasing (José → jose, Müller → muller)", () => {
    expect(
      generateCitekey({ family: "José", year: 2019, title: "X" })
    ).toBe("jose2019");
    expect(
      generateCitekey({ family: "Müller", year: 2018, title: "X" })
    ).toBe("muller2018");
  });

  test("strips non-alnum from the family (O'Brien → obrien, Garcia-Lopez → garcialopez)", () => {
    expect(
      generateCitekey({ family: "O'Brien", year: 2010, title: "X" })
    ).toBe("obrien2010");
    expect(
      generateCitekey({ family: "Garcia-Lopez", year: 2005, title: "X" })
    ).toBe("garcialopez2005");
  });

  test("missing family → first significant word of title (skipping leading article)", () => {
    // "The Crime of ..." → first significant word "crime".
    expect(
      generateCitekey({ title: "The Crime of Cities", year: 2021 })
    ).toBe("crime2021");
    // No article at all.
    expect(
      generateCitekey({ title: "Quantitative Methods", year: 2022 })
    ).toBe("quantitative2022");
  });

  test("missing year → just the family, no suffix", () => {
    expect(generateCitekey({ family: "Doe" })).toBe("doe");
    expect(generateCitekey({ family: "Doe", year: null })).toBe("doe");
  });

  test("all inputs missing → empty string (caller must supply a citekey)", () => {
    expect(generateCitekey({})).toBe("");
    expect(generateCitekey({ family: "  ", title: "   " })).toBe("");
  });
});

describe("asciiFold", () => {
  test("José → Jose, Müller → Muller (precomposed NFC input)", () => {
    expect(asciiFold("José")).toBe("Jose");
    expect(asciiFold("Müller")).toBe("Muller");
  });

  test("folds decomposed (NFD) input too (NFC normalize first)", () => {
    // "José" as J + o + s + e + combining acute (NFD).
    const nfd = "Jose\u0301";
    expect(asciiFold(nfd)).toBe("Jose");
  });

  test("unknown accents left verbatim", () => {
    // Cyrillic / CJK / etc. are not in the fold table — preserved.
    expect(asciiFold("Иванов")).toBe("Иванов");
    expect(asciiFold("田中")).toBe("田中");
  });
});

describe("normalizeCitekey", () => {
  test("lowercases + strips non-alnum (punctuation, spaces, symbols)", () => {
    expect(normalizeCitekey("Smith, J. 2020!")).toBe("smithj2020");
    expect(normalizeCitekey("O'Brien-2020")).toBe("obrien2020");
  });

  test("empty string stays empty (no padding)", () => {
    expect(normalizeCitekey("")).toBe("");
    expect(normalizeCitekey("   ")).toBe("");
  });

  test("unicode letters survive (post-fold; normalize does not fold)", () => {
    // normalizeCitekey itself does NOT fold — it only lowercases + strips
    // non-alnum. Callers fold first if they want pure ASCII. Non-ASCII letters
    // are kept by `toLowerCase` here.
    expect(normalizeCitekey("Müller2020")).toBe("müller2020");
  });
});
