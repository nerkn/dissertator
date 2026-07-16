# Tech Decisions

## State management: Zustand stores (2026-07-16)

App state was split out of the monolithic `useApp` hook into Zustand stores:

- `src/lib/stores/session.ts` — health, project, error, busy, showSettings
- `src/lib/stores/providers.ts` — provider rows + API keys
- `src/lib/stores/tabs.ts` — working-set tab model
- `src/lib/stores/content.ts` — settings, sources, documents, doc revisions
- `src/lib/stores/models.ts` — cached/deduped per-provider model lists

**Pattern:** a store owns data + pure actions; `useApp` is the orchestrator
(lifecycle effects + composition handlers + derived keys); leaf components
read the store directly instead of receiving props drilled through
`App/index.tsx`. Refresh logic that needs cross-domain guards (project gate
+ `setError`) stays in `useApp` and calls store setters.

`useApp` shrank 684 → 489 lines. Dependency added: `zustand@5`.

## Bug-fix sweep (2026-07-16)

- **Selector snapshots must return stable refs.** Inline `?? []` in a zustand
  selector mints a new array per read → `useSyncExternalStore` infinite loop.
  `useSourceItems()` uses a module-level `EMPTY_SOURCES` constant fallback.
- **Partial-update spread clobbers siblings.** `handleDocumentEdited` merges
  `{...d, ...doc}`; ChatPanel's agent-edit handler must preserve the existing
  doc's structural fields (docType/thesis/RQ/focusPrompt/createdAt) since the
  `EditEvent` only carries title/bodyMd. Reads via `useContentStore.getState()`.
- **No side effects in setState updaters.** React 18 StrictMode double-invokes
  them in dev → duplicate work (e.g. a second chat created on delete). Compute
  derived state outside the updater.
- **Path inputs need allowlists.** `POST /assets/import`'s `dest` is joined into
  a filesystem path, so it's allowlisted to `images|audio|root` server-side
  (the TS union isn't enforced across JSON).
