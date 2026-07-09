// Asset import router — the single chokepoint for the editor's drag-drop,
// file-picker, and screenshot-paste flows. It classifies a payload by type,
// hands the actual file I/O to the sidecar (`POST /assets/import`, which
// copies/moves/writes into <projectPath>/images|audio or the project root),
// and returns the project-relative path + kind so the editor can emit
// `![](images/x.png)` / links / notifications. The file watcher auto-ingests
// supported types once they land, so imported PDFs/docs become sources too.

import { api } from "./api";

export type AssetKind = "image" | "audio" | "document";

const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "svg",
  "avif",
]);
const AUDIO_EXT = new Set([
  "wav",
  "mp3",
  "m4a",
  "ogg",
  "flac",
  "aac",
  "opus",
  "weba",
]);

export function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** Classify a file by extension (and MIME hint) into image | audio | document. */
export function classifyAsset(filename: string, mimeType?: string): AssetKind {
  const ext = extOf(filename);
  if (IMAGE_EXT.has(ext) || (mimeType ?? "").startsWith("image/")) return "image";
  if (AUDIO_EXT.has(ext) || (mimeType ?? "").startsWith("audio/")) return "audio";
  return "document";
}

function destFor(kind: AssetKind): "images" | "audio" | "root" {
  return kind === "image" ? "images" : kind === "audio" ? "audio" : "root";
}

export interface ImportedAsset {
  relPath: string;
  absPath: string;
  kind: AssetKind;
}

/** Import a real file on disk (drag-drop or file picker). Default: copy. */
export async function importAssetFromPath(
  absPath: string,
  filename?: string,
  mode: "copy" | "move" = "copy",
): Promise<ImportedAsset> {
  const name = filename ?? absPath.split(/[/\\]/).pop() ?? "file";
  const kind = classifyAsset(name);
  const res = await api.importAsset({
    sourcePath: absPath,
    filename: name,
    dest: destFor(kind),
    mode,
  });
  return { relPath: res.relPath, absPath: res.absPath, kind };
}

/** Import image bytes from the clipboard (screenshot paste). */
export async function importAssetFromBlob(
  blob: Blob,
  filename: string,
): Promise<ImportedAsset> {
  const dataUrl = await blobToDataUrl(blob);
  const kind = classifyAsset(filename, blob.type);
  const res = await api.importAsset({
    dataUrl,
    filename,
    dest: destFor(kind),
  });
  return { relPath: res.relPath, absPath: res.absPath, kind };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error ?? new Error("failed to read blob"));
    r.readAsDataURL(blob);
  });
}
