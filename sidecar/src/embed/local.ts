// Local keyless embedding adapter — ibm-granite/granite-embedding-97m-multilingual-r2
// (ModernBERT, 384-dim, CLS pooling + L2 normalize), run fully in-process via
// onnxruntime-node + @huggingface/tokenizers. No API key, no network.
//
// Mirrors the adapter contract of openai.ts/google.ts: `runLocalEmbed(texts,
// opts)` → `{ vectors, dimensions }`, one vector per input, order preserved.
// Mirrors the keyless-local pattern of ocr/tesseract.ts (no key, no remote).
//
// MODEL FILES (shipped as Tauri resources in production):
//   <modelDir>/onnx/model_quint8_avx2.onnx   (93.7 MB, int8, REQUIRES AVX2)
//   <modelDir>/tokenizer.json
//
// <modelDir> resolution (first hit wins):
//   1. env DISSERTATOR_GRANITE_DIR          (explicit override / Tauri res dir)
//   2. env TAURI_RESOURCE_DIR + "/granite-embedding-97m-multilingual-r2"
//   3. dev fallback: <sidecar>/models/granite-embedding-97m-multilingual-r2
//
// The ONNX session + tokenizer load ONCE (lazy singleton) on first call and
// are reused for the process lifetime. Inference is batched (one session.run
// per call). Output last_hidden_state[:,0,:] (CLS token), L2-normalized.
// Prompts are symmetric (config_sentence_transformers.json: query/document =
// ""), so no query/passage prefix is applied — see the granite model card.

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EmbedOptions, EmbedResult } from "./index.ts";

/** Native output dimension (granite hidden_size). Matches the vec0 dim lock. */
export const GRANITE_DIM = 384;

/**
 * Max tokens per input (truncation cap). 512 is a fast CPU default; the model
 * supports 32768 — raise for long-context chunks at a latency cost.
 */
const MAX_TOKENS = 512;

/** ONNX int8 quant file (AVX2 required). */
const ONNX_FILE = "onnx/model_quint8_avx2.onnx";

interface Loaded {
  // `any` so type-checking never hard-requires the native packages unless the
  // local engine is actually imported at runtime (lazy `await import` below).
  ort: any;
  session: any;
  tokenizer: any;
  inputNames: string[];
  outputName: string;
}

let cached: Loaded | null = null;
let loading: Promise<Loaded> | null = null;

/** Resolve the model directory (see header for precedence). */
function modelDir(): string {
  const env = process.env;
  if (env.DISSERTATOR_GRANITE_DIR) return env.DISSERTATOR_GRANITE_DIR;
  if (env.TAURI_RESOURCE_DIR) {
    return join(env.TAURI_RESOURCE_DIR, "granite-embedding-97m-multilingual-r2");
  }
  return join(import.meta.dir, "..", "..", "models", "granite-embedding-97m-multilingual-r2");
}

async function load(): Promise<Loaded> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    const dir = modelDir();
    const onnxPath = join(dir, ONNX_FILE);
    const tokPath = join(dir, "tokenizer.json");
    if (!existsSync(onnxPath)) {
      throw new Error(
        `local embed: model not found at ${onnxPath} (set DISSERTATOR_GRANITE_DIR or place the model under sidecar/models/)`
      );
    }
    if (!existsSync(tokPath)) {
      throw new Error(`local embed: tokenizer.json not found at ${tokPath}`);
    }
    // Lazy import: non-granite builds/tests don't pull the native packages.
    const ort: any = await import("onnxruntime-node");
    const { Tokenizer } = await import("@huggingface/tokenizers");
    const { readFileSync } = await import("node:fs");

    const session = await ort.InferenceSession.create(onnxPath, {
      graphOptimizationLevel: "all",
    });
    // @huggingface/tokenizers@0.1.x is pure-JS with no static fromFile; the
    // Tokenizer ctor takes (tokenizer.json, tokenizer_config.json) objects.
    const tokenizerJson = JSON.parse(readFileSync(tokPath, "utf8"));
    const configJson = JSON.parse(
      readFileSync(join(dir, "tokenizer_config.json"), "utf8")
    );
    const tokenizer = new Tokenizer(tokenizerJson, configJson);

    const inputNames: string[] = session.inputNames;
    const outputName: string =
      session.outputNames.find((n: string) => /hidden|embedding|last/i.test(n)) ??
      session.outputNames[0];

    cached = { ort, session, tokenizer, inputNames, outputName };
    return cached;
  })();
  return loading;
}

function toBigInt64(arr: number[]): BigInt64Array {
  const out = new BigInt64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = BigInt(arr[i]);
  return out;
}

/**
 * Embed a batch of texts locally with granite-embedding (keyless, offline).
 * Ignores `opts.apiKey`/`opts.apiUrl`/`opts.model`. Returns one 384-dim
 * L2-normalized vector per input, in input order. Throws
 * `Error("local embed failed: …")` if the model/tokenizer can't load or
 * inference fails (including a missing-AVX2 crash on the int8 ONNX).
 */
export async function runLocalEmbed(
  texts: string[],
  _opts: EmbedOptions = {}
): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], dimensions: GRANITE_DIM };
  try {
    const { ort, session, tokenizer, inputNames, outputName } = await load();

    // Tokenize (special tokens ON by default). Manual pad/truncate so we don't
    // depend on setPadding/setTruncation API shape across tokenizers versions.
    // encode() returns { ids, attention_mask } (pure-JS tokenizers 0.1.x);
    // add_special_tokens defaults true → CLS at index 0 (CLS pooling).
    const encs = texts.map((t) => tokenizer.encode(t));
    const lens = encs.map((e: any) => e.ids.length);
    const L = Math.min(MAX_TOKENS, Math.max(1, ...lens));

    const idsFlat: number[] = [];
    const maskFlat: number[] = [];
    for (const e of encs as any[]) {
      const ids: number[] = e.ids.slice(0, MAX_TOKENS);
      const mask: number[] = e.attention_mask.slice(0, MAX_TOKENS);
      // Pad id is irrelevant: attention_mask=0 on padded slots means the
      // transformer never attends to them, and we read only CLS (index 0).
      while (ids.length < L) {
        ids.push(0);
        mask.push(0);
      }
      idsFlat.push(...ids);
      maskFlat.push(...mask);
    }
    const batch = encs.length;

    // Build feeds only for the inputs the session actually declares.
    const feeds: Record<string, any> = {};
    for (const name of inputNames) {
      if (name === "input_ids") {
        feeds[name] = new ort.Tensor("int64", toBigInt64(idsFlat), [batch, L]);
      } else if (name === "attention_mask") {
        feeds[name] = new ort.Tensor("int64", toBigInt64(maskFlat), [batch, L]);
      } else if (name === "token_type_ids") {
        // ModernBERT has no segment ids; feed zeros.
        feeds[name] = new ort.Tensor("int64", new BigInt64Array(batch * L), [batch, L]);
      }
    }

    const out = await session.run(feeds);
    const data: Float32Array = out[outputName].data; // [batch, L, 384] row-major

    const vectors: number[][] = [];
    for (let b = 0; b < batch; b++) {
      const off = b * L * GRANITE_DIM; // CLS at sequence index 0
      const vec = new Array<number>(GRANITE_DIM);
      let norm = 0;
      for (let d = 0; d < GRANITE_DIM; d++) {
        const v = data[off + d];
        vec[d] = v;
        norm += v * v;
      }
      norm = Math.sqrt(norm) || 1;
      for (let d = 0; d < GRANITE_DIM; d++) vec[d] /= norm;
      vectors.push(vec);
    }
    return { vectors, dimensions: GRANITE_DIM };
  } catch (e) {
    throw new Error(`local embed failed: ${(e as Error)?.message ?? String(e)}`);
  }
}
