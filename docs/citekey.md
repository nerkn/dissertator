# The Citekey Model

> **Two worlds, one bridge.** *Internally*, Dissertator knows only the
> **citekey** — a short `SurnameYear` handle. Manuscript chips, notes/favs,
> PDF links, agent tools, every DB join: citekey only. *Externally*, the real
> world (readers, journals, deposit archives, other tools) does **not** know
> your PDFs — it knows **scientific references** (author, year, title, DOI).
> The `references` (BibTeX/CSL) table exists solely to cross that boundary at
> **export time**, resolving each citekey to the exact real-world reference.
>
> `citekey` is internal. `references` is the external face. There is no
> parallel identity system — just one identifier, and an export-time lookup.

This document is the source of truth. `DESIGN.md §8` summarizes it; details
live here.

---

## 1. Internal vs External

```
                 ┌─── INTERNAL (the app) ────────────────┐
  [@citekey:page]   notes/favs   agent tools   DB joins       ── all citekey only
  notes ─inherit─► source ─link─► references.citekey
                 └────────────────────────────────────────┘
                                      │
                          (export / deposit)
                                      ▼
                 ┌─── EXTERNAL (the real world) ──────────┐
  references record  ──►  rendered APA/Chicago/etc.          ── what readers see
  (authors, year, title, doi, CSL)                              (scientific reference)
                 └─────────────────────────────────────────┘
```

- **`citekey`** — short, unique, frozen `SurnameYear` string
  (`Çengelköylü2022`, `Balcıoğlu2001`). The *only* internal handle. The *only*
  thing inside `[@...]` besides the page. The app never needs the full
  bibliographic name to function — only the citekey.
- **`references`** — the table that **owns** `citekey` (`UNIQUE NOT NULL`,
  frozen). Its job is the **external face**: hold the real-world scientific
  record (authors, year, title, DOI, CSL JSON) so that, at export, each
  citekey resolves to exactly one scientific reference that readers/journals
  recognize. A reference **may be fileless** (a book you didn't ingest) and
  still render a valid bibliography entry — because the external world cares
  about the reference, not your PDF.
- **`source_files`** — the ingested PDFs (the *artifacts*). A source is
  **citekey-less by default**; it only becomes citeable once linked to a
  reference. Sources never store a citekey. **The real world does not know
  sources** — only at export/deposit, when you must point a scientific
  reference at its exact underlying PDF, does the source matter.

**Mental model:**
- *Internally* you wield the **citekey** (the handle).
- *Externally* you owe the **reference** (the scientific name readers see).
- The **source** (PDF) is the artifact behind the reference — needed only to
  ground a reference in its exact text, or to deposit/verify it.

You cite the handle. You export the name. You (optionally) point the name at
the artifact. The handle is the single thing that ties all three together.

---

## 2. Where citekey appears (and where it does NOT)

| Place | Stores citekey? | How |
|---|---|---|
| `references.citekey` | **YES — owner** | `UNIQUE NOT NULL`, frozen. The canonical home. |
| `documents.body_md` | YES — as text | `[@citekey:page]` tokens; plain editable markdown. |
| `notes` (favs) | **NO** | Computed at read time: `note.source → source.reference → citekey`. Never persisted on the note. |
| `source_files` | **NO** | A source is linked *from* a reference via `references.source_file_id` (the canonical direction); it has no citekey column and never should. |
| Agent tools | NO | Tools speak `sourceFileId` / `referenceId`. Citekey is a *display/resolution* concern, not a tool arg. |

The fact that citekey is stored in **exactly one place** (`references.citekey`)
and computed everywhere else is what keeps the system consistent. Never add a
`citekey` column to `notes` or `source_files`.

---

## 3. Resolution — one path

Clicking a chip, or anything that needs to go from a token to a PDF, follows
exactly one path (`App.tsx` `handleCitationClick`):

```
[@citekey:page]
     │
     ▼
getReference(citekey)            ── references.citekey lookup
     │
     ├─ ref.source_file_id set?  ──► openSourceAtPage(PDF, page)   ✅ opens PDF
     │
     └─ else                     ──► CitationPopup (fileless card) ✅ shows metadata
```

There is no "look up a PDF by filename" branch, no "look up a PDF by its own
citekey" branch. **Citekey is always resolved through `references` first.**
This is why a fileless reference still renders a card, and why a source with no
linked reference is unreachable from a chip.

**Export direction (the external face).** The same lookup, run for every token
at export/deposit time, is what turns internal citekeys into the scientific
references the real world recognizes:

```
[@citekey:page]  ──►  references.citekey  ──►  CSL record  ──►  citeproc renders APA/Chicago
                        (the scientific name)                    (what readers/journals see)
                                          └─►  ref.source_file_id  ──►  exact PDF (deposit/verify)
```
Here the reference is **resolved to its exact source** only when the external
world demands the artifact (deposit, verification, supplementary materials).
Day-to-day, the citekey alone is enough.

---

## 4. Favs / notes → citekey inheritance

A note is captured on a **page of a source**. It has no citekey field. When the
UI needs to cite a note (e.g. "insert fav at cursor"), it computes:

```
note.citekey = note.source.reference?.citekey   // or null
note.page     = note.page                        // physical page
token         = `[@${note.citekey}:${note.page}]`
```

Consequences:
- Every source is linked to a reference **from ingest** — `ingestFile` mints a
  minimal placeholder reference (citekey from the filename) the moment a file
  finishes extracting, and `backfillSourceReferences()` sweeps any pre-existing
  orphans at project open. So `note.citekey` is essentially never `null` and
  the cite button is never greyed for lack of a citekey. (The
  `disabled={!note.citekey}` guard in `LibraryPanel.tsx` stays as a defensive
  fallback.) Real bibliographic metadata arrives later via Crossref/BibTeX, but
  the citekey — the internal handle — is already frozen.
- **Inserting a fav brings the passage INTO the manuscript.** `copyCite`
  (`LibraryPanel.tsx`) inserts the note's excerpt (or its body as fallback)
  followed by the token — `"…the quoted passage…" [@Çengelköylü2022:7]` — at the
  cursor (clipboard fallback when no editor is open). Not the bare token.
- Linking a source to a reference **retroactively makes all of that source's
  notes citeable**. No note migration needed — it's computed on read.
- This is the bridge between "collect-while-reading" (favs) and
  "cite-while-writing" (manuscript), and citekey is the only thing crossing it.

---

## 5. Invariants

1. **citekey is unique and frozen.** `references.citekey UNIQUE NOT NULL`; never
   regenerated, never renamed (re-ingest, edits, nothing touches it). Renaming
   would orphan every `[@citekey]` token in every document.
2. **citekey lives only on `references`.** No other table stores it. Notes and
   sources compute/resolve it.
3. **Internally, citekey only.** Chips, notes, agent tools, and DB joins deal
   in citekey (or ids). The full bibliographic name is never needed for the app
   to function.
4. **`references` is the external face; its job is export.** Each citekey
   resolves to exactly one scientific reference record (CSL) that the real
   world recognizes. If you removed citeproc/export, references would still be
   needed *only* as the citekey registry + the source link — that is their
   irreducible internal role; everything else about them exists for the
   external world.
5. **Resolution is citekey→reference→source, never direct.** No code path
   resolves a chip to a PDF without going through `references`. The link lives
   in **one direction only**: `references.source_file_id`. (The reverse column
   `source_files.reference_id` is redundant and a drift hazard — see the note
   below.)
6. **A source resolves to at most one citekey.** Because the link is
   `references.source_file_id`, a reference names at most one canonical PDF.
   (Multiple sources may share a citekey, but chip resolution always picks the
   reference's `source_file_id`.)
7. **citekey generation preserves case AND accents ("B-cap").**
   `generateCitekey` keeps the family name's original capitalization and
   Unicode letters: `Çengelköylü` → `Çengelköylü2022`, `Müller` → `Müller`,
   `O'Brien` → `OBrien`. It does **not** ASCII-fold (`Ç→c`) and does **not**
   lowercase. Accented tokens the user already typed in their documents must
   keep resolving, so the stored citekey matches them byte-for-byte. The
   internal handle just has to be stable + unique; cosmetic polish is the
   external (CSL/export) layer's job.

> **Drift hazard — RESOLVED.** Both `references.source_file_id` and
> `source_files.reference_id` once existed, but only the former was ever
> written (`linkReferenceToSource`), while the note-citekey query read the
> latter — so `note.citekey` was always `null` and favs couldn't be cited. The
> reverse column has been removed: the link now lives in ONE direction
> (`references.source_file_id`), the note query resolves citekey through it,
> and `migrate()` drops the redundant column from existing DBs.

---

## 6. Glossary (use these words, not synonyms)

| Term | Means | Not to be confused with |
|---|---|---|
| **citekey** | The immutable `SurnameYear` string naming a reference. | a filename, a source id, a note id |
| **Reference** | A row in `references` — the bibliographic record that *owns* a citekey. May be fileless. | a SourceFile (a Reference may describe one, but isn't one) |
| **SourceFile / Source** | An ingested PDF/doc in `source_files`. The artifact. | a Reference (a source is citekey-less until linked) |
| **Citation token** | The `[@citekey:page]` text in a manuscript. | the reference itself |
| **Note / fav** | A captured passage on a source page; citeable via its source's reference. | a reference (a note is evidence, not a citation record) |

**UI labeling rule:** call PDFs **"Sources"** and the metadata library
**"References"**. Never call both "references". The citekey is shown as-is
(`@Çengelköylü2022`) wherever a reference is named.
