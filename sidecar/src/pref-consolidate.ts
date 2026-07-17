import { createHash } from "node:crypto";
import { getCurrentProject, getSettings } from "./db";
import { getAgentPersona, readPreferences, writePreferences } from "./agent-files.ts";
import { completeChat } from "./chat/openai.ts";

const META_KEY = "pref_last_hash";

export interface PrefIssue {
  text: string;
  reason: string;
}

export interface ConsolidationResult {
  changed: boolean;
  rawHash?: string;
  proposal?: string;
  issues?: PrefIssue[];
  error?: string;
}

function hashString(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function getMeta(key: string): string | null {
  const p = getCurrentProject();
  if (!p) return null;
  const row = p.db
    .query("SELECT value FROM meta WHERE key = ?")
    .get(key) as { value?: string } | null;
  return row?.value ?? null;
}

function setMeta(key: string, value: string): void {
  const p = getCurrentProject();
  if (!p) throw new Error("no project initialized");
  p.db
    .prepare(
      "INSERT INTO meta(key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

const SYSTEM_PROMPT = [
  "You consolidate a user's running preference log into one clean list.",
  "Inputs: the assistant personality, its rules, and the current preference log.",
  "Goal: return the new preference file contents plus any flagged issues.",
  "Rules:",
  "- Merge duplicates and near-duplicates into one concise bullet.",
  "- Preserve EVERY distinct durable preference, near-verbatim.",
  "- Never invent preferences that are not in the log.",
  "- If two preferences contradict each other OR contradict the personality/rules, do NOT pick a winner: list both in `issues`.",
  "- Output STRICT JSON only. No prose, no markdown fences.",
  'Schema: {"contents": string, "issues": [{"text": string, "reason": string}]}',
  "`contents` is the new file body (markdown bullets, one per line). `issues` may be empty.",
].join("\n");

function parseConsolidation(
  text: string,
): { contents: string; issues: PrefIssue[] } {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  try {
    const obj = JSON.parse(t) as { contents?: unknown; issues?: unknown };
    const contents = typeof obj.contents === "string" ? obj.contents : "";
    const issues: PrefIssue[] = Array.isArray(obj.issues)
      ? obj.issues
          .filter(
            (i): i is Record<string, unknown> =>
              !!i && typeof i === "object" && typeof (i as { text?: unknown }).text === "string",
          )
          .map((i) => ({
            text: String(i.text),
            reason: typeof i.reason === "string" ? i.reason : "",
          }))
      : [];
    return { contents, issues };
  } catch {
    return { contents: "", issues: [] };
  }
}

export async function consolidatePreferences(
  apiKey: string,
): Promise<ConsolidationResult> {
  const raw = await readPreferences();
  if (!raw.trim()) return { changed: false };
  const rawHash = hashString(raw);
  if (getMeta(META_KEY) === rawHash) return { changed: false };

  const s = getSettings();
  const chat = s.resolved?.chat;
  if (!chat?.apiUrl || !chat?.model) {
    return { changed: false, error: "no chat provider/model bound" };
  }
  const persona = await getAgentPersona();
  const user = JSON.stringify(
    { personality: persona.personality, rules: persona.rules, preferences: raw },
    null,
    2,
  );

  const text = await completeChat({
    apiKey,
    config: { apiUrl: chat.apiUrl, model: chat.model },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    temperature: 0,
  });
  const parsed = parseConsolidation(text);
  if (!parsed.contents.trim()) {
    return { changed: false, error: "consolidation returned no contents" };
  }
  return {
    changed: true,
    rawHash,
    proposal: parsed.contents,
    issues: parsed.issues,
  };
}

export async function acceptPreferences(contents: string): Promise<void> {
  await writePreferences(contents);
  setMeta(META_KEY, hashString(contents));
}

export async function dismissPreferences(rawHash: string): Promise<void> {
  setMeta(META_KEY, rawHash);
}
