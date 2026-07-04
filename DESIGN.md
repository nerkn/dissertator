# Dissertator — Design Document

> A cross-platform desktop **writing + research** tool. Open a folder → scan, OCR,
> vectorize (RAG) into a workspace. Ask grounded questions with source links;
> write dissertations and papers there, guided by an LLM agent that can read the
> corpus and edit your documents. The user leads; the agent assists.

**Status:** architecture agreed. Implementation not started.
**Last updated:** 2026-07-03

---

## 1. Vision & Use Case

A social researcher has ~100 documents (PDFs, DOCX, XLSX, CSV, MD, TXT, images).
They want to write a paper or dissertation grounded in that material.

Dissertator is **not a one-shot pipeline**. It is a living writing tool:

- **Index** the folder once, then keep it in sync (living folder).
- **Ask** the corpus grounded questions; every answer cites `[doc, page]`.
- **Author** multiple focused documents from the same shared corpus
  (e.g. a crime-rates thesis *and* a drug-use paper from the same 100 files).
- The LLM agent has tools — it reads the corpus, retrieves, edits the document.
  The user approves (or runs in accept-all autopilot).

**Guiding principles**

- The user leads. Outputs are user-directed, not autopilot dumps.
- Every generated claim must trace to a source. Hallucinated citations = unusable.
- Portable: everything lives inside the opened folder, under a visible
  `Dissertator/` directory. Move the folder, move the project.

---

## 2. Core Concepts

| Concept | Meaning |
|---|---|
| **Project** | One opened folder. Owns a `Dissertator/` workspace + SQLite DB. |
| **Corpus** | All indexed source files in the project. Shared across documents. |
| **SourceFile** | An ingested file (pdf, docx, xlsx...) with extracted text, chunks, vectors. |
| **Reference** | A bibliographic record (APA entry). May or may not have a backing SourceFile. |
| **Document** | A focused work product (paper / dissertation). Born from a **wizard**. Many per project. |
| **Section** | A node in a document's editable outline tree (heading + body). |
| **Citation token** | Inline marker `[@citekey:printedPage]` binding a claim to evidence. |
| **Wizard** | LLM-led interview that produces a document's shape (thesis, RQs, outline, focus). |
| **Agent run** | A tool-using LLM session editing a document, under a mode + budget. |

**Topology:** `1 Project → N Documents ← 1 shared Corpus`. No hard corpus
scoping; the agent retrieves whatever is relevant per request (soft scoping by
thesis/focus prompt hint).

---

## 3. Data Model

SQLite database at `Dissertator/dissertator.db`. Vectors via the `sqlite-vec`
extension (same file, portable).

### `source_files`
```
id            TEXT PK
rel_path      TEXT        -- relative to project root; original referenced in place
filename      TEXT
ext           TEXT
kind          TEXT        -- pdf | docx | xlsx | csv | md | txt | image | other
content_hash  TEXT        -- sha256, for dedup
file_size     INTEGER
mtime         INTEGER
text_status   TEXT        -- new|extracting|done|needs_ocr|ocr_tesseract|
                           --   pending_vision|failed
ocr_method    TEXT        -- null | direct | tesseract | vision_api
error         TEXT
reference_id  TEXT        -- FK references.id (nullable until citekey resolved)
added_at      INTEGER
```

### `chunks`
```
id             TEXT PK
source_file_id TEXT FK
ord            INTEGER    -- order within source
physical_page  INTEGER    -- 0-indexed PDF page (always known, never changes)
printed_page   TEXT       -- what's printed on the page ("12", "iv", null)
text           TEXT
token_count    INTEGER
```
**Page model — two distinct numbers, stored separately:**
- *physical_page* — from extraction; drives the PDF viewer's jump-to-page.
- *printed_page* — parsed from the page; what appears in APA citations.

### `embeddings` (sqlite-vec virtual table)
```
chunk_id   TEXT
model_id   TEXT          -- enables re-index on model switch
vec        FLOAT[N]      -- sqlite-vec virtual column
```
**Granularity:** chunk-level only for v1 (the load-bearing one — returns real
evidence text + page for citation). Doc-level topic vectors deferred.

### `references`
```
id             TEXT PK
citekey        TEXT UNIQUE  -- frozen after first assignment; never regenerated
title          TEXT
authors        JSON         -- [{family, given}]
year           INTEGER
doi            TEXT
type           TEXT         -- article-journal | book | chapter | ...
venue          TEXT
csl_json       JSON         -- full CSL record for citeproc
source_file_id TEXT         -- nullable: fileless refs allowed
```

### `documents`
```
id                  TEXT PK
title               TEXT
doc_type            TEXT     -- paper | thesis | lit_review | chapters | free
thesis              TEXT
research_questions  JSON
focus_prompt        TEXT     -- soft scoping hint that steers retrieval
created_at          INTEGER
```

### `sections`
```
id           TEXT PK
document_id  TEXT FK
parent_id    TEXT            -- outline tree
ord          INTEGER
level        INTEGER         -- 1=h1
heading      TEXT
body_md      TEXT            -- markdown body; holds citation tokens
```

### `chat_messages`
```
id            TEXT PK
role          TEXT           -- user | assistant | tool
content       TEXT
tool_calls    JSON
open_files    JSON           -- injected context: which files were open
cost_tokens   INTEGER
created_at    INTEGER
```
**Global thread** — one chat per project. Each request injects the currently
open files so the agent knows what the user is looking at.

### `agent_runs`
```
id           TEXT PK
document_id  TEXT FK
section_id   TEXT            -- target section (nullable)
mode         TEXT            -- accept_all | confirm_edits
status       TEXT            -- running | done | aborted | ask_user
budget       INTEGER         -- max steps
spent        INTEGER
```

### `settings` (key/value)
- `provider`, `api_url`, `api_key` (or OS keychain — TBD)
- `embedding_model_id` — **locked at project creation**; stored on every vector
- `tesseract_path` — detected or user-set
- `default_agent_mode`

---

## 4. Folder Layout

```
<opened folder>/                    <- the user's research folder
  ├─ your.pdf
  ├─ data/survey.csv
  ├─ notes/interviews.docx
  └─ Dissertator/                   <- VISIBLE marker ("we are here")
      ├─ dissertator.db             <- metadata + vectors (sqlite-vec)
      ├─ project.toml               <- embedding lock, default provider
      ├─ cache/                     <- extracted text, page images, thumbs
      ├─ documents/                 <- working docs (paper.md, thesis.md)
      ├─ exports/                   <- .docx / .bib output
      └─ logs/
```

**Originals are referenced in place** (no copy). Only extracted text, page
images, and thumbnails are cached. Dedup by content hash.

---

## 5. Architecture & Process Boundaries

| Layer | Owns | Tech |
|---|---|---|
| **React webview** | UI: editor, pdf.js viewer, library tree, chat, citeproc-js render | Vite + TS + shadcn/ui + Phosphor icons + emoji |
| **Tauri (Rust)** | window, **file watcher** (living folder), FS I/O, spawns sidecar, IPC | tauri + `notify` crate |
| **Bun sidecar** | extraction, OCR, chunking, **embedding + agent loop + tools**, sqlite-vec queries | Bun + Hono/Fastify; `bun build --compile` → single binary per OS |
| **LLM / embedding providers** | called from sidecar over HTTPS | OpenAI / Claude / Zai / OpenRouter (user-supplied key) |

**Agent loop lives in the sidecar** (tools touch DB + files directly). The
frontend streams tokens over SSE.

### Sidecar responsibility matrix

| Task | Library |
|---|---|
| PDF text (born-digital) | `unpdf` (pdf.js) / `mupdf-js` |
| DOCX | `mammoth` |
| XLSX | `xlsx` (SheetJS) |
| CSV / MD / TXT | native |
| Image → OCR | `tesseract.js` (pure WASM, **no binary bundling**) |
| Vision-API fallback | provider multimodal endpoint |
| SQLite + sqlite-vec | `bun:sqlite` + `sqlite-vec` npm |
| Embeddings + chat | provider SDKs / Vercel AI SDK |
| Thumbnails / page images | `sharp` |
| Bibliography | `citeproc-js` (shared with frontend) |

---

## 6. GUI Design

**Three-pane, colorful, joyful.** React + shadcn/ui + Phosphor icons + emoji
status cues.

```
┌──────────────┬────────────────────────────┬──────────────┐
│  LIBRARY     │   CENTER (tabbed, splittable)  │   CHAT       │
│ 🔵 sources   │   [working doc editor]  │   (global)   │
│   📄 pdf     │      OR                  │              │
│   📄 docx    │   [source PDF viewer]    │  tools/cites │
│ 🟡 documents │                          │              │
│   📝 paper   │   outline = sub-tree     │  open-files  │
│      § intro │   (also in left panel)   │  chips row   │
│ 🟣 attention │                          │              │
│   ⚠ failed   │                          │              │
│ 🔍 search    │                          │              │
└──────────────┴────────────────────────────┴──────────────┘
         settings ⚙  = modal dialog
```

### Color semantics
- 🔵 **blue** — source files (cool, "input")
- 🟡 **yellow** — working documents (warm, "your output, active")
- 🟣 **purple** — chat-generated artifacts not yet placed
- 🔴 **red dot** — attention needed (failed / pending_vision files)

### Panels
- **Left (Library):** file-view tree with search. Sources, documents, and an
  **Attention** group. Document outlines expand as sub-trees; clicking a
  section scrolls/opens the editor there.
- **Center (tabbed, splittable):** editor tabs and PDF-viewer tabs. Any tab
  can "split" (VS-Code style) for side-by-side citation work.
- **Right (Chat):** global thread. Each request injects open files; a visible
  chip row shows "Chatting about: 📄smith2019 📄jones2020".
- **Settings:** modal dialog — provider, api url/key, embedding model,
  tesseract path, default agent mode.

---

## 7. Ingestion & OCR Pipeline

```
new file detected
  → hash dedup (skip if known)
  → extract (born-digital path):
        pdf  → unpdf text + page count
        docx → mammoth
        xlsx → xlsx (per-sheet)
        csv/md/txt → read
        image → needs_ocr
  → if no text / low confidence → needs_ocr
        tesseract present? → ocr_tesseract → done | failed
        absent              → pending_vision
  → failed / pending_vision → shown in Attention panel
                                user clicks "OCR with vision API" → done
  → chunk (page-aware, ~300–500 tokens)
  → embed (provider, locked model_id) → store vectors
  → resolve reference (citekey + DOI lookup) → link to source_file
```

**No binary bundling.** Tesseract presence is detected; if absent, the file
sits in `pending_vision` until the user chooses to run it through a vision API.

---

## 8. Citation System

- **Token form:** `[@citekey:printedPage]` — stores the *printed* page number,
  which is human-meaningful and re-chunk-safe. The chunk DB row holds both
  `physical_page` (for the viewer) and `printed_page` (for the token).
- **Citekey:** auto-generated on first ingest (author+year, fallback to
  filename slug); user-renameable; **frozen thereafter** (never regenerated on
  re-ingest, or every token in existing docs breaks).
- **DOI lookup:** on ingest, parse first page → query Crossref → fill reference
  fields when confident.
- **Bibliography:** `citeproc-js` renders APA/Chicago/etc. from CSL records.
  Fileless references (books you didn't ingest) produce valid entries.
- **In-editor UX:** hover-card on a token shows the exact chunk + page;
  click jumps the PDF viewer to the physical page.

---

## 9. Wizard (Document Creation)

LLM-led interview. Produces an editable shape stored as the `documents` +
`sections` rows:

1. Working title.
2. Focus / angle (the soft-scoping prompt hint).
3. Research questions.
4. Outline template: IMRAD / lit-review / thesis-chapters / free.
5. Agent proposes an outline grounded in a quick corpus scan.
6. User edits → document created, sections seeded.

A second wizard run on the same corpus produces a *different* focused document
(drug-use paper vs crime-rates thesis from the same 100 files).

---

## 10. Agent & Tools

The agent is a tool-using LLM loop running in the sidecar. Tools use a
**`{domain}_{verb}`** naming convention with four fixed domains so the LLM
never confuses what it's operating on:

- `corpus_` — the **index** (references: title/author/year + vectors). Built
  on the `references` + `chunks` tables. Source files are linked as bundles.
- `doc_` — **source bundles** (research PDFs/DOCX/etc.): read-only files.
- `p_` — the **paper / manuscript** (the thesis being written): read-write
  sections, addressed by section + lines/page.
- `gui_` — **user-facing side-effects** (opens a viewer, asks the human,
  narrates a beat). Distinguished from silent data ops.

| Tool | Purpose |
|---|---|
| `corpus_list({text?, author?, title?, vector?, page?})` | query the index → ≤20 hits (ids + short info only; call `doc_read` for depth) |
| `corpus_write(id, {title?, author?, year?, doi?})` | update reference metadata |
| `doc_read(id, page \| lines)` | read a source bundle's content (silent) |
| `p_read(id, lines \| page)` | read a manuscript section |
| `p_write(id, lines \| page, oldtext, text)` | replace manuscript text — `oldtext` makes optimistic-concurrency check explicit |
| `p_insert(id, lines \| page, text)` | insert manuscript text |
| `gui_doc_open(id)` | open a source for the user (pdf.js viewer) |
| `gui_p_open(id)` | open the manuscript for the user |
| `gui_options({short, prompt}[])` | ask the user to pick from structured choices |
| `gui_action(warn \| celebrate \| info, text)` | non-blocking narration beat (no stop) |

**Why the split.** A source bundle is **read-only** (you don't edit a PDF);
the manuscript is **read-write**. Keeping them in separate verb namespaces
(`doc_` vs `p_`) prevents the LLM from calling `p_write` on a source and
getting a confusing runtime rejection. The `gui_` prefix cleanly separates
user-visible side-effects from silent data operations.

**Modes:**
- `accept_all` (default) — agent writes directly.
- `confirm_edits` — every edit requires user approval; agent can also `ask_user`.

**Conflict handling (optimistic, no blocking):** if the user edits a section
while the agent is thinking, the agent's write to that section is rejected on
commit; the agent is informed and may `ask_user`. No read-only locking.

**Cost control:** every run has a step budget; tokens are tracked per message.

---

## 11. Decisions Log

| # | Decision | Rationale |
|---|---|---|
| 1 | **Bun sidecar**, not Python | Single language (TS) across frontend+sidecar; `tesseract.js` removes binary bundling; `bun build --compile` ships one binary per OS; no local embeddings needed (API-only). |
| 2 | Tauri shell | small binary, cross-platform, native FS watcher |
| 3 | React + shadcn/ui + Phosphor + emoji | colorful, joyful, fast to build |
| 4 | sqlite-vec (single file) | portable; one db holds metadata + vectors |
| 5 | `Dissertator/` visible, no dot-prefix | explicit project marker |
| 6 | Originals referenced in place | no duplication; dedup by hash |
| 7 | Chunk-level vectors only (v1) | the load-bearing granularity for citations |
| 8 | Token = `[@citekey:printedPage]` | re-chunk-safe; physical page kept in DB for viewer |
| 9 | Citekey frozen after first set | tokens in docs never break |
| 10 | Embedding model locked per project | re-index required to switch |
| 11 | Two records: SourceFile + Reference | fileless refs produce valid APA entries |
| 12 | No hard corpus scoping (soft) | agent retrieves what's relevant per request |
| 13 | Global chat, open-files injected | one thread, always context-aware |
| 14 | No binary OCR bundling | detect tesseract; else `pending_vision` → user-driven vision API |
| 15 | Agent: accept_all default, confirm_edits opt-in, optimistic writes | user leads; no blocking |
| 16 | **Tool naming = `{domain}_{verb}`** with 4 fixed domains (`corpus_`, `doc_`, `p_`, `gui_`) | LLM never confuses read-only sources vs writable manuscript vs user-facing side-effects; small doc footprint |
| 17 | **Corpus = index; source = bundle** | `references`+`chunks` IS the index (`corpus_list`/`corpus_write`); `source_files` are linked read-only bundles (`doc_read`). Maps the agent mental model onto the existing schema with zero extra tables. |
| 18 | `p_write` takes explicit `oldtext` | optimistic concurrency is part of the signature — conflict rejection is concrete, not magic |

### Open questions
- API key storage: plain in `settings` vs OS keychain? *(lean: keychain via Tauri plugin)*
- `.docx` export path: pandoc subprocess vs pure-JS? *(lean: pandoc, accept dep)*
- Embedding provider list + default (OpenAI `text-embedding-3-small`?).
- Licensing: OSS or commercial?
- UI i18n: Turkish + English at launch?

---

## 12. Phased Build Plan

- **P0 — Scaffold.** Tauri + React + Bun sidecar skeleton. Open folder → create
  `Dissertator/` + db + `project.toml`. Settings dialog (provider/api url/key).
- **P1 — Ingestion.** File watcher, hash dedup, born-digital extraction,
  tesseract detect + OCR path, `pending_vision`, **Attention panel**. No vectors yet.
- **P2 — RAG core.** Embedding config, chunk vectors, `search_corpus`, citekey
  gen + DOI lookup, reference records, token + page lookups.
- **P3 — Library + Editor UI.** Color-coded tree, markdown editor + preview,
  citation popup, pdf.js with jump-to-physical-page, tabbed/split center,
  global chat with open-files injection, citeproc-js bibliography.
- **P4 — Wizard + Documents.** LLM-led wizard (thesis/RQs/outline/focus),
  document + section tables, outline sub-tree, BibTeX import/export.
- **P5 — Agent authoring.** `{domain}_{verb}` tool set (`corpus_*`,
  `doc_*`, `p_*`, `gui_*`), streamed agent loop, accept_all vs
  confirm_edits, `gui_options`, optimistic writes via `p_write(oldtext)`,
  step budget.
- **P6 — Polish.** Re-index/embedding-switch, cost tracking, `.docx` export,
  cross-OS `bun build --compile` packaging, autosave/history.
