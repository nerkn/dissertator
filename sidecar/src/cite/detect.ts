import { join } from "node:path";
import { type Reference } from "@dissertator/shared";
import {
  getCurrentProject,
  getSettings,
  getSourceById,
  getSourceText,
  listReferences,
  upsertReference,
} from "../db";
import { crossrefByDoi } from "./crossref.ts";
import { extractDois, firstPageRegion } from "./doi.ts";
import { extractPdfMetadata } from "./pdfmeta.ts";
import { extractReferenceViaLLM } from "./llmExtract.ts";
import { titlesMatch } from "./titleMatch.ts";
import { getChatKey } from "../db/globalDb.ts";

export interface DetectResult {
  found: boolean;
  reference: Reference | null;
  doi: string | null;
  alreadyLinked: boolean;
  source: "doi" | "pdf-meta" | "llm" | "none";
}

export async function detectReference(
  id: string,
  opts: { chatKey?: string } = {},
): Promise<DetectResult> {
  const tag = `[identify ${id}]`;
  const t0 = Date.now();
  const log = (stage: string, extra?: unknown) => {
    const ms = Date.now() - t0;
    if (extra === undefined) console.error(`${tag} ${stage} (+${ms}ms)`);
    else console.error(`${tag} ${stage} (+${ms}ms)`, extra);
  };
  const project = getCurrentProject();
  if (!project) throw new Error("no project");
  const src = getSourceById(id);
  if (!src) throw new Error("not found");
  log("start", {
    name: src.relPath,
    ext: src.ext,
    textStatus: src.textStatus,
  });

  const linked = listReferences({ sourceFileId: id });
  const linkedRef = linked[0] ?? null;
  if (linkedRef && (linkedRef.authors.length > 0 || linkedRef.doi)) {
    log("skip: already linked", { id: linkedRef.id, doi: linkedRef.doi });
    return {
      found: true,
      reference: linkedRef,
      doi: null,
      alreadyLinked: true,
      source: "none",
    };
  }

  const settings = getSettings();
  const contactEmail = settings.contactEmail || undefined;
  const { text } = getSourceText(id);

  const chatKey = opts.chatKey ?? getChatKey();
  const cb = settings.resolved?.chat;
  const chatConfig =
    chatKey && cb?.apiUrl && cb?.model
      ? { apiUrl: cb.apiUrl, model: cb.model }
      : null;

  const base: Partial<Reference> = { source_file_id: id };
  if (linkedRef) base.id = linkedRef.id;
  const stripLinkage = (
    patch: Partial<Reference>,
  ): Partial<Reference> => {
    if ((patch.id ?? "") === "" || patch.source_file_id === null) {
      const { id: _pid, source_file_id: _psf, ...rest } = patch;
      return rest;
    }
    return patch;
  };
  const upsert = (patch: Partial<Reference>) =>
    upsertReference({ ...base, ...stripLinkage(patch) });
  const alreadyLinked = !!linkedRef;

  let pdfMeta: Partial<Reference> | null = null;
  if (src.ext.toLowerCase() === "pdf") {
    try {
      const bytes = await Bun.file(
        join(project.projectPath, src.relPath),
      ).arrayBuffer();
      log("pdf-meta: extracting");
      pdfMeta = await extractPdfMetadata(bytes);
      log("pdf-meta: done", {
        title: pdfMeta?.title ?? null,
        authors: pdfMeta?.authors?.length ?? 0,
      });
    } catch (e) {
      log("pdf-meta: error", (e as Error)?.message ?? String(e));
      pdfMeta = null;
    }
  } else {
    log("pdf-meta: skip (non-pdf)");
  }
  const anchorTitle = pdfMeta?.title ?? null;
  log("anchor title", anchorTitle);

  const doiCandidates = extractDois(firstPageRegion(text)).slice(0, 5);
  log("doi stage: candidates", doiCandidates);
  for (const doi of doiCandidates) {
    let ref;
    try {
      ref = await crossrefByDoi(doi, { contactEmail });
    } catch (e) {
      log(`doi stage: crossref error for ${doi}`, (e as Error)?.message ?? String(e));
      continue;
    }
    if (!ref) {
      log(`doi stage: no crossref hit for ${doi}`);
      continue;
    }
    if (anchorTitle && !titlesMatch(ref.title, anchorTitle)) {
      log(`doi stage: title mismatch for ${doi}`, {
        refTitle: ref.title,
        anchorTitle,
      });
      continue;
    }
    const saved = upsert(ref);
    log("doi stage: HIT", { doi, refId: saved.id });
    return { found: true, reference: saved, doi, alreadyLinked, source: "doi" };
  }
  log("doi stage: exhausted, no hit");

  const pdfMetaHasTitle = !!pdfMeta?.title;
  if (pdfMetaHasTitle) {
    const saved = upsert(pdfMeta!);
    log("pdf-meta: complete hit (has title)", { refId: saved.id });
    return { found: true, reference: saved, doi: null, alreadyLinked, source: "pdf-meta" };
  }

  if (chatConfig && chatKey) {
    log("llm stage: extracting", {
      model: chatConfig.model,
      pdfMetaPartial: !!pdfMeta,
    });
    let ref;
    try {
      ref = await extractReferenceViaLLM(text, {
        apiKey: chatKey,
        config: chatConfig,
      });
    } catch (e) {
      log("llm stage: error", (e as Error)?.message ?? String(e));
      ref = null;
    }
    if (ref) {
      const merged = { ...(pdfMeta ?? {}), ...ref };
      const saved = upsert(merged);
      log("llm stage: HIT", {
        refId: saved.id,
        title: ref.title,
        mergedFields: Object.keys(merged),
      });
      return { found: true, reference: saved, doi: null, alreadyLinked, source: "llm" };
    }
    log("llm stage: no result");
  } else {
    log("llm stage: skip (no chat config/key)", {
      hasKey: !!chatKey,
      hasConfig: !!chatConfig,
    });
  }

  if (pdfMeta && pdfMeta.authors && pdfMeta.authors.length > 0) {
    const saved = upsert(pdfMeta);
    log("pdf-meta fallback: partial (authors only)", { refId: saved.id });
    return { found: true, reference: saved, doi: null, alreadyLinked, source: "pdf-meta" };
  }

  log("done: not found");
  return { found: false, reference: linkedRef, doi: null, alreadyLinked, source: "none" };
}
