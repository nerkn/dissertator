import { req } from "./_client";

export interface AgentPersona {
  personality: string;
  rules: string;
}

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

export const agentApi = {
  /** Personality + rules from `Dissertator/agent/` ("" per field if absent). */
  getAgentPersona: () => req<AgentPersona>("/agent/persona"),

  /** Overwrite either/both blobs; returns the fresh full persona. */
  saveAgentPersona: (patch: Partial<AgentPersona>) =>
    req<AgentPersona>("/agent/persona", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),

  getPreferences: () => req<{ contents: string }>("/agent/preferences"),

  savePreferences: (contents: string) =>
    req<{ ok: boolean }>("/agent/preferences", {
      method: "PUT",
      body: JSON.stringify({ contents }),
    }),

  consolidatePreferences: (apiKey: string) =>
    req<ConsolidationResult>("/agent/preferences/consolidate", {
      method: "POST",
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      body: JSON.stringify({}),
    }),

  dismissPreferences: (rawHash: string) =>
    req<{ ok: boolean }>("/agent/preferences/dismiss", {
      method: "POST",
      body: JSON.stringify({ rawHash }),
    }),
};
