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
