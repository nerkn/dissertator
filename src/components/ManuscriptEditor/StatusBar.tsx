// StatusBar + SavePip — small chrome pieces for the ManuscriptEditor.
// Grouped: SavePip is toolbar chrome (the autosave pip), StatusBar is the
// bottom strip; both are tiny presentational components driven by the shared
// SaveState type.

import { useEffect, useState } from "react";
import type { SaveState } from "./_shared";

function SavePip({ state }: { state: SaveState }) {
  const map: Record<SaveState, { label: string; cls: string }> = {
    idle: { label: "", cls: "" },
    dirty: { label: "Unsaved", cls: "dirty" },
    saving: { label: "Saving…", cls: "saving" },
    saved: { label: "Saved", cls: "saved" },
    error: { label: "Save failed", cls: "error" },
  };
  const m = map[state];
  if (!m.label) return null;
  return <span className={`save-pip ${m.cls}`}>{m.label}</span>;
}

// ---------------------------------------------------------------------------
// StatusBar — Shows document stats and save state at the bottom of the editor
// ---------------------------------------------------------------------------

interface StatusBarProps {
  saveState: SaveState;
  docStats: { words: number; chars: number };
  /** Source mode only: true while the on-disk .md is ahead of its indexed
   *  chunks (a save landed but the sidecar's settle timer hasn't fired the
   *  trailing reingest yet). */
  chunksDirty?: boolean;
  /** Epoch ms of the last successful autosave, or null if none this session. */
  lastSavedAt?: number | null;
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function agoLabel(ts: number | null | undefined, now: number): string | null {
  if (!ts) return null;
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBar({ saveState, docStats, chunksDirty, lastSavedAt }: StatusBarProps) {
  const now = useNow();
  const ago = agoLabel(lastSavedAt, now);
  const map: Record<SaveState, { label: string; icon: string }> = {
    idle: { label: "All changes saved", icon: "✓" },
    dirty: { label: "Unsaved changes", icon: "●" },
    saving: { label: "Saving…", icon: "⟳" },
    saved: { label: "Saved", icon: "✓" },
    error: { label: "Save failed", icon: "✕" },
  };
  const m = map[saveState];
  const statusClass = saveState === "saved" ? "status-saved" : saveState === "error" ? "status-error" : saveState === "dirty" ? "status-dirty" : "status-neutral";

  return (
    <div className="editor-statusbar">
      <div className="statusbar-left">
        <span className={`status-indicator ${statusClass}`}>{m.icon}</span>
        <span className="status-text">{m.label}</span>
        {ago && <span className="stat-item lts">· saved {ago}</span>}
      </div>
      <div className="statusbar-right">
        {chunksDirty && (
          <span className="stat-item chunks-dirty" title="The file has unsaved edits waiting to be re-indexed into the corpus.">
            ◑ reindexing soon
          </span>
        )}
        <span className="stat-item">{docStats.words.toLocaleString()} words</span>
        <span className="stat-divider">|</span>
        <span className="stat-item">{docStats.chars.toLocaleString()} characters</span>
      </div>
    </div>
  );
}

export { SavePip, StatusBar };
