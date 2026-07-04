// Tests for the recursive watcher's exclusion + scan logic.
//
// `isExcludedPath` is pure path math but is exercised against a real temp
// root so path separators are platform-accurate. `scanFiles` walks a real
// fixture tree to verify that `Dissertator/`, `documents/`, and
// `node_modules/` are pruned and everything else is collected. The prefix
// trap (`<root>/Dissertator-backup`, `<root>/documents-old`) is asserted to
// NOT be excluded — the matcher must respect the separator, not `startsWith`.

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { isExcludedPath, scanFiles } from "./watch.ts";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "diss-watch-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("isExcludedPath", () => {
  test("<root>/Dissertator — the dir itself + descendants — is excluded", () => {
    expect(isExcludedPath(join(root, "Dissertator"), root)).toBe(true);
    expect(
      isExcludedPath(join(root, "Dissertator", "cache", "x.txt"), root)
    ).toBe(true);
  });

  test("<root>/documents — the dir itself + descendants — is excluded", () => {
    expect(isExcludedPath(join(root, "documents"), root)).toBe(true);
    expect(
      isExcludedPath(join(root, "documents", "draft.md"), root)
    ).toBe(true);
  });

  test("prefix trap: similarly-named siblings are NOT excluded", () => {
    // `Dissertator-backup` shares the prefix but is a sibling, not a child.
    expect(isExcludedPath(join(root, "Dissertator-backup"), root)).toBe(false);
    expect(
      isExcludedPath(join(root, "Dissertator-backup", "x.md"), root)
    ).toBe(false);
    expect(isExcludedPath(join(root, "documents-old"), root)).toBe(false);
    expect(
      isExcludedPath(join(root, "documents-old", "x.md"), root)
    ).toBe(false);
  });

  test("a normal source path is not excluded", () => {
    expect(isExcludedPath(join(root, "src", "a.md"), root)).toBe(false);
    expect(isExcludedPath(join(root, "a.md"), root)).toBe(false);
  });
});

describe("scanFiles", () => {
  test("walks root, pruning Dissertator/, documents/, node_modules/", async () => {
    // Layout (only sources/a.md and src/b.md should survive the scan):
    //   <root>/sources/a.md
    //   <root>/src/b.md
    //   <root>/Dissertator/cache/x.txt   (excluded dir)
    //   <root>/documents/draft.md         (excluded dir)
    //   <root>/node_modules/pkg/index.js  (skipped by name)
    await mkdir(join(root, "sources"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "Dissertator", "cache"), { recursive: true });
    await mkdir(join(root, "documents"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });

    await writeFile(join(root, "sources", "a.md"), "a");
    await writeFile(join(root, "src", "b.md"), "b");
    await writeFile(join(root, "Dissertator", "cache", "x.txt"), "x");
    await writeFile(join(root, "documents", "draft.md"), "d");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "i");

    const files = await scanFiles(root);

    // Normalize to forward-slash relative paths; sort (FS order is not
    // guaranteed) and compare to the expected survivors.
    const rels = files
      .map((f) => f.slice(root.length + 1).replace(/\\/g, "/"))
      .sort();
    expect(rels).toEqual(["sources/a.md", "src/b.md"]);

    // Belt-and-suspenders: nothing leaked from excluded dirs or node_modules.
    expect(files.some((f) => isExcludedPath(f, root))).toBe(false);
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
  });
});
