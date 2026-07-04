// Tests for extension → `FileKind` detection (`detectKind`).
//
// Covers the full supported-extension table, case-insensitivity on the
// extension, the last-dot rule for dotted basenames, and the sensible
// "unsupported" default for unknown / missing / trailing-dot extensions.
// Values + mapping come from `EXT_TO_KIND` in `extract/index.ts`.

import { describe, expect, test } from "bun:test";
import { detectKind, type FileKind } from "./index.ts";

describe("detectKind", () => {
  test("maps every supported extension to its kind", () => {
    const cases: Record<string, FileKind> = {
      "doc.pdf": "pdf",
      "doc.docx": "docx",
      "sheet.xlsx": "xlsx",
      "legacy.xls": "xlsx",
      "data.csv": "text",
      "data.tsv": "text",
      "notes.md": "text",
      "notes.markdown": "text",
      "plain.txt": "text",
      "obj.json": "text",
      "pic.png": "image",
      "pic.jpg": "image",
      "pic.jpeg": "image",
      "pic.webp": "image",
      "scan.tif": "image",
      "scan.tiff": "image",
      "old.bmp": "image",
      "anim.gif": "image",
    };

    for (const [filename, expected] of Object.entries(cases)) {
      expect(detectKind(filename)).toBe(expected);
    }
  });

  test("is case-insensitive on the extension", () => {
    expect(detectKind("BOOK.PDF")).toBe("pdf");
    expect(detectKind("PHOTO.JPEG")).toBe("image");
    expect(detectKind("Notes.MD")).toBe("text");
    expect(detectKind("Sheet.XLSX")).toBe("xlsx");
  });

  test("uses the last dot to find the extension", () => {
    expect(detectKind("weird.name.pdf")).toBe("pdf");
    expect(detectKind("archive.tar.gz")).toBe("unsupported"); // .gz unmapped
  });

  test("unknown / missing / trailing-dot extension → unsupported", () => {
    expect(detectKind("archive.zip")).toBe("unsupported");
    expect(detectKind("legacy.doc")).toBe("unsupported"); // legacy, not parsed
    expect(detectKind("noext")).toBe("unsupported");
    expect(detectKind("trailing.")).toBe("unsupported");
    expect(detectKind("")).toBe("unsupported");
  });
});
