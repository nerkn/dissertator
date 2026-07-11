// StatusBar + SavePip — small chrome pieces for the ManuscriptEditor.
// Grouped: SavePip is toolbar chrome (the autosave pip), StatusBar is the
// bottom strip; both are tiny presentational components driven by the shared
// SaveState type.

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
}

function StatusBar({ saveState, docStats }: StatusBarProps) {
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
      </div>
      <div className="statusbar-right">
        <span className="stat-item">{docStats.words.toLocaleString()} words</span>
        <span className="stat-divider">|</span>
        <span className="stat-item">{docStats.chars.toLocaleString()} characters</span>
      </div>
    </div>
  );
}

export { SavePip, StatusBar };
