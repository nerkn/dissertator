// Tests for DOI extraction (auto reference detection — "Option A").
//
// Pure logic: no DB, no network. Pins the regex, trailing-punctuation
// trimming, paren/bracket balancing, ordering (first appearance), de-dup, and
// lowercasing.

import { describe, expect, test } from "bun:test";
import { extractDois, firstPageRegion } from "./doi.ts";
import { normTitle, titlesMatch } from "./titleMatch.ts";

describe("extractDois", () => {
  test("extracts a plain DOI", () => {
    expect(extractDois("see 10.1038/nature123 for details")).toEqual([
      "10.1038/nature123",
    ]);
  });

  test("handles the 'doi:' / 'DOI:' / 'https://doi.org/' prefixes", () => {
    expect(extractDois("doi: 10.1000/xyz")).toEqual(["10.1000/xyz"]);
    expect(extractDois("DOI: 10.1000/xyz")).toEqual(["10.1000/xyz"]);
    expect(extractDois("https://doi.org/10.1000/xyz")).toEqual([
      "10.1000/xyz",
    ]);
  });

  test("strips trailing sentence punctuation", () => {
    expect(extractDois("see 10.1038/nature123.")).toEqual([
      "10.1038/nature123",
    ]);
    expect(extractDois("cited in [10.1038/nature123],")).toEqual([
      "10.1038/nature123",
    ]);
    expect(extractDois("end 10.1038/nature123;")).toEqual([
      "10.1038/nature123",
    ]);
  });

  test("keeps balanced parens that are part of the DOI", () => {
    expect(extractDois("ref 10.1000/(stub) here")).toEqual([
      "10.1000/(stub)",
    ]);
  });

  test("drops an unbalanced trailing closer from prose", () => {
    expect(extractDois("(see 10.1038/nature123)")).toEqual([
      "10.1038/nature123",
    ]);
  });

  test("returns candidates in order of first appearance, de-duped + lowercased", () => {
    const text =
      "own: 10.1038/OwnPaper2024 then cites 10.1016/j.xps.2019.1001 and again 10.1038/ownpaper2024";
    expect(extractDois(text)).toEqual([
      "10.1038/ownpaper2024",
      "10.1016/j.xps.2019.1001",
    ]);
  });

  test("returns [] when no DOI is present", () => {
    expect(extractDois("a book with no doi anywhere")).toEqual([]);
    expect(extractDois("")).toEqual([]);
  });

  test("accepts the full 4–9 digit registrant range", () => {
    expect(extractDois("10.1/short")).toEqual([]); // < 4 digits: not a DOI
    expect(extractDois("10.1234/ok")).toEqual(["10.1234/ok"]);
    expect(extractDois("10.123456789/many")).toEqual(["10.123456789/many"]);
  });

  test("recovers a DOI split by a stray space after the slash", () => {
    // Real case: the Çengelköylü 2022 title page prints `10.33417/ tsh.1081422`
    // (space after the slash). Without tolerance the own-DOI is missed and
    // auto-detect fell back to a wrong-title Crossref match. The space is
    // collapsed; a normal DOI is unaffected.
    expect(extractDois("DOI: 10.33417/ tsh.1081422")).toEqual([
      "10.33417/tsh.1081422",
    ]);
    // Multiple spaces collapse too; surrounding prose is not swept in (the
    // suffix stops at the next whitespace, so `foo` below is left alone).
    expect(extractDois("see 10.1000/  xyz  and more")).toEqual([
      "10.1000/xyz",
    ]);
    // A normal DOI right after the slash is unchanged.
    expect(extractDois("doi: 10.1038/nature123")).toEqual([
      "10.1038/nature123",
    ]);
  });
});

describe("firstPageRegion", () => {
  test("returns everything before the [p.2] marker (title page)", () => {
    const text = "[p.1] Title page with DOI 10.1038/own\n\n[p.2] References cite 10.1016/cited";
    expect(firstPageRegion(text)).toBe("[p.1] Title page with DOI 10.1038/own\n\n");
    // A bibliography DOI on page 2 is excluded from the scope.
    expect(extractDois(firstPageRegion(text))).toEqual(["10.1038/own"]);
  });

  test("the user's scenario: own DOI absent, cited DOI on page 2 → scope is empty of DOIs", () => {
    const text = "[p.1] A book chapter, no own DOI here\n\n[p.2] Refs: 10.1016/somecited";
    expect(extractDois(firstPageRegion(text))).toEqual([]);
  });

  test("falls back to a char cap when there are no page markers (DOCX/transcript)", () => {
    const long = "x".repeat(5000);
    expect(firstPageRegion(long).length).toBe(2500);
  });

  test("single-page doc returns the whole text when short", () => {
    expect(firstPageRegion("[p.1] only page")).toBe("[p.1] only page");
  });
});

describe("titlesMatch", () => {
  test("exact match after normalization (case/punct)", () => {
    expect(titlesMatch("On the Electrodynamics of Moving Bodies!", "on the electrodynamics of moving bodies")).toBe(true);
  });

  test("one title is a prefix of the other (subtitle / truncation)", () => {
    expect(titlesMatch("STEM: Semantic Target Search", "STEM: Semantic Target Search and Exploration using MAVs")).toBe(true);
  });

  test("high token overlap counts as a match (≥0.6 Jaccard, non-substring)", () => {
    // Same paper, reworded — no substring relation, but heavy token overlap.
    expect(
      titlesMatch(
        "ImageNet Classification with Deep CNNs",
        "Deep CNNs for ImageNet Classification",
      ),
    ).toBe(true);
  });

  test("borderline-low overlap is rejected (Jaccard < 0.6)", () => {
    // 3 shared / 6 union = 0.5 — different enough to reject.
    expect(titlesMatch("Deep Learning for Robotics", "Deep Learning in Robotics Applications")).toBe(false);
  });

  test("unrelated titles are rejected", () => {
    expect(titlesMatch("A Survey of Reinforcement Learning", "Quantum Entanglement in Spin Chains")).toBe(false);
  });

  test("null / empty inputs never match", () => {
    expect(titlesMatch(null, "x")).toBe(false);
    expect(titlesMatch("x", undefined)).toBe(false);
    expect(titlesMatch("", "")).toBe(false);
  });

  test("normTitle strips punctuation and collapses whitespace", () => {
    expect(normTitle("  Hello, World!! ")).toBe("hello world");
  });
});
