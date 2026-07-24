import { existsSync } from "node:fs";
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

test("createDocument writes a papers/ file + row; getDocument reads it back", async () => {
  const doc = await createDocument({
    title: "My Paper",
  });
  expect(doc.id).toBeTruthy();
  expect(doc.title).toBe("my-paper");
  expect(doc.bodyMd).toBe("");
  expect(doc.createdAt).toBeGreaterThan(0);

  expect(existsSync(join(dir, "papers", "my-paper.md"))).toBe(true);

  const got = await getDocument(doc.id);
  expect(got).not.toBeNull();
  expect(got!.id).toBe(doc.id);
  expect(got!.bodyMd).toBe("");
  expect(got!.title).toBe("my-paper");

  expect(await getDocument("no-such-doc")).toBeNull();
});

test("createDocument is idempotent on slug collision", async () => {
  const a = await createDocument({ title: "Dup", bodyMd: "first" });
  const b = await createDocument({ title: "Dup", bodyMd: "second" });
  expect(b.id).toBe(a.id);
  expect(b.bodyMd).toBe("first");
});

test("createDocument with bodyMd seeds the file body", async () => {
  const doc = await createDocument({ title: "Seeded", bodyMd: "# Hello\n" });
  expect(doc.bodyMd).toBe("# Hello\n");
  expect((await getDocument(doc.id))!.bodyMd).toBe("# Hello\n");
});

test("updateDocument writes bodyMd to disk and getDocument reads it back", async () => {
  const doc = await createDocument({ title: "Editable" });
  const updated = await updateDocument(doc.id, {
    bodyMd: "# Intro\nSome body with a citation [@smith2020:42]\n",
  });
  expect(updated).not.toBeNull();
  expect(updated!.bodyMd).toBe(
    "# Intro\nSome body with a citation [@smith2020:42]\n",
  );
  expect(updated!.title).toBe("editable");
  expect((await getDocument(doc.id))!.bodyMd).toBe(
    "# Intro\nSome body with a citation [@smith2020:42]\n",
  );
});

test("updateDocument omit-vs-set for bodyMd: omit keeps, explicit '' sets empty", async () => {
  const doc = await createDocument({ title: "PatchVs", bodyMd: "has content" });
  expect((await getDocument(doc.id))!.bodyMd).toBe("has content");

  const patched = await updateDocument(doc.id, { title: "Renamed" });
  expect(patched!.title).toBe("renamed");
  expect(patched!.bodyMd).toBe("has content");

  const cleared = await updateDocument(doc.id, { bodyMd: "" });
  expect(cleared!.bodyMd).toBe("");
});

test("updateDocument title rename moves the file on disk", async () => {
  const doc = await createDocument({ title: "Old Name", bodyMd: "body" });
  const oldPath = join(dir, "papers", "old-name.md");
  expect(existsSync(oldPath)).toBe(true);

  const updated = await updateDocument(doc.id, { title: "New Name" });
  expect(updated!.title).toBe("new-name");
  expect(existsSync(oldPath)).toBe(false);
  expect(existsSync(join(dir, "papers", "new-name.md"))).toBe(true);
  expect(updated!.bodyMd).toBe("body");
});

test("updateDocument on an unknown id returns null", async () => {
  expect(await updateDocument("no-such-doc", { bodyMd: "x" })).toBeNull();
});

test("updateDocument on a non-manuscript source returns null", async () => {
  const project = getCurrentProject()!;
  const sid = "src-not-manuscript";
  project.db
    .prepare(
      `INSERT OR REPLACE INTO source_files
       (id, rel_path, filename, ext, kind, text_status, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sid, "notpapers/x.pdf", "x.pdf", "pdf", "pdf", "done", 0);
  expect(await updateDocument(sid, { bodyMd: "x" })).toBeNull();
  expect(await getDocument(sid)).toBeNull();
});

test("listDocuments returns manuscripts WITHOUT body (omits disk read)", async () => {
  const a = await createDocument({ title: "ListA", bodyMd: "a-body" });
  const b = await createDocument({ title: "ListB" });
  const docs = await listDocuments();
  const gotA = docs.find((d) => d.id === a.id);
  const gotB = docs.find((d) => d.id === b.id);
  expect(gotA).toBeDefined();
  expect(gotA!.bodyMd).toBe("");
  expect(gotB).toBeDefined();
  expect(gotB!.bodyMd).toBe("");
  expect(a.id).not.toBe(b.id);
});

test("deleteDocument removes the file + row (idempotent once gone)", async () => {
  const doc = await createDocument({ title: "Doomed", bodyMd: "x" });
  const path = join(dir, "papers", "doomed.md");
  expect(existsSync(path)).toBe(true);
  expect(await deleteDocument(doc.id)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(await getDocument(doc.id)).toBeNull();
  expect(await deleteDocument(doc.id)).toBe(false);
});
