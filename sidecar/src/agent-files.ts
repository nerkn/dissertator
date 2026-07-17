// Personality + rules markdown the user edits in Settings → Agent and the
// chat system-prompt builder reads at turn time. Mirrors `prompts.ts`:
// self-contained FS helpers, no DB. Two files under `<dissertatorDir>/agent/`
// so future injection can glob `*.md` alphabetically (personality before
// rules). Seeded once on project init via {@link ensureAgentFiles}; a missing
// file is NOT an error — readers get "".

import { exists, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCurrentProject } from "./db";

/** Subdir of `Dissertator/` holding the user-tunable agent markdown. */
export const AGENT_DIR_NAME = "agent";
/** Fixed filenames so the GET/PUT contract is name-stable (no globbing yet). */
export const PERSONALITY_FILE = "personality.md";
export const RULES_FILE = "rules.md";
export const PREFERENCES_FILE = "preferences.md";

/** Default personality (seeded once, never overwritten on reopen). */
export const DEFAULT_PERSONALITY_MD = `Maintain a warm and supportive tone. Call me "mate" from time to time. Focus on helping me make better decisions with concise explanations, practical recommendations, and honest assessments.`;

/** Default rules (seeded once, never overwritten on reopen). */
export const DEFAULT_RULES_MD = `You are a thesis research assistant.

Priorities:
- Academic accuracy over speed.
- Be critical, not agreeable.
- Point out logical gaps, weak arguments, unsupported claims, and methodological issues.
- Distinguish clearly between facts, interpretations, and assumptions.
- Use formal academic language when writing thesis content.
- Prefer concise, evidence-based explanations.
- Suggest relevant theories, models, variables, and research methods when appropriate.
- Preserve citation placeholders such as (Author, Year) when sources are unavailable.
- Never invent references, statistics, quotations, or findings.
- When evidence is insufficient, explicitly state uncertainty.
- For thesis text, write in a publication-ready academic style.
- For presentation slides, produce short, high-impact bullet points.
- Consider coherence with previous chapters, research questions, hypotheses, and methodology.
- Identify potential ethical, validity, reliability, and sampling concerns.
- When reviewing text, focus on clarity, academic rigor, and argument quality rather than grammar alone.
Pay special attention to research design, literature gaps, conceptual framework, variable relationships, policy implications, and limitations of findings.`;

/** The two editable blobs, as the Settings → Agent tab and chat builder see them. */
export interface AgentPersona {
  personality: string;
  rules: string;
}

/** Absolute path to the agent dir for the current project, or null if none. */
function agentDir(): string | null {
  const p = getCurrentProject();
  return p ? join(p.dissertatorDir, AGENT_DIR_NAME) : null;
}

/** Read a file as utf8, or "" if missing/unreadable (never throws). */
async function readOrEmpty(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Load the current project's personality + rules. Returns empty strings if no
 * project is open OR the files are absent (the tab seeds its textareas from
 * this; the chat builder treats "" as "no override"). Never throws.
 */
export async function getAgentPersona(): Promise<AgentPersona> {
  const dir = agentDir();
  if (!dir) return { personality: "", rules: "" };
  return {
    personality: await readOrEmpty(join(dir, PERSONALITY_FILE)),
    rules: await readOrEmpty(join(dir, RULES_FILE)),
  };
}

/**
 * Overwrite either/both blobs. Only fields present in the patch are written;
 * the other file is left untouched. Creates the `agent/` dir if missing.
 * Returns the fresh full persona (post-write) so the caller can echo it.
 */
export async function saveAgentPersona(
  patch: Partial<AgentPersona>,
): Promise<AgentPersona> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const dir = join(project.dissertatorDir, AGENT_DIR_NAME);
  await mkdir(dir, { recursive: true });
  if (typeof patch.personality === "string") {
    await writeFile(join(dir, PERSONALITY_FILE), patch.personality, "utf8");
  }
  if (typeof patch.rules === "string") {
    await writeFile(join(dir, RULES_FILE), patch.rules, "utf8");
  }
  return getAgentPersona();
}

export async function readPreferences(): Promise<string> {
  const dir = agentDir();
  if (!dir) return "";
  return readOrEmpty(join(dir, PREFERENCES_FILE));
}

export async function appendPreference(text: string): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return;
  const dir = join(project.dissertatorDir, AGENT_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, PREFERENCES_FILE);
  const existing = await readOrEmpty(path);
  const bullet = line.startsWith("- ") ? line : `- ${line}`;
  const next =
    existing + (existing && !existing.endsWith("\n") ? "\n" : "") + bullet + "\n";
  await writeFile(path, next, "utf8");
}

export async function writePreferences(md: string): Promise<void> {
  const project = getCurrentProject();
  if (!project) throw new Error("no project initialized");
  const dir = join(project.dissertatorDir, AGENT_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, PREFERENCES_FILE), md, "utf8");
}

/**
 * Seed the `agent/` dir with default personality + rules on project init.
 * Idempotent — existing files are NEVER overwritten (the user's edits win).
 * Called from `initProject` next to the `prompts.md` seed.
 */
export async function ensureAgentFiles(dissertatorDir: string): Promise<void> {
  const dir = join(dissertatorDir, AGENT_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const persPath = join(dir, PERSONALITY_FILE);
  if (!(await exists(persPath))) {
    await writeFile(persPath, DEFAULT_PERSONALITY_MD, "utf8");
  }
  const rulesPath = join(dir, RULES_FILE);
  if (!(await exists(rulesPath))) {
    await writeFile(rulesPath, DEFAULT_RULES_MD, "utf8");
  }
}
