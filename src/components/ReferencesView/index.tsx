// ReferencesView — the bibliography manager, opened as a center-pane tab.
//
// Lists every `Reference` (citeproc / CSL) with search, source-file linking,
// inline edit, delete, BibTeX import/export, and Crossref lookup. A reference
// may be "fileless" (no backing SourceFile) or linked to one; linking is what
// makes a `[@citekey:page]` chip click open the PDF.
//
// This module owns the data: the references list, the edit/draft state, and
// every mutation (link/unlink/remove/save/import/export/lookup/detect). The
// toolbar + row are presentational (see `_ReferencesToolbar`, `_ReferenceRow`).

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Reference, SourceFile } from "@dissertator/shared";
import { api } from "../../lib/api";
import {
  fmtAuthors,
  parseAuthors,
  type ReferenceDraft,
} from "../ReferenceFields";
import { ReferencesToolbar } from "./_ReferencesToolbar";
import { ReferenceRow } from "./_ReferenceRow";

interface Props {
  /** Ingested source files — populates the "link to source" picker. */
  sources: SourceFile[];
  /** Open a (just-linked) source in the PDF viewer. */
  onOpenSource?: (src: SourceFile) => void;
}

type Status = "idle" | "saving" | "error";

export function ReferencesView({ sources, onOpenSource }: Props) {
  const [refs, setRefs] = useState<Reference[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ReferenceDraft>({});
  // Crossref / DOI add:
  const [lookup, setLookup] = useState("");
  const [looking, setLooking] = useState(false);
  // BibTeX import textarea toggle:
  const [showImport, setShowImport] = useState(false);
  const [bibText, setBibText] = useState("");
  // Bulk auto-detect (Option A): scanning unlinked sources for DOIs.
  const [detecting, setDetecting] = useState(false);

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

  // Auto-detect references (Option A): for every source NOT already linked to
  // a reference, scan its extracted text for a DOI, resolve via Crossref, and
  // create + link the reference. Sources with no resolvable DOI (books,
  // preprints, scans) are skipped silently — that's not an error.
  const detectAll = async () => {
    const linked = new Set(
      refs.map((r) => r.source_file_id).filter(Boolean) as string[],
    );
    const targets = sources.filter((s) => !linked.has(s.id));
    if (targets.length === 0) {
      alert("Nothing to detect \u2014 every source is already linked.");
      return;
    }
    setDetecting(true);
    let found = 0;
    try {
      for (const s of targets) {
        const res = await api.detectReference(s.id);
        if (res.found && !res.alreadyLinked) found++;
      }
      await reload();
      alert(
        found > 0
          ? `Linked ${found} of ${targets.length} source(s) via DOI.`
          : `No DOIs resolved from ${targets.length} source(s) \u2014 add those manually or by title.`,
      );
    } catch {
      setStatus("error");
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="references-view">
      <ReferencesToolbar
        query={query}
        setQuery={setQuery}
        filteredCount={filtered.length}
        totalCount={refs.length}
        onAutoDetect={detectAll}
        detecting={detecting}
        sourcesCount={sources.length}
        onRefresh={reload}
        showImport={showImport}
        setShowImport={setShowImport}
        bibText={bibText}
        setBibText={setBibText}
        onImport={doImport}
        onExport={doExport}
        lookup={lookup}
        setLookup={setLookup}
        onLookup={doLookup}
        looking={looking}
      />

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
          filtered.map((r) => (
            <ReferenceRow
              key={r.id}
              r={r}
              linked={r.source_file_id ? sourceById.get(r.source_file_id) : undefined}
              editing={editingId === r.id}
              draft={draft}
              setDraft={setDraft}
              sources={sources}
              onLink={link}
              onUnlink={unlink}
              onRemove={remove}
              onStartEdit={startEdit}
              onSaveEdit={saveEdit}
              onCancelEdit={() => setEditingId(null)}
              onOpenSource={onOpenSource}
            />
          ))
        )}
      </div>
    </div>
  );
}
