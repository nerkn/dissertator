# Agent Tools — Reference

The **tool contract** for the P5 writing agent. This is the authoritative spec:
P5 implementation should make every tool below match its signature, return
shape, and error behavior exactly. The design rationale lives in
`DESIGN.md` §10 + §11 (decisions 16-18); this document is the operational
reference (full signatures, types, examples, edge cases).

> **Status legend** (per tool, in the *Impl* row):
> - ✅ backend exists, tool wrapper is P5 glue
> - 🟡 backend partial — needs completion in P5
> - ⬜ greenfield — build in P5 (or P4 for manuscript tables)

---

## 1. Naming convention

All tools are **`{domain}_{verb}`** with four fixed domains. The LLM never has
to guess what kind of object an id refers to — the domain tells it.

| Domain | Operates on | Mutability | Backed by |
|---|---|---|---|
| `corpus_` | the **index** (references: title/author/year + vectors) | read + write metadata | `references`, `chunks` |
| `doc_` | **source bundles** (research PDFs/DOCX/etc.) | **read-only** | `source_files`, `chunks` |
| `p_` | the **paper / manuscript** (the thesis) | **read-write** | `documents` (`body_md`) |
| `gui_` | **user-facing side-effects** (viewer, prompts, narration) | n/a | Tauri IPC to frontend |

**Why the split** (DESIGN §10): a source bundle is read-only (you don't edit a
PDF); the manuscript is read-write. Separate namespaces (`doc_` vs `p_`)
prevent the LLM from calling `p_write` on a source and getting a confusing
runtime rejection. `gui_` cleanly separates user-visible side-effects from
silent data ops — so the LLM (and the user reviewing a transcript) can tell at
a glance which calls changed what the human sees.

---

## 2. `corpus_*` — the index

The corpus is the **bibliographic index**: references with metadata (title,
author, year, DOI) plus their chunk-level vectors. Source files are linked to
references as **bundles** (DESIGN §11 #17: `references`+`chunks` IS the index;
`source_files` are linked read-only bundles).

### `corpus_list`

> Query the index. Returns **ids + short info only** — call `doc_read` for full
> content. Max 20 hits per call (paginate with `page`).

```ts
corpus_list(opts?: {
  text?:   string,            // substring match on chunk text (SQL LIKE)
  author?: string,            // substring on author family/given
  title?:  string,            // substring on reference title
  vector?: string,            // semantic query — embedded server-side, KNN over chunks
  page?:   number,            // result page (0-based); default 0
}): Promise<{
  hits: Array<{
    referenceId: string,
    citekey:     string,      // frozen; safe to embed in [@citekey:page] tokens
    title:       string | null,
    authors:     Author[],    // [{family, given}]
    year:        number | null,
    sourceFileId: string | null,  // null = fileless reference
    score?:      number,      // [0,1] cosine sim — present only when `vector` used
  }>,
  total: number,
  page:  number,
}>
```

**Behavior**
- All filters are **AND**. All string filters are substring (case-insensitive).
- `vector` triggers a `searchCorpus`-style KNN; results are the **distinct
  references** owning the top chunks, ranked by best chunk score. *(Open: tie-break
  and de-dup rule — see §7.)*
- Without `vector`, ordering is stable (citekey asc).
- `total` reflects the unpaginated count.

**Errors**: never throws on empty → returns `{hits:[], total:0, page:0}`.

**Example**
```ts
// "What has Smith written about urban crime?"
await corpus_list({ author: "smith", vector: "urban crime decline" })
// → { hits: [{ referenceId:"r1", citekey:"smith2020", title:"Crime and the City",
//              authors:[{family:"Smith",given:"Jane"}], year:2020,
//              sourceFileId:"sf_1", score:0.78 }], total:1, page:0 }
```

*Impl: 🟡 — substring filters + reference-level rollup need building on top of
the existing `searchCorpus` (which returns chunks, not references).*

---

### `corpus_write`

> Update reference metadata. **Citekey is never writable here** (frozen after
> first assignment — DESIGN §11 #9).

```ts
corpus_write(id: string, patch: {
  title?:  string | null,
  authors?: Author[] | null,   // replaces whole author list
  year?:   number | null,
  doi?:    string | null,
  type?:   string | null,      // CSL type
  venue?:  string | null,
}): Promise<Reference>         // the full updated record
```

**Behavior**
- Partial patch — only supplied fields change.
- Passing `null` **clears** a field; omitting it **preserves** it.
- **Citekey is immutable**: even if a `citekey` key appeared in `patch`, it is
  silently ignored (matches `upsertReference` freeze semantics, verified live).
- DOI updates do **not** auto-fetch CSL — call `corpus_write` again or use a
  future resolve-doi flow.

**Errors**: `404` if `id` unknown.

**Example**
```ts
await corpus_write("r1", { year: 2021, venue: "Annual Review of Sociology" })
```

*Impl: ✅ — maps directly to `db.upsertReference` (P2 Track 3).*

---

## 3. `doc_*` — source bundles (read-only)

Research material: PDFs, DOCX, etc. **Read-only** — the agent never mutates a
source. To read deeply, call `doc_read`; to show the user, call `gui_doc_open`.

### `doc_read`

> Read a source bundle's content. **Silent** (no UI change). Addressed by page
> (PDFs/scanned) or line range (born-digital text).

```ts
doc_read(id: string, loc?: {
  page?:  number,              // 1-based physical page (PDF/image)
  lines?: [number, number],    // [start, end] inclusive, 1-based
}): Promise<{
  sourceFileId: string,
  filename:     string,
  kind:         "pdf" | "docx" | "xlsx" | "csv" | "md" | "txt" | "image" | "other",
  page?:        number,        // echoed when loc.page used
  text:         string,        // the requested slice (page text or line range)
  physicalPage: number | null, // for the viewer
  printedPage:  string | null, // human-label page (may differ from physical)
  totalPages?:  number,        // when known
}>
```

**Behavior**
- `loc` omitted → returns the whole extracted text (may be large; prefer slicing).
- `page` out of range → `text: ""` with `totalPages` echoed (no throw).
- Page numbers are **physical** (the Nth page in the file); `printedPage` is the
  human label and is what `[@citekey:printedPage]` tokens store (re-chunk-safe).

**Errors**: `404` if `id` unknown.

**Example**
```ts
await doc_read("sf_1", { page: 42 })
// → { sourceFileId:"sf_1", filename:"smith2020.pdf", kind:"pdf", page:42,
//     text:"...page 42 body text...", physicalPage:42, printedPage:"38",
//     totalPages:210 }
```

*Impl: 🟡 — chunks table has the text per `(source_file_id, physical_page)`; a
small `readSourceSlice()` helper assembles page/line output. Needs building in P5
(~40 lines over existing `chunks` queries).*

---

## 4. `p_*` — the manuscript (read-write)

The thesis being written. A manuscript is **one body**: the `documents.body_md`
column holds a single markdown blob (DESIGN §3 — no `sections` table; headers
are just markdown lines). All `p_*` tools address that blob **content-first**,
never by line number or section id: the agent names the text it is editing
(`oldtext` / `anchor`) and the server locates it. This is robust to the user
re-typing above the edit (line numbers would drift; matched text does not).

`id` is a document id. When omitted, the tools fall back to the run's
**active document** (the doc the user has open in the editor, surfaced to the
loop as `ToolContext.activeDocumentId` from the `POST /chat` body's
`activeDocumentId`).

### `p_read`

> Read a manuscript body.

```ts
p_read(id?: string): Promise<{
  id:       string,
  title:    string,
  bodyMd:   string,        // the full markdown body
}>
```

**Errors**: `404` if `id` unknown (or no active document when `id` omitted).

*Impl: ✅ — `documents` table.*

---

### `p_create`

> Create a new manuscript document with an initial body. Used by the
> new-document-via-chat flow (the agent drafts the first scaffold).

```ts
p_create(title: string, text?: string): Promise<{
  id:       string,
  title:    string,
  bodyMd:   string,
}>
```

**Behavior**: inserts a `documents` row; `text` defaults to `""`. Emits a
live `edit` SSE event so the frontend can open/refresh the new doc.

*Impl: ✅ — `documents` table.*

---

### `p_write`

> Replace the first occurrence of `oldtext` in the body with `text`.
> **`oldtext` is the optimistic-concurrency check** (DESIGN §11 #18) — made
> explicit and concrete, not magic.

```ts
p_write(id: string, {
  oldtext: string,   // what the agent believes is currently in the body
  text:    string,   // the replacement (may contain [@citekey:page] tokens)
}): Promise<{ ok: true, id: string, bodyMd: string } | { ok: false, error: string }>
```

**Behavior**
- The server finds the **first** occurrence of `oldtext` in `body_md`. If
  found → replace it, persist, emit a live `edit` event, return the new body.
  If not found → `ok:false` with an `error` like `"oldtext not found"` (the
  body changed under the agent — it should `p_read` and retry).
- This is the **only** conflict mechanism: no read-only locking, no blocking
  (DESIGN §10). If the user edits while the agent thinks, the agent's
  `oldtext` won't match and the call fails harmlessly.
- `accept_all` mode (the only mode for now): accepted writes commit
  immediately. `confirm_edits` is deferred.

**Errors**: `404` (id unknown) is an error; `ok:false` (oldtext absent) is
  **not** — it's a normal control-flow signal.

**Example**
```ts
const r = await p_write("doc_3", {
  oldtext: "Crime rose in 2020.",
  text: "Crime rose 12% in 2020 [@smith2020:42].",
})
if (!r.ok) {
  // body changed mid-thought — re-read and retry, or ask the user
  await gui_options([{ short:"Retry", prompt:"The text changed; retry the edit?" }])
}
```

*Impl: ✅ — `documents.body_md`; first-occurrence replace.*

---

### `p_insert`

> Insert `text` immediately **after** the first occurrence of `anchor`.
> Does not replace existing text.

```ts
p_insert(id: string, {
  anchor: string,   // insert AFTER the first match; "" → prepend at top
  text:  string,    // may contain [@citekey:page] tokens
}): Promise<{ ok: true, id: string, bodyMd: string } | { ok: false, error: string }>
```

**Behavior**
- `anchor: ""` (empty) → **prepend** `text` to the top of the body.
- Non-empty `anchor` → find its first occurrence; insert `text` right after
  it. If `anchor` is absent → `ok:false` (`"anchor not found"`); the agent
  re-reads and retries (or uses a different anchor / `p_write`).
- Emits a live `edit` event on success.

*Impl: ✅ — `documents.body_md`; first-occurrence anchor.*

---

## 5. `gui_*` — user-facing side-effects

Calls that change what the **user** sees. Always prefixed `gui_` so a
transcript reader (human or LLM) can spot side-effects at a glance. These are
the only tools that round-trip through Tauri IPC to the frontend.

### `gui_doc_open`

> Open a source bundle in the user's pdf.js / text viewer (jumping to a page).

```ts
gui_doc_open(id: string, page?: number): Promise<{ opened: true }>
```

*Impl: ⬜ — P3c builds the viewer; P5 wires the IPC.*

---

### `gui_p_open`

> Open / focus the manuscript editor on a document.

```ts
gui_p_open(documentId: string): Promise<{ opened: true }>
``````

*Impl: ⬜ — P3a editor + P5 IPC.*

---

### `gui_options`

> Ask the user to pick from **structured choices** (click, don't type).
> Blocks the agent until the user responds.

```ts
gui_options(options: Array<{
  short:  string,              // button label (≤ ~24 chars)
  prompt: string,              // fuller explanation shown on hover / below
}>): Promise<{ chosen: number }>   // index into options; -1 if dismissed
```

**Behavior**
- Always provides ≥1 option; caller should include a sensible default
  (e.g. `[{short:"Approve", prompt:"..."}, {short:"Edit manually", prompt:"..."}]`).
- User dismissal → `chosen: -1` (agent should treat as "stop and wait").
- This **replaces** the old free-text `ask_user` — see §7 for whether a
  free-text variant is also needed.

*Impl: ⬜ — P5.*

---

### `gui_action`

> Non-blocking **narration beat** — the agent signals progress without
> stopping. Renders as a toast / status line in the UI.

```ts
gui_action(
  kind: "warn" | "celebrate" | "info",
  text: string,
): Promise<{ shown: true }>
```

**Behavior**
- `warn` — yellow (e.g. "Couldn't find a source for this claim; proceeding
  uncited").
- `celebrate` — green (e.g. "Drafted the methods section — 3 citations added").
- `info` — neutral (e.g. "Embedding query…").
- Never blocks; the agent continues immediately.

*Impl: ⬜ — P5.*

---

## 6. Cross-cutting behavior

### Modes (per agent run)
- **`accept_all`** (default) — writes commit immediately.
- **`confirm_edits`** — every `p_write`/`p_insert` stages for user approval
  before commit; the agent may also call `gui_options` proactively.

### Conflict handling (optimistic, no locking)
If the user edits the body while the agent is thinking, the agent's
`p_write`/`p_insert` won't find its `oldtext`/`anchor` → the call returns
`ok:false` with an error. The agent re-reads (`p_read`) and retries, or
escalates via `gui_options`. **No read-only locking, no blocking** (DESIGN §10).

### Cost control
Every run has a **step budget**; tokens are tracked per message
(`chat_messages.cost_tokens`, `agent_runs.spent`/`budget`). The loop halts when
the budget is exhausted; the agent is informed so it can wrap up cleanly.

### Citation tokens
`p_write`/`p_insert` text may contain `[@citekey:printedPage]` tokens
(DESIGN §11 #8). The **printed** page is stored (human-meaningful,
re-chunk-safe); the chunk DB row holds both `physical_page` (for the viewer)
and `printed_page` (for the token). Citekeys are frozen (DESIGN §11 #9) so
tokens never dangle.

---

## 7. Decisions resolved in P5

These were open in the spec; the P5 implementation settled them as follows.

1. **`corpus_list({query})` chunk→reference rollup.** Vectors live on chunks;
   references own many chunks. **Resolved: one row per reference, de-duped by
   reference id**, ranked by best-chunk order (the KNN hits drive ordering;
   each reference appears once). Non-query (`author`/`title`) calls filter
   `listReferences()` directly.

2. **`corpus_list` result paging.** Dropped — a hard `limit` (≤20) is enough
   for an agent turn. No offset/page param.

3. **Free-text ask.** Not added. `gui_options` covers multiple-choice; open
   questions are just asked in the assistant's streamed text and the user
   replies normally. Revisit if a use case needs a dedicated `gui_ask`.

4. **`p_write` equality.** **Byte-exact substring match** (`String.indexOf`).
   The model is told to `p_read` and copy verbatim. No whitespace
   normalization in v1 (keeps the check predictable; revisit if it bites).

5. **`p_insert` conflict granularity.** **Anchor-based**, not line-based: the
   agent names an `anchor` string and text is inserted after its first
   occurrence. Empty anchor prepends at top. No line counting at all — the
   line-count drift problem is gone by construction.

6. **`gui_options` model.** **No pause, no callback.** Options render as
   quick-reply chips after the turn; clicking one sends its `prompt` as a new
   user message. The stream does not block waiting for a choice.

7. **Modes.** **`accept_all` only** in v1. `confirm_edits` (stage writes for
   human approval) is deferred — the live-reload editor + stale banner cover
   the immediate UX.

6. **Streaming.** `p_write`/`p_insert` return when committed; but the agent
   should also **stream** partial text so the user sees live typing. Is that a
   tool concern or a transport concern? *Lean: transport (SSE), separate from
   the tool contract — tools stay request/response.*

---

## 8. Where each tool maps in the codebase

| Tool | Backend (sidecar) | Status |
|---|---|---|
| `corpus_list` | `search.ts` (KNN) + reference-rollup query over `references`/`chunks` | ✅ |
| `corpus_write` | `db.ts:upsertReference` (+ routes in `index.ts`) | ✅ |
| `doc_read` | `chunks` table + `readSourceSlice()` helper | ✅ |
| `p_read` / `p_write` / `p_insert` / `p_create` | `documents.body_md`; content-addressed (oldtext/anchor) | ✅ |
| `gui_doc_open` / `gui_p_open` | SSE `gui` event → frontend opens tab | ✅ |
| `gui_options` / `gui_action` | SSE `gui` event → frontend chips / toasts | ✅ |

**Implementation**: the agent loop lives in `sidecar/src/agent/loop.ts`
(`runAgentLoop`, iterate-until-text, step-capped); tool dispatch in
`sidecar/src/agent/tools.ts` (`TOOL_SPECS` + `dispatchTool`); the SSE relay
fans `delta`/`tool_call`/`tool_result`/`edit`/`gui`/`done` events from
`POST /chat` (`sidecar/src/index.ts`). A manuscript is one `body_md` blob —
no `sections` table (removed; headers are markdown lines).
