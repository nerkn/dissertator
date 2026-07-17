import type { Hono } from "hono";
import { join } from "node:path";
import { type Reference, TESSERACT_TYPE } from "@dissertator/shared";
import {
  getCurrentProject,
  getSettings,
  getSourceById,
  getSourceText,
  listReferences,
  upsertReference,
} from "../db";
import { crossrefByDoi } from "../cite/crossref.ts";
import { extractDois, firstPageRegion } from "../cite/doi.ts";
import { extractPdfMetadata } from "../cite/pdfmeta.ts";
import { extractReferenceViaLLM } from "../cite/llmExtract.ts";
import { titlesMatch } from "../cite/titleMatch.ts";
import {
  describeImageSource,
  getSourceCounts,
  listAttention,
  listSources,
  ocrSource,
  scanAll,
  transcribeSource,
} from "../ingest/index.ts";
import type { OcrEngine, OcrOptions } from "../ocr/index.ts";

// ---------------------------------------------------------------------------
// Ingest surface (Track F): sources / ingest / attention / ocr / events.
// Every route below requires an open project (returns 400 otherwise).
// ---------------------------------------------------------------------------

export function registerSources(app: Hono): void {
  app.get("/sources", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json({ items: listSources(), counts: getSourceCounts() });
  });

  // Raw file bytes for PDF/image viewing in the frontend. The Tauri asset
  // protocol is NOT scoped in this project (and we avoid Rust/permission
  // changes), so the sidecar streams bytes directly. Content-Type comes from
  // the row's `mime_type` (set during extraction); falls back to a generic
  // octet-stream. 404 if the source id or the file on disk is missing.
  app.get("/files/:id", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const src = getSourceById(id);
    if (!src) return c.json({ error: "not found" }, 404);
    const absPath = join(getCurrentProject()!.projectPath, src.relPath);
    const file = Bun.file(absPath);
    if (!(await file.exists())) {
      return c.json({ error: "file missing on disk" }, 404);
    }
    // Hono forwards a raw `Response` to Bun.serve unchanged. Loading the bytes
    // into an ArrayBuffer is simplest and correct for typical document sizes;
    // Bun.file is already zero-copy on the runtime side.
    return new Response(await file.arrayBuffer(), {
      headers: {
        "Content-Type": src.mimeType ?? "application/octet-stream",
      },
    });
  });

  // Concatenated extracted text (page-tagged) for text/docx/xlsx viewer tabs.
  // Reuses the chunks table (same source as `buildOpenFilesContext`). Returns
  // HTTP 200 with empty `text` when the source exists but has no chunks yet
  // (not extracted) — the UI shows "not extracted yet"; this is NOT an error.
  app.get("/sources/:id/text", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const src = getSourceById(id);
    if (!src) return c.json({ error: "not found" }, 404);
    return c.json(getSourceText(id));
  });

  app.post("/ingest", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    try {
      const enqueued = await scanAll();
      return c.json({ enqueued });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  // Asset import — drop / file-picker / screenshot-paste handler. Copies (or
  // moves) a real file, or writes pasted image bytes (as a data URL), into
  // <projectPath>/images | audio (or the project root for documents). The file
  // watcher then auto-ingests any supported type. Returns the project-relative
  // path so the editor can emit `![](images/x.png)` etc.
  app.post("/assets/import", async (c) => {
    const project = getCurrentProject();
    if (!project) return c.json({ error: "no project" }, 400);
    let body: {
      sourcePath?: string;
      dataUrl?: string;
      filename?: string;
      dest?: "images" | "audio" | "root";
      mode?: "copy" | "move";
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const filename = (body.filename ?? "").trim();
    if (!filename) return c.json({ error: "missing filename" }, 400);
    if (/[\\/]/.test(filename))
      return c.json({ error: "filename must not contain a path separator" }, 400);
    const dest = body.dest ?? "root";
    // Allowlist dest: it's interpolated into a filesystem path (join(root,
    // dest)), so an unchecked value like "../../x" would escape the project.
    if (dest !== "images" && dest !== "audio" && dest !== "root") {
      return c.json({ error: "invalid dest" }, 400);
    }
    const root = project.projectPath;
    const destDir = dest === "root" ? root : join(root, dest);

    const fs = await import("node:fs/promises");
    const npath = await import("node:path");
    await fs.mkdir(destDir, { recursive: true });

    // Collision-safe destination filename (foo.png → foo-1.png …).
    const ext = npath.extname(filename);
    const stem = npath.basename(filename, ext);
    const exists = (p: string) => fs.stat(p).then(() => true).catch(() => false);
    let outName = filename;
    let n = 1;
    while (await exists(npath.join(destDir, outName))) {
      outName = `${stem}-${n}${ext}`;
      n++;
    }
    const absPath = npath.join(destDir, outName);
    const relPath = npath
      .relative(root, absPath)
      .split(npath.sep)
      .join("/");

    try {
      if (body.sourcePath) {
        if (body.mode === "move") {
          try {
            await fs.rename(body.sourcePath, absPath);
          } catch {
            // cross-device link: fall back to copy + delete source
            await fs.copyFile(body.sourcePath, absPath);
            await fs.rm(body.sourcePath, { force: true });
          }
        } else {
          await fs.copyFile(body.sourcePath, absPath);
        }
      } else if (body.dataUrl) {
        const m = /^data:[^;]+;base64,(.*)$/s.exec(body.dataUrl);
        if (!m) return c.json({ error: "invalid dataUrl" }, 400);
        await fs.writeFile(absPath, Buffer.from(m[1], "base64"));
      } else {
        return c.json({ error: "need sourcePath or dataUrl" }, 400);
      }
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }

    const kind =
      dest === "images" ? "image" : dest === "audio" ? "audio" : "document";
    return c.json({ ok: true, relPath, absPath, kind });
  });

  app.get("/attention", (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    return c.json({ items: listAttention() });
  });

  app.post("/sources/:id/ocr", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const body = await c.req.json<{ engine?: OcrEngine }>().catch(
      () => ({}) as { engine?: OcrEngine }
    );
    const settings = getSettings();
    const vdoc = settings.resolved?.vision_doc;
    const engine = body.engine;
    // Vision config comes from the vision_doc binding (P-multi); tesseract is
    // selected when the bound provider is the keyless local OCR provider. An
    // explicit `engine` override still wins. The vision key is sourced ONLY
    // from the request Authorization header — never read/persisted server-side.
    const useVision =
      engine === "vision" ||
      (engine === undefined && vdoc?.type !== TESSERACT_TYPE);
    let opts: OcrOptions | undefined;
    if (useVision) {
      const auth = c.req.header("Authorization") ?? "";
      const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
      opts = {
        apiKey,
        apiUrl: vdoc?.apiUrl ?? "",
        model: vdoc?.model ?? "",
      };
    }
    try {
      await ocrSource(id, engine, opts);
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  // Speech-to-text for audio sources. Mirrors the OCR-vision key discipline:
  // the Whisper API key is sourced ONLY from the request Authorization header —
  // never read from settings, never logged, never persisted. Uses the chat
  // provider's base URL + key; the model defaults to whisper-1 (the chat model
  // is NOT a valid STT model, so it is ignored here).
  app.post("/sources/:id/transcribe", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const settings = getSettings();
    const stt = settings.resolved?.stt;
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const body = await c.req
      .json<{ model?: string }>()
      .catch(() => ({}) as { model?: string });
    const opts = {
      apiKey,
      apiUrl: stt?.apiUrl ?? "",
      model: body.model ?? stt?.model ?? "whisper-1",
    };
    try {
      await transcribeSource(id, opts);
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  // Describe a standalone image (vision_image function): understand the image
  // and store a textual description as its text. Mirrors the OCR/transcribe key
  // discipline — the vision_image provider's key is sourced ONLY from the
  // request Authorization header.
  app.post("/sources/:id/describe-image", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const settings = getSettings();
    const vimg = settings.resolved?.vision_image;
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const opts = {
      apiKey,
      apiUrl: vimg?.apiUrl ?? "",
      model: vimg?.model ?? "",
    };
    try {
      await describeImageSource(id, opts);
      return c.json({ ok: true, id });
    } catch (e) {
      return c.json({ error: (e as Error)?.message ?? String(e) }, 500);
    }
  });

  // Auto-detect a reference for a source via a LAYERED pipeline (cheapest /
  // most authoritative first; LLM only as the catch-all):
  //   0. PDF /info metadata   (free + deterministic; PDFs only) — read once,
  //      used as a title ANCHOR for stage 1 AND as a standalone hit in stage 2
  //   1. DOI scan → Crossref  (title-page scoped + anchor-verified; canonical
  //      CSL JSON when the source has its own DOI)
  //   2. PDF /info metadata   (the anchor itself, if it had enough data)
  //   3. LLM extract           (title page → JSON; needs a chat binding + key)
  // First stage that yields a title or authors wins and the rest are skipped,
  // so a self-describing PDF never spends an LLM call. The DOI stage is
  // SCOPED to the title page and (when a PDF-meta title anchor exists)
  // VERIFIED against it, so a cited work's DOI from the bibliography can't be
  // mis-attributed to a source whose own DOI is absent (books/preprints/
  // scans). A linked reference is only treated as "done" if it already has
  // authors OR a doi — a placeholder (citekey-from-filename only) is ENRICHED
  // IN PLACE so re-running detect actually fills the empty rows instead of
  // skipping them. `source` reports which stage produced the data
  // ("doi" | "pdf-meta" | "llm" | "none"). The chat key for stage 3 comes ONLY
  // from the Authorization header — never persisted; absent key ⇒ stage 3 is
  // skipped silently.
  app.post("/sources/:id/detect-reference", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const id = c.req.param("id");
    const src = getSourceById(id);
    if (!src) return c.json({ error: "not found" }, 404);

    const linked = listReferences({ sourceFileId: id });
    const linkedRef = linked[0] ?? null;
    // "Complete" = has authors OR a doi → nothing to enrich; return as-is so
    // user-curated rows are never clobbered by a re-scan.
    if (linkedRef && (linkedRef.authors.length > 0 || linkedRef.doi)) {
      return c.json({
        found: true,
        reference: linkedRef,
        doi: null,
        alreadyLinked: true,
        source: "none",
      });
    }

    const settings = getSettings();
    const contactEmail = settings.contactEmail || undefined;
    const { text } = getSourceText(id);

    // Chat binding + key for stage 3 (LLM). Key is header-only; no binding/key
    // ⇒ stage 3 silently skipped, not an error.
    const auth = c.req.header("Authorization") ?? "";
    const chatKey = auth.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const cb = settings.resolved?.chat;
    const chatConfig =
      chatKey && cb?.apiUrl && cb?.model
        ? { apiUrl: cb.apiUrl, model: cb.model }
        : null;

    // `base` is merged into every upsert so: (a) the source FK is set, and
    // (b) if we're enriching a placeholder, its id pins the update to the
    // existing row (citekey stays frozen).
    const base: Partial<Reference> = { source_file_id: id };
    if (linkedRef) base.id = linkedRef.id;
    const upsert = (patch: Partial<Reference>) =>
      upsertReference({ ...base, ...patch });
    const alreadyLinked = !!linkedRef;

    // Stage 0 (free, deterministic): PDF /info metadata, read ONCE and reused
    // two ways — as a TITLE ANCHOR to verify DOI hits (stage 1), and as a
    // standalone hit (stage 2) when the DOI stage finds nothing trustworthy.
    let pdfMeta: Partial<Reference> | null = null;
    if (src.ext.toLowerCase() === "pdf") {
      try {
        const bytes = await Bun.file(
          join(getCurrentProject()!.projectPath, src.relPath),
        ).arrayBuffer();
        pdfMeta = await extractPdfMetadata(bytes);
      } catch {
        // unreadable/missing PDF — no anchor, no meta hit; fall through.
        pdfMeta = null;
      }
    }
    const anchorTitle = pdfMeta?.title ?? null;

    // Stage 1: DOI scan → Crossref. Two guards against mis-attributing a
    // CITED work's DOI to this source (the classic failure when the source's
    // own DOI is absent — books/preprints/scans/chapters):
    //   (a) SCOPE: only the title-page region (`firstPageRegion`) is scanned,
    //       so a bibliography DOI on page 2+ is never even considered.
    //   (b) VERIFY: when a PDF-meta title anchor exists, a candidate is
    //       accepted only if its Crossref title matches the anchor — so even a
    //       stray DOI on page 1 (e.g. cited in an abstract) is rejected.
    for (const doi of extractDois(firstPageRegion(text)).slice(0, 5)) {
      const ref = await crossrefByDoi(doi, { contactEmail });
      if (!ref) continue;
      if (anchorTitle && !titlesMatch(ref.title, anchorTitle)) continue;
      const saved = upsert(ref);
      return c.json({ found: true, reference: saved, doi, alreadyLinked, source: "doi" });
    }

    // Stage 2: PDF /info metadata (the anchor itself, if it had enough data).
    if (
      pdfMeta &&
      (pdfMeta.title || (pdfMeta.authors && pdfMeta.authors.length > 0))
    ) {
      const saved = upsert(pdfMeta);
      return c.json({ found: true, reference: saved, doi: null, alreadyLinked, source: "pdf-meta" });
    }

    // Stage 3: LLM extraction (catch-all; needs chat binding + key).
    if (chatConfig && chatKey) {
      const ref = await extractReferenceViaLLM(text, { apiKey: chatKey, config: chatConfig });
      if (ref) {
        const saved = upsert(ref);
        return c.json({ found: true, reference: saved, doi: null, alreadyLinked, source: "llm" });
      }
    }

    return c.json({ found: false, reference: linkedRef, doi: null, alreadyLinked, source: "none" });
  });
}
