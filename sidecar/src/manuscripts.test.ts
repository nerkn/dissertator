import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "bun:test";

import {
  createManuscript,
  deleteSource,
  getCurrentProject,
  getSourceById,
  initProject,
} from "./db";
import { readSourceMarkdown, writeSourceMarkdown } from "./ingest/index.ts";

let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "diss-manuscripts-"));
  await initProject(dir);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

test("createManuscript writes a papers/ file + row as a markdown source", async () => {
  const src = await createManuscript({ title: "My Paper" });
  expect(src.id).toBeTruthy();
  expect(src.ext).toBe("md");
  expect(src.mimeType).toBe("text/markdown");
  expect(src.relPath).toBe("papers/My Paper.md");
  expect(src.filename).toBe("My Paper.md");
  expect(existsSync(join(dir, "papers", "My Paper.md"))).toBe(true);
  expect(getSourceById(src.id)?.id).toBe(src.id);
});

test("createManuscript is idempotent on slug collision (returns same row)", async () => {
  const a = await createManuscript({ title: "Dup", bodyMd: "first" });
  const b = await createManuscript({ title: "Dup", bodyMd: "second" });
  expect(b.id).toBe(a.id);
  expect(await readSourceMarkdown(a)).toBe("first");
});

test("createManuscript with bodyMd seeds the file body", async () => {
  const src = await createManuscript({ title: "Seeded", bodyMd: "# Hello\n" });
  expect(await readSourceMarkdown(src)).toBe("# Hello\n");
});

test("writeSourceMarkdown writes body to disk and readSourceMarkdown reads it back", async () => {
  const src = await createManuscript({ title: "Editable" });
  await writeSourceMarkdown(src, "# Intro\nSome body with a citation [@smith2020:42]\n");
  expect(await readSourceMarkdown(src)).toBe(
    "# Intro\nSome body with a citation [@smith2020:42]\n",
  );
});

test("deleteSource removes the file + row (idempotent once gone)", async () => {
  const src = await createManuscript({ title: "Doomed", bodyMd: "x" });
  const path = join(dir, "papers", "Doomed.md");
  expect(existsSync(path)).toBe(true);
  expect(await deleteSource(src.id)).toBe(true);
  expect(existsSync(path)).toBe(false);
  expect(getSourceById(src.id)).toBeNull();
  expect(await deleteSource(src.id)).toBe(false);
});

test("deleteSource on an unknown id returns false", async () => {
  expect(await deleteSource("no-such-src")).toBe(false);
});

test("manuscripts appear in listSources (no papers/ exclusion)", async () => {
  const project = getCurrentProject()!;
  const { listSources } = await import("./ingest/index.ts");
  const before = listSources().filter((s) => s.relPath.startsWith("papers/")).length;
  await createManuscript({ title: "Listed" });
  const after = listSources().filter((s) => s.relPath.startsWith("papers/")).length;
  expect(after).toBe(before + 1);
  void project;
});
