// Fetch the ibm-granite/granite-embedding-97m-multilingual-r2 model files
// (ONNX + tokenizer) from Hugging Face into sidecar/models/... so that
// `stage:resources` (run by `tauri build`'s beforeBuildCommand) can bundle them
// into the app as Tauri resources.
//
// Why this exists: the ~94 MB ONNX model is too large to commit to git, so it
// is gitignored (see .gitignore → `sidecar/models/`). Local devs already have
// it; CI (AppVeyor) and fresh checkouts fetch it here. Idempotent — skips any
// file already present and non-empty.
//
// Run by appveyor.yml before `tauri build`. Not needed in dev (the sidecar
// loads the model from sidecar/models/ directly via local.ts's fallback #3).
import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL_DIR = join(
  sidecarRoot,
  "models",
  "granite-embedding-97m-multilingual-r2",
);
const HF =
  "https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2/resolve/main";

/** Files stage-resources.ts requires (onnx + tokenizer.json) + tokenizer_config. */
const FILES = [
  "onnx/model_quint8_avx2.onnx",
  "tokenizer.json",
  "tokenizer_config.json",
];

function mb(p: string): string {
  return (statSync(p).size / 1048576).toFixed(1);
}

async function download(url: string, dest: string): Promise<void> {
  console.log(`  ↓ ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  // Stream to disk (handles 94 MB without buffering the whole file in memory).
  await pipeline(
    Readable.fromWeb(res.body as ReadableStream),
    createWriteStream(dest),
  );
}

let fetched = 0;
for (const rel of FILES) {
  const dest = join(MODEL_DIR, rel);
  if (existsSync(dest) && statSync(dest).size > 0) {
    console.log(`[fetch-granite-model] ✓ ${rel} (${mb(dest)} MB, cached)`);
    continue;
  }
  console.log(`[fetch-granite-model] fetching ${rel} ...`);
  mkdirSync(dirname(dest), { recursive: true });
  await download(`${HF}/${rel}`, dest);
  console.log(`[fetch-granite-model] ✓ ${rel} (${mb(dest)} MB)`);
  fetched++;
}
console.log(
  `[fetch-granite-model] done (${fetched} downloaded, ${FILES.length - fetched} cached) → ${MODEL_DIR}`,
);
