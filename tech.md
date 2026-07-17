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

## In-app dialogs replace window.prompt/confirm/alert (2026-07-16)

The webview's native prompt/confirm/alert were used at 10 call sites (new
document, list/chat rename+delete, reference delete+detect, image save, link
URL). Replaced with a promise-backed store: `src/lib/stores/dialogs.ts`
exports `promptDialog` / `confirmDialog` / `alertDialog` (FIFO-queued), and
`src/components/SystemDialog.tsx` is the single renderer mounted once in
`App`. Reuses `.overlay/.dialog/.field/.actions` (settings.css) + new
`.dialog-message` (overlays.css). Call sites now `await promptDialog({...})`.
No native dialog calls remain in `src/`.

## Per-project data must reload on project switch (2026-07-16)

Bug: opening a different directory left **chats** and **lists/notes** (Favorites) stale — they showed the previous project's data, while sources/documents refreshed. Root cause: those two are held in **local component `useState`** inside `ChatPanel` and `LibraryPanel/_ListsGroup`, and their load effects didn't depend on project identity — `ChatPanel`'s effect keyed on `configured` (stays `true` across a switch), `ListsGroup`'s on mount-only. Data in the global stores (content: sources/documents, providers) IS re-fetched in `useApp` on `project?.projectPath` change, so those updated.

Fix: subscribe both components to `useSessionStore((s) => s.project?.projectPath ?? null)` and add it to the load-effect deps; `ChatPanel` also resets `activeChatId`/`messages` on switch so stale messages don't flash.

**Same class in the center pane (`useApp` tab-restore):** `CenterPane` renders from the `tabs` store. The tab-restore effect's `uiTabsRestored` ref flipped `true` on the first restore and never reset, so on switch the effect re-ran but short-circuited — the new project's working set never loaded. It also only called `setTabs(restored)` when `restored.length > 0`, so switching to a project with no saved tabs left the OLD project's `ManuscriptEditor` instances mounted in the center. Fix: track `lastProjectPath` in a ref; on change reset the guard + `setTabs([])`/`setActiveTabId(null)`; and always `setTabs(restored)` (even empty). Backend was never wrong — every project has its own `Dissertator/dissertator.db`; the UI just wasn't re-querying it. (Architectural smell: chats/lists/notes not yet in a store — promote them to zustand if more project-lifecycle coupling shows up.)

## Local embedding resource caps (2026-07-16)

`bun run sidecar` was hitting 5.7 GB RSS / 800%+ CPU on "Embed now" with the
local granite adapter. Root cause was NOT multiple model instances — there is
exactly one ONNX session (singleton in `embed/local.ts`) — but two knobs:

- **ONNX threads**: the runtime defaults to one intra-op thread per logical
  core, so a single inference pinned the whole machine. Capped via
  `intraOpNumThreads` to `min(4, availableParallelism())` (+ `interOp=1`,
  `sequential`); override with `DISSERTATOR_ORT_THREADS`. Throughput on a
  384-dim transformer is FLOP-bound, not thread-bound, past ~4 threads.
- **Embed batch size**: `EMBED_BATCH_SIZE` was 64; transformer activations
  scale linearly with batch, so 64×512×384 residency was the RAM blowup.
  On CPU the total compute is fixed regardless of batch — batching only
  amortizes per-call overhead — so dropped to 4 (`ingest/index.ts`). 4 vs 64
  is a ~16x peak-RAM cut for negligible throughput cost.

## Agent-loop failures were silently swallowed (2026-07-16)

When a model round-trip in the agent loop threw (provider error, abort, or
the reasoning-model idle-gap case) the chat UI showed *nothing*: tools ran,
then the reply never appeared and no error surfaced. Two bugs:

1. **Field mismatch.** The `POST /chat` catch emitted the SSE `error` event
   as `{ message }`, but `ChatPanel` checked `result.error` → always
   falsy → error banner never set. Fixed by normalizing in `streamChat`
   (fall back from `.error` to `.message`).
2. **No failure trail in `agent.log`.** Only the success path wrote the
   `[turn done]` summary; the catch returned early, so a throw left the log
   ending mid-run with no `[turn done]` and no clue why. The catch now
   appends a `[turn FAILED]` line with the error message + abort flag.

Next time a turn dies, `tail` the log to see the actual provider/abort error
instead of an empty reply.

## Agent visibility: 30s watchdog + persistent tool narration (2026-07-16)

Two gaps behind "the agent ran a tool then I saw nothing":

1. **No per-step timeout.** Neither the client `fetch` nor the backend
   provider `fetch` had any timeout (only the SSE socket `idleTimeout: 255`
   and the user Stop button). A stalled provider hung forever or died
   mysteriously. Added a **no-activity watchdog** in `runAgentLoop`
   (`stepTimeoutMs`, default 30s, env `CHAT_STEP_TIMEOUT_MS`): it resets on
   every token, so a slow-but-streaming reasoning model is never cut; only a
   connection that emits nothing for 30s trips it → abort + throw a clear
   "model step timed out" (which now logs `[turn FAILED]` + surfaces in chat).
2. **Tool narration vanished.** `toolBeats` was ephemeral (cleared at end of
   turn). The `chat_messages.tool_calls` JSON column already existed but was
   never written. Now the route mirrors every tool_call/tool_result into a
   `toolTrace`, persists it onto the assistant message (success AND error
   paths — so even a turn that died mid-synthesis keeps its tool beats), and
   `MessageBubble` renders them. Migration adds `tool_calls` via ALTER on DBs
   that predate the column.

## Embedding: background full-corpus drain + ONNX idle-unload (2026-07-16)

The old `POST /embed` was a *single bounded page*: `embedPending` pulled ≤500
pending chunks, embedded them, and returned. With 5k+ chunks that meant
dozens of manual clicks, and the button was "done" after each 500. Redesigned
to **auto-drain the entire backlog in the background**:

- **`processEmbedPage`** (`ingest/index.ts`) — extracted from the old
  `embedPending` body. Embeds ≤500 chunks in sub-batches of 4, sleeping
  **`EMBED_INTER_BATCH_DELAY_MS` (default 2000ms)** between batches so the
  local transformer doesn't pin every core for the whole run and GC can
  reclaim. Returns `{embedded, failed, drained, fatal}`.
- **`embedPending`** — kept as a thin one-page programmatic entrypoint.
- **`embedAll`** — guarded by a module-level `drainRunning` flag, loops
  `processEmbedPage` until `pending=0`. **Fire-and-forget**: `POST /embed`
  kicks it off and returns `{started, running}` immediately — a full drain
  runs for tens of minutes, so blocking the HTTP request would hit the
  socket `idleTimeout: 255s` and die. Progress is observable via the existing
  5s poll: `GET /embed/status` now merges `running: isEmbedDraining()`.
- **Fatal abort**: a dimension-mismatch (permanent lock conflict) breaks the
  drain; per-batch adapter errors are logged + skipped (chunks → `failed`).

**ONNX idle-unload** (`embed/local.ts`): the int8 granite session holds
~90 MB resident for the process lifetime once loaded. Search reuses the same
session, so a hard unload after bulk-embed would cold-reload ~94 MB on the
next query. Instead: `rearmIdleTimer()` is called on *every* local embed
(bulk + search); if nothing touches the session for
**`DISSERTATOR_ORT_IDLE_MS` (default 5 min)**, `unloadLocalEmbed()` releases
the native handle (next use reloads lazily). The drain's `finally` hints an
immediate re-arm via `scheduleLocalEmbedIdleUnload()`. `0` disables.

**Frontend** (`_SourcesGroup.tsx`): button now shows **"digesting…"** while
`embed.running` (poll) or the optimistic `embedStarting` flag (covers the
≤5s gap until the poll catches up) is true. No more per-click result; the
one-line progress summary reflects live `pending`/`done`.

Env knobs: `DISSERTATOR_EMBED_BATCH_DELAY_MS` (inter-batch sleep, 0 disables),
`DISSERTATOR_ORT_IDLE_MS` (session idle-unload, 0 disables).

## Layered reference detection (2026-07-17)

`POST /sources/:id/detect-reference` was DOI-scan-only, so anything without a
resolvable DOI (books, preprints, scans, DOCX, transcripts) kept a placeholder
reference — citekey from filename, no authors/year/title. Rewrote it as a
**layered pipeline** (cheapest / most authoritative first; LLM only as the
catch-all), in `sidecar/src/routes/sources.ts`:

1. **DOI scan → Crossref** (existing) — canonical CSL JSON when the source has
   its own DOI.
2. **PDF `/info` metadata** (`sidecar/src/cite/pdfmeta.ts`, via `unpdf.getMeta`)
   — free + deterministic. Captures Title/Author/CreationDate that most
   born-digital academic PDFs (arXiv, journals) embed. Authors are
   semicolon/comma-split heuristically; tooling artifacts ("Microsoft Word",
   "Adobe Acrobat") are filtered.
3. **LLM extract** (`sidecar/src/cite/llmExtract.ts`) — title page (~3k chars)
   → strict JSON via the streaming chat adapter. Catch-all for the long tail.
   Gated on the chat binding + a Bearer key (header-only, never persisted);
   absent key ⇒ stage skipped silently.

First stage yielding a title or authors wins; later stages are skipped, so a
self-describing PDF never spends an LLM call.

**Placeholder enrichment:** a linked reference is now treated as "done" only
if it has authors OR a doi — otherwise it is a placeholder and is enriched
**in place** (its id pins the upsert; citekey stays frozen per DESIGN §8 #9).
Previously any linked ref short-circuited detection, so re-running detect-all
skipped exactly the rows that needed filling. `ReferencesView.detectAll` now
targets `sources whose ref is missing OR a placeholder`, passes the chat key,
and reports per-stage counts (`filled N of M (k doi, j pdf-meta, l llm)`).

Gotcha: `unpdf.getMeta` rejects Node `Buffer` ("provide binary data as
`Uint8Array`") even though Buffer subclasses Uint8Array — `extractPdfMetadata`
normalizes via `new Uint8Array(data)` so callers can pass Buffer/ArrayBuffer/
Uint8Array interchangeably.

API: `detectReference(id, chatKey?)` return gained a `source` field
(`"doi" | "pdf-meta" | "llm" | "none"`).

### Wrong-DOI guard (Option 3) — same day

The DOI stage scanned the **whole** text and accepted the first resolvable DOI.
When a source's own DOI is **absent** (books, preprints, scans, chapters), the
first resolvable candidate came from the **bibliography** (page 2+) → the cited
work's title/authors got saved as this source's reference, citekey frozen, and
the new "has authors OR doi" complete-check then locked it in forever (re-run
skipped it). Silent, sticky, wrong.

Fix = two guards (the user's "Option 3"):

- **Scope** (`firstPageRegion` in `cite/doi.ts`): DOI candidates are drawn only
  from the title-page region — text before the first `[p.2]` marker (the format
  `getSourceText` emits), or the first 2500 chars when a source has no page
  markers (DOCX/transcripts). A bibliography DOI on page 2 is never considered.
- **Verify** (`cite/titleMatch.ts`): PDF /info metadata now runs FIRST (it's
  free) and its title is used as an anchor; a Crossref hit is accepted only if
  `titlesMatch(ref.title, anchor)` (substring either way, or Jaccard ≥ 0.6
  after lowercasing + stripping punctuation). So even a stray cited DOI on page
  1 (e.g. in an abstract) is rejected when we have a trusted title.

Pipeline order is now 0 PDF-meta (anchor) → 1 DOI (scoped+verified) → 2 PDF-meta
(hit) → 3 LLM. The PDF-meta read is done once and reused as both anchor and
fallback. Cover-page PDFs (own DOI on page 2, not page 1) lose the DOI stage
but fall through to PDF-meta / LLM, which still recover the right metadata —
graceful, not a regression.

Added `cite/titleMatch.ts`; `firstPageRegion` exported from `cite/doi.ts`.
