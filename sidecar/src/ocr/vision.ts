// Provider multimodal OCR via an OpenAI-compatible `/chat/completions` POST.
//
// Sends a single user message containing a short text instruction plus a
// base64 data-URL image to `POST {apiUrl}/chat/completions`. The API key
// (`opts.apiKey`) is sent ONLY in the `Authorization` header — it is never
// persisted, embedded in the request body, or logged. On any non-2xx response
// the error is thrown as `Error("vision ocr failed: <status> <body>")`.
//
// Provider notes: z.ai (`https://api.z.ai/api/paas/v4`), openrouter, openai,
// and custom OpenAI-compatible endpoints all work on this single path. The
// engine is OpenAI-style only — no provider-specific branching.

import { extname } from "node:path";
import type { OcrOptions, OcrResult } from "./index";

/** Default vision-capable chat model when `opts.model` is absent. */
const DEFAULT_MODEL = "gpt-4o-mini";

/** Cap on returned tokens — generous enough for a full page of text. */
const MAX_TOKENS = 2000;

const INSTRUCTION =
  "Extract all text from this image. Return only the transcribed text, preserving reading order.";

/** MIME sniffed from the file extension; unknown extensions fall back to PNG. */
function sniffMime(absPath: string): string {
  switch (extname(absPath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".tif":
    case ".tiff":
      return "image/tiff";
    default:
      return "image/png";
  }
}

/**
 * Coerce a chat `content` field to a string. OpenAI returns a string, but some
 * OpenAI-compatible providers return an array of content blocks
 * (`{ type: "text", text }`). Both are handled.
 */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        typeof part === "string" ? part : (part as { text?: string })?.text ?? ""
      )
      .join("");
  }
  return content == null ? "" : String(content);
}

/**
 * Run vision OCR against an OpenAI-compatible endpoint. Throws
 * `Error("vision ocr requires an api key")` if `opts.apiKey` is missing, or
 * `Error("vision ocr failed: <status> <body>")` on a non-2xx response.
 */
export async function runVision(
  absPath: string,
  opts: OcrOptions = {}
): Promise<OcrResult> {
  const apiKey = opts.apiKey;
  if (!apiKey) throw new Error("vision ocr requires an api key");

  const apiUrl = (opts.apiUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = opts.model ?? DEFAULT_MODEL;
  const instruction = opts.instruction ?? INSTRUCTION;

  const buf = await Bun.file(absPath).arrayBuffer();
  const b64 = Buffer.from(buf).toString("base64");
  const dataUrl = `data:${sniffMime(absPath)};base64,${b64}`;

  const url = `${apiUrl}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Key is transmitted ONLY here; never logged or persisted.
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: instruction },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`vision ocr failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const text = contentToText(data?.choices?.[0]?.message?.content);
  return { text, pageCount: 1 };
}
