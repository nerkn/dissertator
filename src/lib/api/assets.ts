import { req, sidecarBase } from "./_client";

export const assetsApi = {
  exportDocument: (
    html: string,
    format: "pdf" | "docx" | "doc",
    title?: string,
  ) =>
    fetch(`${sidecarBase()}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html, format, title }),
    }).then(async (r) => {
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error ?? `export failed (${r.status})`);
      }
      return r.blob();
    }),

  exportDocumentToPath: (
    html: string,
    format: "pdf" | "docx" | "doc",
    outPath: string,
    title?: string,
  ) =>
    req<{ ok: true; path: string }>("/export", {
      method: "POST",
      body: JSON.stringify({ html, format, title, outPath }),
    }),

  importAsset: (input: {
    sourcePath?: string;
    dataUrl?: string;
    filename: string;
    dest: "images" | "audio" | "root";
    mode?: "copy" | "move";
  }) =>
    req<{ ok: true; relPath: string; absPath: string; kind: string }>(
      "/assets/import",
      { method: "POST", body: JSON.stringify(input) },
    ),
};
