import type { Hono } from "hono";
import { SOFFICE_FILTERS, escapeHtmlAttr, findSoffice } from "../lib/soffice.ts";

// ---------------------------------------------------------------------------
// Export: render an HTML manuscript to PDF / DOCX / DOC via headless
// LibreOffice (soffice). Pandoc is NOT assumed; LibreOffice's HTML import +
// export filters handle all three formats well enough for a first draft. The
// HTML is produced client-side from the Milkdown document (getHTML), so the
// authored formatting is preserved. `[@citekey]` tokens pass through as text.
// ---------------------------------------------------------------------------

export function registerExport(app: Hono): void {
  app.post("/export", async (c) => {
    let body: { html?: string; format?: string; title?: string; outPath?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const fmt = SOFFICE_FILTERS[body.format ?? ""];
    if (!fmt) return c.json({ error: `unsupported format: ${body.format}` }, 400);
    if (typeof body.html !== "string")
      return c.json({ error: "missing html" }, 400);

    const rawTitle = (body.title ?? "manuscript").trim();
    const title =
      rawTitle.replace(/[^\w\- .()]/g, "_").slice(0, 80) || "manuscript";

    // Wrap the Milkdown HTML fragment in a full document with print-friendly
    // CSS so the conversion engine applies sensible typography + page margins.
    const fullDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtmlAttr(
      title,
    )}</title><style>
@page { margin: 2.5cm; }
body { font-family: "Liberation Serif", Georgia, serif; font-size: 12pt; line-height: 1.5; color: #000; }
h1 { font-size: 20pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
code, pre { font-family: "Liberation Mono", monospace; font-size: 10.5pt; }
blockquote { margin-left: 1.5cm; color: #444; font-style: italic; }
table { border-collapse: collapse; } th, td { border: 1px solid #888; padding: 4px 8px; }
img { max-width: 100%; }
</style></head><body>${body.html}</body></html>`;

    const os = await import("node:os");
    const npath = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = npath.join(
      os.tmpdir(),
      `dissertator-export-${process.pid}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    const inPath = npath.join(dir, "input.html");
    const outPath = npath.join(dir, `input.${fmt.ext}`);
    await fs.writeFile(inPath, fullDoc, "utf8");

    const cleanup = () =>
      fs.rm(dir, { recursive: true, force: true }).catch(() => {});

    const bin = findSoffice();
    if (!bin) {
      await cleanup();
      return c.json(
        { error: "LibreOffice (soffice) not found. Install libreoffice to export." },
        500,
      );
    }

    const r = Bun.spawnSync({
      cmd: [
        bin,
        "--headless",
        "--norestore",
        `-env:UserInstallation=file://${dir}/profile`,
        "--convert-to",
        fmt.filter,
        "--outdir",
        dir,
        inPath,
      ],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120000,
    });

    const outFile = Bun.file(outPath);
    if (!(await outFile.exists())) {
      const errText = Buffer.isBuffer(r.stderr)
        ? r.stderr.toString("utf8")
        : String(r.stderr ?? "");
      await cleanup();
      return c.json(
        { error: `conversion failed: ${errText.slice(0, 500)}` },
        500,
      );
    }

    const buf = await outFile.arrayBuffer();
    await cleanup();

    // If the client passed an absolute save path (from a Tauri Save dialog),
    // write the converted bytes there directly and report the path. This is the
    // reliable path in a Tauri webview — programmatic <a download> of a blob
    // URL is swallowed by the webview, so the client never gets a file. The
    // sidecar (a local process) can write anywhere on disk without IPC perms.
    if (typeof body.outPath === "string" && body.outPath.trim()) {
      try {
        await fs.writeFile(body.outPath, new Uint8Array(buf));
        return c.json({ ok: true, path: body.outPath });
      } catch (e) {
        return c.json(
          { error: `could not write to ${body.outPath}: ${(e as Error).message}` },
          500,
        );
      }
    }

    return new Response(buf, {
      headers: {
        "Content-Type": fmt.mime,
        "Content-Disposition": `attachment; filename="${title}.${fmt.ext}"`,
      },
    });
  });
}
