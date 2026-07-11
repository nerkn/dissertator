// ===========================================================================
// Prompts tab (unchanged).
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

function PromptsTab() {
  const [rows, setRows] = useState<PromptRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  // The last-saved serialization, so we can mark the Save button dirty only
  // when the user actually changed something.
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

  const update = (uid: string, patch: Partial<PromptRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.uid === uid ? { ...r, ...patch } : r)),
    );
  };

  const add = () => {
    setRows((prev) => [
      ...prev,
      { uid: nextPromptUid(), category: "", label: "", prompt: "" },
    ]);
  };

  const remove = (uid: string) => {
    setRows((prev) => prev.filter((r) => r.uid !== uid));
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

      <div className="prompts-list">
        {rows.length === 0 && (
          <div className="muted small prompts-empty">
            No prompts yet. Add one below.
          </div>
        )}
        {rows.map((r) => (
          <div className="prompt-item" key={r.uid}>
            <div className="prompt-item-head">
              <input
                className="prompt-category-input"
                value={r.category}
                onChange={(e) => update(r.uid, { category: e.target.value })}
                placeholder="Category (optional)"
              />
              <input
                className="prompt-title-input"
                value={r.label}
                onChange={(e) => update(r.uid, { label: e.target.value })}
                placeholder="Title"
              />
              <button
                className="icon-btn danger"
                title="Remove prompt"
                onClick={() => remove(r.uid)}
              >
                <Trash size={15} />
              </button>
            </div>
            <textarea
              className="prompt-textarea"
              value={r.prompt}
              onChange={(e) => update(r.uid, { prompt: e.target.value })}
              placeholder="The prompt text the agent receives…"
              rows={2}
              spellCheck={false}
            />
          </div>
        ))}
      </div>

      <div className="prompts-foot">
        {savedAt && !dirty && <span className="muted small">Saved.</span>}
        <button className="btn ghost tiny-btn" onClick={add} title="Add a prompt">
          <Plus size={13} weight="bold" /> Add prompt
        </button>
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
