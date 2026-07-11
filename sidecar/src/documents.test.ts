// DB-backed tests for documents CRUD (P3 manuscript editor).
//
// Pins the editor's load + autosave contract under the "one body" model:
//   1. createDocument yields a doc with `bodyMd === ""` (the editor's empty
//      body to write into);
//   2. updateDocument({ bodyMd }) sets the body and getDocument reads it back;
//   3. updateDocument distinguishes omit (keep) from an explicit "" (set
//      empty) for bodyMd — `!== undefined` discipline;
//   4. updateDocument partially patches title and round-trips researchQuestions
//      (JSON), tolerating a malformed column (→ []);
//   5. deleteDocument removes the row (idempotent on unknown ids);
//   6. listDocuments returns docs carrying their body_md.
//
// Mirrors db.test.ts: a throwaway project dir + the real `initProject` (which
// loads sqlite-vec + runs the migration that adds `documents.body_md` and
// drops the legacy `sections` table). Bun isolates each test FILE into its
// own process, so the module-level `current` project is owned exclusively
// here.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createDocument,
  deleteDocument,
  getCurrentProject,
  getDocument,
  listDocuments,
  updateDocument,
  initProject,
} from "./db";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-docs-"));
  await initProject(dir);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

// ---------------------------------------------------------------------------
// createDocument seeds an empty body; getDocument reads it back.
// ---------------------------------------------------------------------------

test("createDocument returns the document + researchQuestions parsed, with an empty body", () => {
  const doc = createDocument({
    title: "My Paper",
    docType: "paper",
    thesis: "LLMs help writing.",
    researchQuestions: ["RQ1", "RQ2"],
    focusPrompt: "stay grounded",
  });
  expect(doc.id).toBeTruthy();
  expect(doc.title).toBe("My Paper");
  expect(doc.docType).toBe("paper");
  expect(doc.thesis).toBe("LLMs help writing.");
  expect(doc.researchQuestions).toEqual(["RQ1", "RQ2"]);
  expect(doc.focusPrompt).toBe("stay grounded");
  expect(doc.bodyMd).toBe(""); // body seeded empty (editor's empty body)
  expect(doc.createdAt).toBeGreaterThan(0);

  // getDocument reads the row back unchanged.
  const got = getDocument(doc.id);
  expect(got).not.toBeNull();
  expect(got!.id).toBe(doc.id);
  expect(got!.bodyMd).toBe("");

  // getDocument on an unknown id → null (route turns into 404).
  expect(getDocument("no-such-doc")).toBeNull();
});

test("createDocument defaults researchQuestions to [] and bodyMd to '' when omitted", () => {
  const doc = createDocument({ title: "Minimal" });
  expect(doc.researchQuestions).toEqual([]);
  expect(doc.bodyMd).toBe("");
  expect(doc.docType).toBeNull();
  expect(doc.thesis).toBeNull();
  expect(doc.focusPrompt).toBeNull();
});

// ---------------------------------------------------------------------------
// updateDocument — the editor's autosave target (bodyMd).
// ---------------------------------------------------------------------------

test("updateDocument sets bodyMd and getDocument reads it back", () => {
  const doc = createDocument({ title: "Editable" });
  const updated = updateDocument(doc.id, {
    bodyMd: "# Intro\nSome body with a citation [@smith2020:42]\n",
  });
  expect(updated).not.toBeNull();
  expect(updated!.bodyMd).toBe(
    "# Intro\nSome body with a citation [@smith2020:42]\n"
  );
  // Other fields preserved (omitted from the patch).
  expect(updated!.title).toBe("Editable");

  // getDocument reflects the persisted change.
  expect(getDocument(doc.id)!.bodyMd).toBe(
    "# Intro\nSome body with a citation [@smith2020:42]\n"
  );
});

test("updateDocument omit-vs-set for bodyMd: omit keeps, explicit '' sets empty", () => {
  const doc = createDocument({ title: "PatchVs" });
  // First set a non-empty body.
  updateDocument(doc.id, { bodyMd: "has content" });
  expect(getDocument(doc.id)!.bodyMd).toBe("has content");

  // Patching an unrelated field and OMITTING bodyMd keeps the body intact.
  const patched = updateDocument(doc.id, { title: "Renamed" });
  expect(patched!.title).toBe("Renamed");
  expect(patched!.bodyMd).toBe("has content"); // preserved

  // An explicit "" is a valid SET (clears the body), NOT "keep".
  const cleared = updateDocument(doc.id, { bodyMd: "" });
  expect(cleared!.bodyMd).toBe("");
});

test("updateDocument on an unknown id returns null", () => {
  expect(updateDocument("no-such-doc", { bodyMd: "x" })).toBeNull();
});

// ---------------------------------------------------------------------------
// updateDocument — partial patch + researchQuestions JSON round-trip.
// ---------------------------------------------------------------------------

test("updateDocument partially patches title + round-trips researchQuestions", () => {
  const doc = createDocument({ title: "PatchMe", researchQuestions: ["q1"] });

  const updated = updateDocument(doc.id, {
    title: "New Title",
    researchQuestions: ["q1", "q2"],
  });
  expect(updated).not.toBeNull();
  expect(updated!.title).toBe("New Title");
  expect(updated!.researchQuestions).toEqual(["q1", "q2"]);
  // bodyMd preserved (omitted from the patch).
  expect(updated!.bodyMd).toBe("");

  // Set then clear docType via explicit null.
  expect(updateDocument(doc.id, { docType: "thesis" })!.docType).toBe("thesis");
  expect(updateDocument(doc.id, { docType: null })!.docType).toBeNull();

  // Missing document → null (404-style).
  expect(updateDocument("no-such-doc", { title: "x" })).toBeNull();
});

test("mapDocument tolerates a malformed research_questions JSON column (→ [])", () => {
  // Defensive parse: a corrupt JSON value must NOT throw — it yields [] so the
  // editor never crashes on a hand-edited DB row.
  const db = getCurrentProject()!.db;
  const id = "doc-badjson";
  db.prepare(
    "INSERT INTO documents " +
      "(id, title, doc_type, thesis, research_questions, focus_prompt, body_md, created_at) " +
      "VALUES (?, 'bad', NULL, NULL, ?, NULL, '', 0)"
  ).run(id, "{not valid json");
  const got = getDocument(id)!;
  expect(got.researchQuestions).toEqual([]);
  expect(got.bodyMd).toBe(""); // null-safe default "" when body_md is NULL
});

// ---------------------------------------------------------------------------
// listDocuments returns docs carrying their body_md.
// ---------------------------------------------------------------------------

test("listDocuments returns docs with body_md", () => {
  const a = createDocument({ title: "ListA" });
  updateDocument(a.id, { bodyMd: "a-body" });
  const b = createDocument({ title: "ListB" });
  const docs = listDocuments();
  const gotA = docs.find((d) => d.id === a.id);
  const gotB = docs.find((d) => d.id === b.id);
  expect(gotA).toBeDefined();
  expect(gotA!.bodyMd).toBe("a-body");
  expect(gotB).toBeDefined();
  expect(gotB!.bodyMd).toBe(""); // unmodified → empty body
  expect(a.id).not.toBe(b.id);
});

// ---------------------------------------------------------------------------
// deleteDocument removes the row (idempotent on unknown ids).
// ---------------------------------------------------------------------------

test("deleteDocument removes it and returns false once gone", () => {
  const doc = createDocument({ title: "Doomed" });
  expect(deleteDocument(doc.id)).toBe(true);
  // Document gone.
  expect(getDocument(doc.id)).toBeNull();
  // Deleting again is a no-op (idempotent) → false.
  expect(deleteDocument(doc.id)).toBe(false);
});
