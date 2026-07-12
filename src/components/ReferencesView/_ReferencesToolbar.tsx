// ReferencesToolbar — the top controls of the bibliography manager: the
// search box + count, auto-detect, refresh, import/export, the collapsible
// BibTeX import textarea, and the add-by-DOI/Crossref input. Presentational;
// all state + mutations live in the parent.

import {
  ArrowsClockwise,
  Scan,
  DownloadSimple,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  UploadSimple,
} from "@phosphor-icons/react";

interface Props {
  query: string;
  setQuery: (v: string) => void;
  filteredCount: number;
  totalCount: number;
  /** Auto-detect (scan unlinked sources for DOIs). */
  onAutoDetect: () => void;
  detecting: boolean;
  sourcesCount: number;
  onRefresh: () => void;
  /** BibTeX import textarea toggle + content. */
  showImport: boolean;
  setShowImport: (v: boolean) => void;
  bibText: string;
  setBibText: (v: string) => void;
  onImport: () => void;
  onExport: () => void;
  /** Add by DOI / Crossref search. */
  lookup: string;
  setLookup: (v: string) => void;
  onLookup: () => void;
  looking: boolean;
}

export function ReferencesToolbar({
  query,
  setQuery,
  filteredCount,
  totalCount,
  onAutoDetect,
  detecting,
  sourcesCount,
  onRefresh,
  showImport,
  setShowImport,
  bibText,
  setBibText,
  onImport,
  onExport,
  lookup,
  setLookup,
  onLookup,
  looking,
}: Props) {
  return (
    <>
      <div className="references-toolbar">
        <div className="search-box">
          <MagnifyingGlass size={14} weight="bold" />
          <input
            placeholder="Search citekey, title, author…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="muted small">{filteredCount} / {totalCount}</span>
        <button
          className="btn ghost small-btn"
          onClick={onAutoDetect}
          disabled={detecting || sourcesCount === 0}
          title="Scan every unlinked source's text for a DOI and auto-create + link its reference"
        >
          <Scan size={14} weight="bold" /> {detecting ? "Detecting\u2026" : "Auto-detect"}
        </button>
        <div className="spacer" />
        <button className="btn ghost small-btn" onClick={onRefresh} title="Reload">
          <ArrowsClockwise size={14} weight="bold" /> Refresh
        </button>
        <button
          className="btn ghost small-btn"
          onClick={() => setShowImport(!showImport)}
          title="Import a .bib string"
        >
          <UploadSimple size={14} weight="bold" /> Import .bib
        </button>
        <button className="btn ghost small-btn" onClick={onExport} title="Export all as .bib">
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
            <button className="btn primary small-btn" onClick={onImport} disabled={!bibText.trim()}>
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
          onKeyDown={(e) => e.key === "Enter" && onLookup()}
        />
        <button className="btn ghost small-btn" onClick={onLookup} disabled={looking || !lookup.trim()}>
          <PaperPlaneTilt size={14} weight="bold" />
          {looking ? "Searching…" : "Add"}
        </button>
      </div>
    </>
  );
}
