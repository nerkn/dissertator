import { useCallback, useState } from "react";
import { CaretDown, CaretRight, Trash } from "@phosphor-icons/react";
import type { SourceFile } from "@dissertator/shared";
import { api } from "../../lib/api";
import { useContentStore } from "../../lib/stores/content";
import { alertDialog, confirmDialog } from "../../lib/stores/dialogs";
import { useTabsStore } from "../../lib/stores/tabs";

interface Props {
  mdSources: SourceFile[];
  onOpen?: (src: SourceFile) => void;
  onNewDocument?: () => void;
}

export function ManuscriptsGroup({ mdSources, onOpen, onNewDocument }: Props) {
  const [open, setOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const setSources = useContentStore((s) => s.setSources);
  const setReferences = useContentStore((s) => s.setReferences);
  const closeTab = useTabsStore((s) => s.closeTab);

  const deleteOne = useCallback(
    async (src: SourceFile) => {
      const ok = await confirmDialog({
        title: "Delete manuscript?",
        message: `"${src.filename}" will be permanently deleted from disk. This cannot be undone.`,
        okLabel: "Delete",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!ok) return;
      setDeletingId(src.id);
      try {
        await api.deleteSource(src.id);
        closeTab(src.id);
        setSources(await api.getSources());
        try {
          setReferences(await api.listReferences());
        } catch {
        }
      } catch (e) {
        await alertDialog({
          title: "Delete failed",
          message: (e as Error)?.message ?? String(e),
        });
      } finally {
        setDeletingId(null);
      }
    },
    [closeTab, setSources, setReferences],
  );

  return (
    <div className="group yellow">
      <div className="group-head group-head-row">
        <span
          className="group-head-toggle"
          onClick={() => setOpen((v) => !v)}
          title="Your editable markdown manuscripts"
        >
          {open ? (
            <CaretDown size={13} weight="bold" />
          ) : (
            <CaretRight size={13} weight="bold" />
          )}
          Manuscripts
        </span>
        {onNewDocument && (
          <button
            className="btn ghost tiny-btn"
            onClick={onNewDocument}
            title="Create a new manuscript"
          >
            + New
          </button>
        )}
      </div>
      {open &&
        (mdSources.length > 0 ? (
          <div className="source-tree">
            {mdSources.map((s) => (
              <div
                key={s.id}
                className="source-row"
                title={s.filename}
                onClick={() => onOpen?.(s)}
              >
                <span className="source-dot doc" />
                <span className="source-name">{s.filename}</span>
                <button
                  className="source-row-delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteOne(s);
                  }}
                  disabled={deletingId === s.id}
                  title="Delete manuscript"
                  aria-label={`Delete ${s.filename}`}
                >
                  <Trash size={12} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="muted small source-tree-empty">
            No manuscripts yet.
          </div>
        ))}
    </div>
  );
}
