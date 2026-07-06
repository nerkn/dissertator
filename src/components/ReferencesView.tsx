// ReferencesView — the bibliography manager, opened as a center-pane tab.
//
// Lists every `Reference` (citeproc / CSL) with search, source-file linking,
// inline edit, delete, BibTeX import/export, and Crossref lookup. A reference
// may be "fileless" (no backing SourceFile) or linked to one; linking is what
// makes a `[@citekey:page]` chip click open the PDF.
//
// Backed by the existing references API (list/get/create/update/delete +
// importBibtex/exportBibtex/lookupDoi/lookupReference). No backend changes.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowsClockwise,
  DownloadSimple,
  FilePdf,
  Link,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Trash,
  UploadSimple,
  X,
} from "@phosphor-icons/react";
import type { Author, Reference, SourceFile } from "@dissertator/shared";
import { api } from "../lib/api";

interface Props {
  /** Ingested source files — populates the "link to source" picker. */
  sources: SourceFile[];
  /** Open a (just-linked) source in the PDF viewer. */
  onOpenSource?: (src: SourceFile) => void;
}

type Status = "idle" | "saving" | "error";

/** Editable draft for an in-progress reference edit. `authorsText` carries the
 *  free-text authors field until save (parsed back to Author[] on submit). */
interface Draft {
  citekey?: string;
  title?: string | null;
  year?: number | null;
  doi?: string | null;
  authors?: Author[];
  authorsText?: string;
}

/** Format [{given,family}] → "Given Family, Given Family". */
function fmtAuthors(a: Author[]): string {
  return a
    .map((x) => [x.given, x.family].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

/** Parse "Given Family; Given Family" (or "Family, Given; ...") → Author[]. */
function parseAuthors(s: string): Author[] {
  return s
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // "Family, Given" form
      const m = p.match(/^([^,]+),\s*(.+)$/);
      if (m) return { family: m[1].trim(), given: m[2].trim() };
      // "Given Family" form (last token = family)
      const i = p.lastIndexOf(" ");
      if (i === -1) return { family: p, given: "" };
      return { given: p.slice(0, i).trim(), family: p.slice(i + 1).trim() };
    });
}

export function ReferencesView({ sources, onOpenSource }: Props) {
  const [refs, setRefs] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  // Crossref / DOI add:
  const [lookup, setLookup] = useState("");
  const [looking, setLooking] = useState(false);
  // BibTeX import textarea toggle:
  const [showImport, setShowImport] = useState(false);
  const [bibText, setBibText] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setRefs(await api.listReferences());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return refs;
    return refs.filter(
      (r) =>
        r.citekey.toLowerCase().includes(q) ||
        (r.title ?? "").toLowerCase().includes(q) ||
        fmtAuthors(r.authors).toLowerCase().includes(q) ||
        (r.year ? String(r.year).includes(q) : false),
    );
  }, [refs, query]);

  const sourceById = useMemo(() => {
    const m = new Map<string, SourceFile>();
    for (const s of sources) m.set(s.id, s);
    return m;
  }, [sources]);

  // --- mutations ----------------------------------------------------------
  const link = async (r: Reference, sourceId: string) => {
    setStatus("saving");
    try {
      const updated = await api.updateReference(r.id, { source_file_id: sourceId });
      setRefs((rs) => rs.map((x) => (x.id === r.id ? updated : x)));
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  const unlink = async (r: Reference) => {
    setStatus("saving");
    try {
      const updated = await api.updateReference(r.id, { source_file_id: null });
      setRefs((rs) => rs.map((x) => (x.id === r.id ? updated : x)));
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this reference? This cannot be undone.")) return;
    try {
      await api.deleteReference(id);
      setRefs((rs) => rs.filter((x) => x.id !== id));
    } catch {
      setStatus("error");
    }
  };

  const startEdit = (r: Reference) => {
    setEditingId(r.id);
    setDraft({
      citekey: r.citekey,
      title: r.title ?? "",
      year: r.year,
      doi: r.doi ?? "",
      authors: r.authors,
      authorsText: fmtAuthors(r.authors),
    });
  };

  const saveEdit = async (id: string) => {
    const patch: Partial<Reference> = {
      citekey: (draft.citekey ?? "").trim() || undefined,
      title: (draft.title ?? "").trim() || null,
      year: draft.year == null ? null : Number(draft.year) || null,
      doi: (draft.doi ?? "").trim() || null,
      authors: parseAuthors(draft.authorsText ?? ""),
    };
    setStatus("saving");
    try {
      const updated = await api.updateReference(id, patch);
      setRefs((rs) => rs.map((x) => (x.id === id ? updated : x)));
      setEditingId(null);
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  const doImport = async () => {
    if (!bibText.trim()) return;
    setStatus("saving");
    try {
      await api.importBibtex(bibText);
      setBibText("");
      setShowImport(false);
      await reload();
      setStatus("idle");
    } catch {
      setStatus("error");
    }
  };

  const doExport = async () => {
    const text = await api.exportBibtex();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "references.bib";
    a.click();
    URL.revokeObjectURL(url);
  };

  // Try DOI first; if not a DOI, treat as a Crossref free-text query and add
  // the top hit.
  const doLookup = async () => {
    const q = lookup.trim();
    if (!q) return;
    setLooking(true);
    try {
      const isDoi = /^10\.\d{4,9}\//.test(q);
      let added: Reference | null = null;
      if (isDoi) {
        added = await api.lookupDoi(q);
      } else {
        const hits = await api.lookupReference(q);
        added = hits[0] ?? null;
      }
      if (added) {
        await reload();
        setLookup("");
      } else {
        alert("No matching reference found.");
      }
    } catch {
      setStatus("error");
    } finally {
      setLooking(false);
    }
  };

  return (
    <div className="references-view">
      <div className="references-toolbar">
        <div className="search-box">
          <MagnifyingGlass size={14} weight="bold" />
          <input
            placeholder="Search citekey, title, author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="muted small">{filtered.length} / {refs.length}</span>
        <div className="spacer" />
        <button className="btn ghost small-btn" onClick={() => reload()} title="Reload">
          <ArrowsClockwise size={14} weight="bold" /> Refresh
        </button>
        <button
          className="btn ghost small-btn"
          onClick={() => setShowImport((v) => !v)}
          title="Import a .bib string"
        >
          <UploadSimple size={14} weight="bold" /> Import .bib
        </button>
        <button className="btn ghost small-btn" onClick={doExport} title="Export all as .bib">
          <DownloadSimple size={14} weight="bold" /> Export .bib
        </button>
      </div>

      {showImport && (
        <div className="references-import">
          <textarea
            placeholder={"Paste BibTeX here, e.g.\n@article{Smith2020,\n  title = {…},\n  author = {…},\n  year = {2020}\n}"}
            value={bibText}
            onChange={(e) => setBibText(e.target.value)}
            rows={6}
          />
          <div className="references-import-actions">
            <button className="btn primary small-btn" onClick={doImport} disabled={!bibText.trim()}>
              <Plus size={14} weight="bold" /> Import
            </button>
            <button className="btn ghost small-btn" onClick={() => setShowImport(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="references-add">
        <input
          placeholder="Add by DOI (10.xxxx/…) or Crossref search…"
          value={lookup}
          onChange={(e) => setLookup(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doLookup()}
        />
        <button className="btn ghost small-btn" onClick={doLookup} disabled={looking || !lookup.trim()}>
          <PaperPlaneTilt size={14} weight="bold" />
          {looking ? "Searching…" : "Add"}
        </button>
      </div>

      {status === "error" && (
        <div className="banner error small">Something went wrong — try again.</div>
      )}

      <div className="references-list">
        {loading ? (
          <div className="muted">Loading references…</div>
        ) : filtered.length === 0 ? (
          <div className="muted">
            {refs.length === 0
              ? "No references yet. Import a .bib file or add one by DOI / Crossref search."
              : "No references match your search."}
          </div>
        ) : (
          filtered.map((r) => {
            const linked = r.source_file_id ? sourceById.get(r.source_file_id) : undefined;
            const editing = editingId === r.id;
            return (
              <div key={r.id} className="reference-row">
                <div className="reference-main">
                  {editing ? (
                    <div className="reference-edit">
                      <input
                        placeholder="citekey"
                        value={(draft.citekey as string) ?? ""}
                        onChange={(e) => setDraft({ ...draft, citekey: e.target.value })}
                      />
                      <input
                        placeholder="Title"
                        value={(draft.title as string) ?? ""}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      />
                      <input
                        placeholder="Authors (Given Family; …)"
                        value={draft.authorsText ?? ""}
                        onChange={(e) => setDraft({ ...draft, authorsText: e.target.value })}
                      />
                      <div className="reference-edit-row">
                        <input
                          placeholder="Year"
                          type="number"
                          value={draft.year ?? ""}
                          onChange={(e) =>
                            setDraft({ ...draft, year: e.target.value ? Number(e.target.value) : null })
                          }
                        />
                        <input
                          placeholder="DOI"
                          value={(draft.doi as string) ?? ""}
                          onChange={(e) => setDraft({ ...draft, doi: e.target.value })}
                        />
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="reference-head">
                        <code className="citekey">{r.citekey}</code>
                        {r.year && <span className="muted small">{r.year}</span>}
                        {linked ? (
                          <span className="ref-badge linked" title={linked.filename}>
                            <Link size={11} weight="bold" /> {linked.filename}
                          </span>
                        ) : (
                          <span className="ref-badge fileless">fileless</span>
                        )}
                      </div>
                      {r.title && <div className="reference-title">{r.title}</div>}
                      {r.authors.length > 0 && (
                        <div className="muted small">{fmtAuthors(r.authors)}</div>
                      )}
                      {(r.venue || r.doi) && (
                        <div className="muted small">
                          {[r.venue, r.doi].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </>
                  )}
                </div>

                <div className="reference-actions">
                  {editing ? (
                    <>
                      <button className="btn primary small-btn" onClick={() => saveEdit(r.id)}>
                        Save
                      </button>
                      <button className="btn ghost small-btn" onClick={() => setEditingId(null)}>
                        <X size={14} weight="bold" />
                      </button>
                    </>
                  ) : linked ? (
                    <>
                      {onOpenSource && (
                        <button
                          className="btn ghost small-btn"
                          onClick={() => onOpenSource(linked)}
                          title="Open linked PDF"
                        >
                          <FilePdf size={14} weight="bold" /> Open
                        </button>
                      )}
                      <button
                        className="btn ghost small-btn"
                        onClick={() => unlink(r)}
                        title="Unlink from source"
                      >
                        <Link size={14} weight="bold" /> Unlink
                      </button>
                      <button className="btn ghost small-btn" onClick={() => startEdit(r)}>
                        Edit
                      </button>
                      <button className="btn ghost small-btn" onClick={() => remove(r.id)}>
                        <Trash size={14} weight="bold" />
                      </button>
                    </>
                  ) : (
                    <>
                      <label className="ref-link-select" title="Link to a source file">
                        <Link size={13} weight="bold" />
                        <select
                          value=""
                          onChange={(e) => {
                            const id = e.target.value;
                            if (id) void link(r, id);
                          }}
                        >
                          <option value="" disabled>
                            Link to file…
                          </option>
                          {sources.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.filename}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button className="btn ghost small-btn" onClick={() => startEdit(r)}>
                        Edit
                      </button>
                      <button className="btn ghost small-btn" onClick={() => remove(r.id)}>
                        <Trash size={14} weight="bold" />
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
