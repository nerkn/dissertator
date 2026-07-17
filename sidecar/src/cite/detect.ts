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
  const project = getCurrentProject();
  if (!project) throw new Error("no project");
  const src = getSourceById(id);
  if (!src) throw new Error("not found");

  const linked = listReferences({ sourceFileId: id });
  const linkedRef = linked[0] ?? null;
  if (linkedRef && (linkedRef.authors.length > 0 || linkedRef.doi)) {
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
  const upsert = (patch: Partial<Reference>) =>
    upsertReference({ ...base, ...patch });
  const alreadyLinked = !!linkedRef;

  let pdfMeta: Partial<Reference> | null = null;
  if (src.ext.toLowerCase() === "pdf") {
    try {
      const bytes = await Bun.file(
        join(project.projectPath, src.relPath),
      ).arrayBuffer();
      pdfMeta = await extractPdfMetadata(bytes);
    } catch {
      pdfMeta = null;
    }
  }
  const anchorTitle = pdfMeta?.title ?? null;

  for (const doi of extractDois(firstPageRegion(text)).slice(0, 5)) {
    const ref = await crossrefByDoi(doi, { contactEmail });
    if (!ref) continue;
    if (anchorTitle && !titlesMatch(ref.title, anchorTitle)) continue;
    const saved = upsert(ref);
    return { found: true, reference: saved, doi, alreadyLinked, source: "doi" };
  }

  if (
    pdfMeta &&
    (pdfMeta.title || (pdfMeta.authors && pdfMeta.authors.length > 0))
  ) {
    const saved = upsert(pdfMeta);
    return { found: true, reference: saved, doi: null, alreadyLinked, source: "pdf-meta" };
  }

  if (chatConfig && chatKey) {
    const ref = await extractReferenceViaLLM(text, {
      apiKey: chatKey,
      config: chatConfig,
    });
    if (ref) {
      const saved = upsert(ref);
      return { found: true, reference: saved, doi: null, alreadyLinked, source: "llm" };
    }
  }

  return { found: false, reference: linkedRef, doi: null, alreadyLinked, source: "none" };
}
