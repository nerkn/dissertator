// Stage per-platform native libs + the granite embedding model into
// src-tauri/resources/ so `tauri build` bundles them (see tauri.conf.json
// `bundle.resources`). Run automatically via the root `stage:resources`
// script, which `beforeBuildCommand` invokes before every `tauri build`.
//
// Why: `bun build --compile` bundles JS but NOT native .so/.dll. So the
// compiled sidecar can't find onnxruntime's libonnxruntime.so.1 or
// sqlite-vec's vec0.so at runtime. Tauri ships them as bundled resources
// instead, and src-tauri/src/lib.rs points the sidecar at the resource dir
// (LD_LIBRARY_PATH / PATH + DISSERTATOR_VEC0_PATH + DISSERTATOR_GRANITE_DIR).
//
// Layout produced (cleaned + rebuilt every run):
//   src-tauri/resources/native/libonnxruntime.so.1   (linux) | onnxruntime.dll (windows)
//   src-tauri/resources/native/vec0.so               (linux) | vec0.dll        (windows)
//   src-tauri/resources/granite-embedding-97m-multilingual-r2/onnx/model_quint8_avx2.onnx
//   src-tauri/resources/granite-embedding-97m-multilingual-r2/tokenizer.json
//   src-tauri/resources/granite-embedding-97m-multilingual-r2/tokenizer_config.json
//
// Only the BUILD host's platform is staged → each per-OS build (Linux built
// on Linux, Windows on Windows — e.g. a CI matrix) ships just its own native
// lib. Cross-compilation is NOT supported by this script.

import { cpSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sidecarRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sidecarRoot, "..");
const resDir = join(repoRoot, "src-tauri", "resources");

const plat = process.platform; // 'linux' | 'win32' | 'darwin'
const arch = process.arch; // 'x64' | 'arm64'

const ORT = {
  dir: join(
    sidecarRoot,
    "node_modules",
    "onnxruntime-node",
    "bin",
    "napi-v6",
    plat,
    arch,
  ),
  lib:
    plat === "win32"
      ? "onnxruntime.dll"
      : plat === "darwin"
        ? "libonnxruntime.1.dylib"
        : "libonnxruntime.so.1",
};

const VEC = {
  pkg:
    plat === "win32"
      ? "sqlite-vec-windows-x64"
      : plat === "darwin"
        ? arch === "arm64"
          ? "sqlite-vec-darwin-arm64"
          : "sqlite-vec-darwin-x64"
        : "sqlite-vec-linux-x64",
  lib: plat === "win32" ? "vec0.dll" : plat === "darwin" ? "vec0.dylib" : "vec0.so",
};

const MODEL_SRC = join(sidecarRoot, "models", "granite-embedding-97m-multilingual-r2");
const MODEL_DST = join(resDir, "granite-embedding-97m-multilingual-r2");

function requireFile(p: string, what: string): void {
  if (!existsSync(p)) {
    console.error(`[stage-resources] MISSING ${what}:\n  ${p}`);
    console.error(
      "  Ensure `bun install` ran (onnxruntime-node / sqlite-vec-*) and the\n" +
        "  granite model is downloaded under sidecar/models/granite-embedding-97m-multilingual-r2/\n" +
        "  (onnx/model_quint8_avx2.onnx + tokenizer.json + tokenizer_config.json\n" +
        "   from ibm-granite/granite-embedding-97m-multilingual-r2).",
    );
    process.exit(1);
  }
}

function mb(p: string): string {
  return (statSync(p).size / 1048576).toFixed(1);
}

// 1. clean + recreate (no stale cross-platform leftovers)
rmSync(resDir, { recursive: true, force: true });
const nativeDir = join(resDir, "native");
mkdirSync(nativeDir, { recursive: true });
mkdirSync(MODEL_DST, { recursive: true });

// 2. onnxruntime native lib (CPU EP only — DirectML.* are NOT shipped)
const ortSrc = join(ORT.dir, ORT.lib);
requireFile(ortSrc, "onnxruntime native lib");
cpSync(ortSrc, join(nativeDir, ORT.lib));
console.log(`[stage-resources] onnxruntime: ${ORT.lib} (${mb(ortSrc)} MB)`);

// 3. sqlite-vec vec0 lib (also repairs sqlite-vec in release builds)
const vecSrc = join(sidecarRoot, "node_modules", VEC.pkg, VEC.lib);
requireFile(vecSrc, "sqlite-vec vec0 lib");
cpSync(vecSrc, join(nativeDir, VEC.lib));
console.log(`[stage-resources] sqlite-vec: ${VEC.lib} (${mb(vecSrc)} MB)`);

// 4. granite model dir (recursive: onnx + tokenizer.json + tokenizer_config.json)
requireFile(join(MODEL_SRC, "onnx", "model_quint8_avx2.onnx"), "granite ONNX model");
requireFile(join(MODEL_SRC, "tokenizer.json"), "granite tokenizer.json");
cpSync(MODEL_SRC, MODEL_DST, { recursive: true });
console.log(`[stage-resources] granite model staged (${mb(join(MODEL_SRC, "onnx", "model_quint8_avx2.onnx"))} MB onnx)`);

console.log(`[stage-resources] done → ${resDir}`);
