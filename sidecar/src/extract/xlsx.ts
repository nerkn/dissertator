// Spreadsheet (xlsx/xls) → text via SheetJS (`xlsx`).
//
// Each worksheet is converted to CSV with `sheet_to_csv` and concatenated,
// prefixed by a `## Sheet: <name>` header. The whole workbook is returned as a
// single "page" (physicalPage=1, pageCount=1).

import * as XLSX from "xlsx";
import type { ExtractResult } from "./index";

const MIME_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function extractXlsx(absPath: string): Promise<ExtractResult> {
  try {
    const buf = await Bun.file(absPath).arrayBuffer();
    const wb = XLSX.read(new Uint8Array(buf), { type: "array" });

    const parts: string[] = [];
    for (const sheetName of wb.SheetNames) {
      const ws = wb.Sheets[sheetName];
      if (!ws) continue;
      const csv = XLSX.utils.sheet_to_csv(ws);
      parts.push(`## Sheet: ${sheetName}`);
      parts.push(csv);
    }

    const text = parts.join("\n").trim();
    return {
      text,
      pages: [{ physicalPage: 1, text }],
      pageCount: 1,
      needsOcr: false,
      mimeType: MIME_TYPE,
    };
  } catch (e) {
    throw new Error(
      `xlsx extract failed: ${(e as Error)?.message ?? String(e)}`
    );
  }
}
