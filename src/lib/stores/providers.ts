// Provider store — source of truth for provider rows + their API keys.
// Keys live in the sidecar's GLOBAL app DB (shared across every project) so
// background jobs like ingest auto-identify can use them. Owns state + data
// actions; lifecycle (refresh on project open, key reload) lives in useApp.

import { create } from "zustand";
import { api } from "../api";
import type { ProviderRow } from "@dissertator/shared";

interface ProviderState {
  /** Named provider rows (chat + embedding + local specialties). */
  providers: ProviderRow[];
  /** In-memory API-key map, keyed by a provider's `keyUser` slot. Mirrors the
   *  sidecar's global `keys` table; this map is the source of truth for the
   *  running session. */
  keys: Record<string, string>;
  /** True once the first providers+keys fetch completed — gates the startup
   *  onboarding check so it doesn't flash before data is in. */
  loaded: boolean;

  /** Re-read provider rows from the sidecar. */
  refreshProviders: () => Promise<void>;
  /** A key field changed: update the in-memory map, then persist to the
   *  sidecar's global key store. */
  handleKeyChange: (keyUser: string, value: string) => Promise<void>;
  /** Re-read all keys from the sidecar, MERGED over the in-memory map. Merge
   *  (not replace) so an optimistic edit isn't wiped by a transient fetch. */
  loadKeys: () => Promise<void>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  keys: {},
  loaded: false,

  refreshProviders: async () => {
    try {
      set({ providers: await api.listProviders() });
    } catch {
    }
  },

  handleKeyChange: async (keyUser, value) => {
    set((s) => ({ keys: { ...s.keys, [keyUser]: value } }));
    try {
      await api.setKey(keyUser, value);
    } catch (e) {
      console.warn("[settings] key not persisted:", e);
    }
  },

  loadKeys: async () => {
    const { providers } = get();
    if (providers.length === 0) return;
    let fetched: Record<string, string> = {};
    try {
      fetched = await api.listKeys();
    } catch {
    }
    set((s) => {
      const merged = { ...fetched };
      for (const [k, v] of Object.entries(s.keys)) {
        if (v) merged[k] = v;
      }
      return { keys: merged, loaded: true };
    });
  },
}));
