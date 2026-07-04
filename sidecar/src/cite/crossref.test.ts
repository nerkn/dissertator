// Tests for the Crossref adapter (P2 Track 3) — pure logic, NO network.
//
// The adapter takes an injectable `fetch` (CrossrefOpts.fetch); tests pass a
// stub returning fixture JSON so the suite runs fully offline. Pins:
//   1. search maps authors/year/title/doi/type/venue from a work;
//   2. DOI lookup returns null on 404;
//   3. empty results → [];
//   4. HTTP 500 → [] (never throws — degrades gracefully);
//   5. network throw → [] (never throws).
// `mapCrossrefToReference` is also exercised directly for field mapping.
//
// NO real network calls. NO API key (Crossref is a free public API).

import { describe, expect, test } from "bun:test";
import type { Reference } from "@dissertator/shared";
import {
  crossrefByDoi,
  crossrefSearch,
  mapCrossrefToReference,
  type CrossrefWork,
} from "./crossref.ts";

/** Minimal fake Response — enough for the adapter (res.ok, .status, .json, .text). */
function fakeResponse(
  status: number,
  body: unknown,
  ok?: boolean
): Response {
  const isOk = ok ?? (status >= 200 && status < 300);
  return {
    ok: isOk,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

/** A single Crossref work fixture, representative of `GET /works/{doi}`. */
const WORK: CrossrefWork = {
  DOI: "10.1000/xyz123",
  type: "journal-article",
  title: ["Crime and the City"],
  "container-title": ["Journal of Sociology"],
  author: [
    { family: "Smith", given: "Jane" },
    { family: "Jones", given: "Bob" },
  ],
  "published-print": { "date-parts": [[2020, 3, 1]] },
  issued: { "date-parts": [[2020]] },
};

describe("mapCrossrefToReference", () => {
  test("maps authors/year/title/doi/type/venue + preserves full CSL", () => {
    const ref = mapCrossrefToReference(WORK);
    expect(ref.title).toBe("Crime and the City");
    expect(ref.doi).toBe("10.1000/xyz123");
    expect(ref.authors).toEqual([
      { family: "Smith", given: "Jane" },
      { family: "Jones", given: "Bob" },
    ]);
    expect(ref.year).toBe(2020); // published-print wins over issued
    expect(ref.type).toBe("journal-article");
    expect(ref.venue).toBe("Journal of Sociology");
    // id/citekey left blank for assignment on commit.
    expect(ref.id).toBe("");
    expect(ref.citekey).toBe("");
    expect(ref.source_file_id).toBeNull();
    // Full record preserved for citeproc-js.
    expect(ref.csl_json).toMatchObject({ DOI: "10.1000/xyz123" });
  });

  test("falls back to issued when published-print/online absent", () => {
    const ref = mapCrossrefToReference({
      type: "book",
      title: ["A Book"],
      issued: { "date-parts": [[1999]] },
    });
    expect(ref.year).toBe(1999);
    expect(ref.type).toBe("book");
  });

  test("year null when no date-parts present", () => {
    const ref = mapCrossrefToReference({ title: ["No Date"] });
    expect(ref.year).toBeNull();
  });
});

describe("crossrefSearch", () => {
  test("maps each work in message.items to a Reference", async () => {
    const fetchStub = (async (_url: string | URL | Request, _init?: RequestInit) =>
      fakeResponse(200, {
        message: { items: [WORK, { DOI: "10.2/x", title: ["Other"], issued: { "date-parts": [[2018]] } }] },
      }));
    const refs = await crossrefSearch("crime", { fetch: fetchStub });
    expect(refs).toHaveLength(2);
    expect(refs[0].title).toBe("Crime and the City");
    expect(refs[0].authors[0].family).toBe("Smith");
    expect(refs[1].title).toBe("Other");
  });

  test("empty results → [] (status 200, no items)", async () => {
    const fetchStub = (async () => fakeResponse(200, { message: { items: [] } }));
    const refs = await crossrefSearch("nothinghere", { fetch: fetchStub });
    expect(refs).toEqual([]);
  });

  test("HTTP 500 → [] (never throws)", async () => {
    const fetchStub = (async () => fakeResponse(500, "upstream down"));
    // Suppress the expected console.error noise for this test.
    const orig = console.error;
    console.error = () => undefined;
    try {
      const refs = await crossrefSearch("x", { fetch: fetchStub });
      expect(refs).toEqual([]);
    } finally {
      console.error = orig;
    }
  });

  test("network throw → [] (never throws, degrades gracefully)", async () => {
    const fetchStub = (async () => {
      throw new Error("EAI_AGAIN");
    });
    const orig = console.error;
    console.error = () => undefined;
    try {
      const refs = await crossrefSearch("x", { fetch: fetchStub });
      expect(refs).toEqual([]);
    } finally {
      console.error = orig;
    }
  });
});

describe("crossrefByDoi", () => {
  test("returns a Reference on a 200 envelope", async () => {
    const fetchStub = (async () => fakeResponse(200, { message: WORK }));
    const ref = await crossrefByDoi("10.1000/xyz123", { fetch: fetchStub });
    expect(ref).not.toBeNull();
    expect((ref as Reference).title).toBe("Crime and the City");
    expect((ref as Reference).authors[0].family).toBe("Smith");
  });

  test("returns null on 404 (no throw)", async () => {
    const fetchStub = (async () => fakeResponse(404, "not found"));
    const ref = await crossrefByDoi("10.0/missing", { fetch: fetchStub });
    expect(ref).toBeNull();
  });

  test("returns null on HTTP 500 (no throw)", async () => {
    const fetchStub = (async () => fakeResponse(500, "down"));
    const orig = console.error;
    console.error = () => undefined;
    try {
      const ref = await crossrefByDoi("10.0/x", { fetch: fetchStub });
      expect(ref).toBeNull();
    } finally {
      console.error = orig;
    }
  });

  test("returns null on network throw", async () => {
    const fetchStub = (async () => {
      throw new Error("offline");
    });
    const orig = console.error;
    console.error = () => undefined;
    try {
      const ref = await crossrefByDoi("10.0/x", { fetch: fetchStub });
      expect(ref).toBeNull();
    } finally {
      console.error = orig;
    }
  });

  test("empty doi → null without calling fetch", async () => {
    let called = 0;
    const fetchStub = (async () => {
      called++;
      return fakeResponse(200, {});
    });
    const ref = await crossrefByDoi("   ", { fetch: fetchStub });
    expect(ref).toBeNull();
    expect(called).toBe(0);
  });
});
