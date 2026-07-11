import type { Hono } from "hono";
import {
  AI_FUNCTIONS,
  isKeylessProviderType,
  type AiFunction,
} from "@dissertator/shared";
import { getCurrentProject, getResolvedBindings } from "../db";
import { PNG_1x1, silentWav } from "../lib/av.ts";

/**
 * Per-function connectivity test: a minimal REAL call against the function's
 * bound provider+model using the caller's Authorization key. chat/vision do a
 * 1-token completion (vision sends a 1×1 image), embed embeds "test", stt
 * transcribes a short silent WAV. Returns {ok, latencyMs, sample?, error?}.
 */
export function registerFunctions(app: Hono): void {
  app.post("/functions/:fn/test", async (c) => {
    if (!getCurrentProject()) return c.json({ error: "no project" }, 400);
    const fn = c.req.param("fn") as AiFunction;
    if (!AI_FUNCTIONS.includes(fn)) {
      return c.json({ error: "unknown function" }, 400);
    }
    const resolved = getResolvedBindings();
    const r = resolved?.[fn];
    if (!r || !r.providerId) {
      return c.json({ ok: false, latencyMs: 0, error: "no binding for function" });
    }
    if (isKeylessProviderType(r.type)) {
      return c.json({ ok: true, latencyMs: 0, sample: "local (no network)" });
    }
    const auth = c.req.header("Authorization") ?? "";
    const apiKey = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const base = r.apiUrl.replace(/\/$/, "");
    const headers: Record<string, string> = apiKey
      ? { Authorization: `Bearer ${apiKey}` }
      : {};
    const t0 = Date.now();
    const fail = (error: string) =>
      c.json({ ok: false, latencyMs: Date.now() - t0, error });
    try {
      let sample = "";
      if (fn === "chat" || fn === "vision_doc" || fn === "vision_image") {
        const messages =
          fn === "chat"
            ? [{ role: "user", content: "Reply with one word: ok" }]
            : [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text:
                        fn === "vision_doc"
                          ? "What text is on this page?"
                          : "Describe this image in one word.",
                    },
                    { type: "image_url", image_url: { url: PNG_1x1 } },
                  ],
                },
              ];
        const resp = await fetch(`${base}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ model: r.model, messages, max_tokens: 5 }),
        });
        if (!resp.ok)
          return fail(`upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const data = (await resp.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        sample = String(data?.choices?.[0]?.message?.content ?? "").slice(0, 80);
      } else if (fn === "embed") {
        const resp = await fetch(`${base}/embeddings`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ model: r.model, input: "test" }),
        });
        if (!resp.ok)
          return fail(`upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const data = (await resp.json()) as {
          data?: Array<{ embedding?: number[] }>;
        };
        sample = `dim=${data?.data?.[0]?.embedding?.length ?? "?"}`;
      } else {
        // stt
        const form = new FormData();
        form.append(
          "file",
          new Blob([silentWav()], { type: "audio/wav" }),
          "silence.wav",
        );
        form.append("model", r.model);
        const resp = await fetch(`${base}/audio/transcriptions`, {
          method: "POST",
          headers,
          body: form,
        });
        if (!resp.ok)
          return fail(`upstream ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
        const data = (await resp.json()) as { text?: string };
        sample = String(data?.text ?? "").slice(0, 80) || "(empty transcript)";
      }
      return c.json({ ok: true, latencyMs: Date.now() - t0, sample });
    } catch (e) {
      return fail((e as Error)?.message ?? String(e));
    }
  });
}
