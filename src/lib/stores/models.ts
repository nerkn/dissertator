// Model store — a shared, cached, deduped view of each provider's /models list.
//
// The Functions tab renders one row per function, several often on the SAME
// provider. Local state would refetch per row on every switch; this store
// adds three things it can't:
//   1. TTL cache       — A→B→A doesn't refetch A the second time.
//   2. Cross-row dedup — five rows on one provider = one call.
//   3. In-flight dedup — two rows mounting share one promise.
//
// A derived cache: it owns no provider/key state (useApp does).

import { useEffect } from "react";
import { create } from "zustand";
import { api } from "../api";

/** How long a cached model list is considered fresh. */
const TTL_MS = 60_000;

interface CacheEntry {
  models: string[];
  fetchedAt: number;
  error?: string;
}

interface ModelState {
  cache: Record<string, CacheEntry>;
  /** Reactive per-provider loading flags (drives the "loading…" indicator). */
  loading: Record<string, boolean>;
  /** Fetch (or serve cached) models for a provider. Keyed by provider id —
   *  model lists are provider-scoped, not key-scoped in practice. */
  getModels: (providerId: string, key: string) => Promise<string[]>;
  /** Drop a provider's cached entry (e.g. after its key changes). */
  invalidate: (providerId: string) => void;
}

/** In-flight requests keyed by provider id, so concurrent callers share one
 *  fetch. Lives outside the store to avoid re-renders on assignment. */
const inflight = new Map<string, Promise<string[]>>();

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
  return !!entry && Date.now() - entry.fetchedAt < TTL_MS && !entry.error;
}

export const useModelStore = create<ModelState>((set, get) => ({
  cache: {},
  loading: {},

  getModels: async (providerId, key) => {
    const hit = get().cache[providerId];
    if (isFresh(hit)) return hit.models; // TTL cache
    const existing = inflight.get(providerId);
    if (existing) return existing; // in-flight dedup

    set((s) => ({ loading: { ...s.loading, [providerId]: true } }));

    const p = api
      .getProviderModels(providerId, key)
      .then((r) => {
        set((s) => ({
          cache: {
            ...s.cache,
            [providerId]: { models: r.models, fetchedAt: Date.now() },
          },
        }));
        return r.models;
      })
      .catch((e) => {
        const error = (e as Error)?.message ?? String(e);
        set((s) => ({
          cache: {
            ...s.cache,
            [providerId]: { models: [], fetchedAt: 0, error },
          },
        }));
        return [];
      })
      .finally(() => {
        inflight.delete(providerId);
        set((s) => {
          if (!s.loading[providerId]) return s;
          const next = { ...s.loading };
          delete next[providerId];
          return { loading: next };
        });
      });

    inflight.set(providerId, p);
    return p;
  },

  invalidate: (providerId) =>
    set((s) => {
      if (!(providerId in s.cache)) return s;
      const next = { ...s.cache };
      delete next[providerId];
      return { cache: next };
    }),
}));

/**
 * Selector hook: subscribe to a provider's model list and fetch it when the
 * provider/key changes. `enabled=false` skips fetching entirely (use for
 * keyless providers, which have no `/models` endpoint). Returns
 * `{ models, loading, error }` for the row to render.
 */
export function useModels(
  providerId: string | undefined,
  key: string,
  enabled = true,
): { models: string[]; loading: boolean; error?: string } {
  const active = !!providerId && enabled;
  const entry = useModelStore((s) =>
    active ? s.cache[providerId!] : undefined,
  );
  const loading = useModelStore((s) => !!(active && s.loading[providerId!]));

  useEffect(() => {
    if (!active || !providerId) return;
    void useModelStore.getState().getModels(providerId, key);
  }, [providerId, key, active]);

  return {
    models: entry?.models ?? [],
    loading,
    error: entry?.error,
  };
}
