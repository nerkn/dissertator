// Provider store — source of truth for provider rows + their API keys.
// Owns state + data actions; lifecycle (refresh on project open, keychain
// re-read) lives in useApp. Derived per-function keys (keyFor) stay in useApp.

import { create } from "zustand";
import { api } from "../api";
import { ipc } from "../../ipc";
import type { ProviderRow } from "@dissertator/shared";

interface ProviderState {
  /** Named provider rows (chat + embedding + local specialties). */
  providers: ProviderRow[];
  /** In-memory API-key map, keyed by a provider's `keyUser` slot. Loaded
   *  from the OS keychain on startup; the Settings dialog writes here. This
   *  map is the source of truth for the running session. */
  keys: Record<string, string>;

  /** Re-read provider rows from the sidecar. No project guard — the
   *  orchestrator decides when to call this. */
  refreshProviders: () => Promise<void>;
  /** A key field changed: update the in-memory map, then best-effort persist
   *  to the OS keychain (a missing daemon must not break the session). */
  handleKeyChange: (keyUser: string, value: string) => Promise<void>;
  /** Re-read all keys from the OS keychain, MERGED over the in-memory map.
   *  Merge (not replace) because the keychain may be unavailable on some
   *  platforms, so a blind re-read would wipe optimistic edits. */
  loadKeysFromKeychain: () => Promise<void>;
}

export const useProviderStore = create<ProviderState>((set, get) => ({
  providers: [],
  keys: {},

  refreshProviders: async () => {
    try {
      set({ providers: await api.listProviders() });
    } catch {
      /* sidecar mid-restart */
    }
  },

  handleKeyChange: async (keyUser, value) => {
    set((s) => ({ keys: { ...s.keys, [keyUser]: value } }));
    try {
      if (value) await ipc.setSecret(keyUser, value);
      else await ipc.deleteSecret(keyUser);
    } catch (e) {
      console.warn("[settings] key not persisted:", e);
    }
  },

  loadKeysFromKeychain: async () => {
    const { providers } = get();
    if (providers.length === 0) return;
    const fetched: Record<string, string> = {};
    await Promise.all(
      providers.map(async (p) => {
        try {
          fetched[p.keyUser] = (await ipc.getSecret(p.keyUser)) ?? "";
        } catch {
          fetched[p.keyUser] = "";
        }
      }),
    );
    // Merge, don't replace: keep any non-empty in-memory value; fill the rest
    // from the keychain. (See file header.)
    set((s) => {
      const merged = { ...fetched };
      for (const [k, v] of Object.entries(s.keys)) {
        if (v) merged[k] = v;
      }
      return { keys: merged };
    });
  },
}));
