// ===========================================================================
// Prompts tab — dropdown-driven editor.
//
// The quick-fire prompts live in `Dissertator/prompts.md` (one bullet per
// prompt). Previously every row was shown at once as a stacked list; now the
// user picks one from a <select> and edits just that row below. Add / Remove
// / Save behave as before (Save serializes ALL rows and PUTs the whole file).
// ===========================================================================

import { useEffect, useRef, useState } from "react";
import { FloppyDisk, Plus, Trash } from "@phosphor-icons/react";
import { serializePrompts } from "@dissertator/shared";
import { api } from "../../lib/api";

/** Internal row shape: a Prompt plus a transient client-side id so React can
 *  key rows during add/remove/edit before the file is re-serialized. */
interface PromptRow {
  uid: string;
  category: string;
  label: string;
  prompt: string;
}

let promptUidSeq = 0;
const nextPromptUid = () => `p-${Date.now()}-${promptUidSeq++}`;

/** The text shown in the <select> for a row: "Category — Label", or just the
 *  label when no category is set. Falls back to "(untitled)" so empty rows
 *  stay selectable right after Add. */
function rowLabel(r: PromptRow): string {
  const label = r.label.trim() || "(untitled)";
  return r.category.trim() ? `${r.category.trim()} — ${label}` : label;
}

function PromptsTab() {
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // The last-saved serialization, so Save is only enabled when something
  // actually changed.
  const lastSavedRef = useRef<string>("");

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const parsed = await api.listPrompts();
        if (stopped) return;
        const initial = parsed.map((p) => ({
          uid: nextPromptUid(),
          category: p.category ?? "",
          label: p.label,
          prompt: p.prompt,
        }));
        setRows(initial);
        setSelectedUid(initial[0]?.uid ?? null);
        lastSavedRef.current = serializePrompts(initial);
      } catch {
        /* ignore — empty list is fine */
      } finally {
        if (!stopped) setLoading(false);
      }
    })();
    return () => {
      stopped = true;
    };
  }, []);

  const dirty = serializePrompts(rows) !== lastSavedRef.current;
  const selected = rows.find((r) => r.uid === selectedUid) ?? null;

  const update = (uid: string, patch: Partial<PromptRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)),
    );
  };

  const add = () => {
    const row: PromptRow = {
      uid: nextPromptUid(),
      category: "",
      label: "",
      prompt: "",
    };
    setRows((prev) => [...prev, row]);
    setSelectedUid(row.uid); // jump straight to editing the new row
  };

  const remove = (uid: string) => {
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.uid === uid);
      const next = prev.filter((r) => r.uid !== uid);
      // Move selection to a surviving neighbor so the editor isn't left blank.
      if (uid === selectedUid) {
        const neighbor = next[idx] ?? next[idx - 1] ?? null;
        setSelectedUid(neighbor?.uid ?? null);
      }
      return next;
    });
  };

  const save = async () => {
    const md = serializePrompts(rows);
    setSaving(true);
    try {
      await api.savePromptsMarkdown(md);
      lastSavedRef.current = md;
      setSavedAt(Date.now());
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="muted">Loading prompts…</div>;

  return (
    <div className="prompts-tab">
      <div className="muted small helper">
        Quick-fire prompts for the chat. Each row becomes a button under the
        composer. Group rows by typing the same <strong>Category</strong>.
      </div>

      <div className="prompts-selector">
        <select
          className="prompts-select"
          value={selectedUid ?? ""}
          onChange={(e) => setSelectedUid(e.target.value || null)}
          disabled={rows.length === 0}
        >
          {rows.length === 0 && <option value="">No prompts yet</option>}
          {rows.map((r) => (
            <option key={r.uid} value={r.uid}>
              {rowLabel(r)}
            </option>
          ))}
        </select>
        <button
          className="btn ghost tiny-btn"
          onClick={add}
          title="Add a prompt"
        >
          <Plus size={13} weight="bold" /> Add
        </button>
        {selected && (
          <button
            className="icon-btn danger"
            title="Remove selected prompt"
            onClick={() => remove(selected.uid)}
          >
            <Trash size={15} />
          </button>
        )}
      </div>

      {selected ? (
        <div className="prompt-item" key={selected.uid}>
          <div className="prompt-item-head">
            <input
              className="prompt-category-input"
              value={selected.category}
              onChange={(e) =>
                update(selected.uid, { category: e.target.value })
              }
              placeholder="Category (optional)"
            />
            <input
              className="prompt-title-input"
              value={selected.label}
              onChange={(e) => update(selected.uid, { label: e.target.value })}
              placeholder="Title"
            />
          </div>
          <textarea
            className="prompt-textarea"
            value={selected.prompt}
            onChange={(e) => update(selected.uid, { prompt: e.target.value })}
            placeholder="The prompt text the agent receives…"
            rows={8}
            spellCheck={false}
          />
        </div>
      ) : (
        <div className="muted small prompts-empty">
          No prompt selected. Click <strong>Add</strong> to create one.
        </div>
      )}

      <div className="prompts-foot">
        {savedAt && !dirty && <span className="muted small">Saved.</span>}
        <button
          className="btn small primary"
          onClick={save}
          disabled={saving || !dirty}
          title="Save prompts to prompts.md"
        >
          <FloppyDisk size={14} weight="bold" />
          {saving ? "saving…" : "Save prompts"}
        </button>
      </div>
    </div>
  );
}

export { PromptsTab };
