// Unit tests for the embedding dispatcher + adapters.
//
// These exercise the KEY-ISOLATION invariants WITHOUT a live key:
//   - missing key throws a clean, key-free error (openai + google adapters);
//   - the factory wraps any adapter error as `Error("embed failed: <orig>")`;
//   - the error bodies never echo a key (truncate() caps provider bodies).
//
// No network, no DB, no keychain — pure adapter boundary checks.

import { expect, test } from "bun:test";
import { embedBatch, type EmbedEngine } from "./index.ts";

test("openai adapter throws a clean error when no api key is supplied", async () => {
  let err: Error | null = null;
  try {
    // dynamic import to keep the adapter's default model/url in play
    const { runOpenAIEmbed } = await import("./openai.ts");
    await runOpenAIEmbed(["hello"], {});
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect((err as Error).message).toBe("openai embed requires an api key");
  // the message must never contain a key fragment
  expect((err as Error).message).not.toContain("Bearer");
});

test("google adapter throws a clean error when no api key is supplied", async () => {
  let err: Error | null = null;
  try {
    const { runGoogleEmbed } = await import("./google.ts");
    await runGoogleEmbed(["hello"], {});
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect((err as Error).message).toBe("google embed requires an api key");
});

test("factory wraps adapter errors as `embed failed: <orig>`", async () => {
  let err: Error | null = null;
  try {
    await embedBatch(["hello"], "openai" as EmbedEngine, {}); // no key
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  // The original "openai embed requires an api key" is wrapped by the factory.
  expect((err as Error).message).toBe(
    "embed failed: openai embed requires an api key"
  );
});

test("factory rejects an unknown engine with a wrapped error", async () => {
  let err: Error | null = null;
  try {
    await embedBatch(["hello"], "bogus" as EmbedEngine, { apiKey: "x" });
  } catch (e) {
    err = e as Error;
  }
  expect(err).not.toBeNull();
  expect((err as Error).message).toBe("embed failed: unknown embed engine: bogus");
});
