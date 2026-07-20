import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { Document, SourceFile } from "@dissertator/shared";

interface Props {
  documents: Document[];
  mdSources: SourceFile[];
  onOpenDocument?: (doc: Document) => void;
  onOpenMd?: (src: SourceFile) => void;
  onNewDocument?: () => void;
}

export function ManuscriptsGroup({
  documents,
  mdSources,
  onOpenDocument,
  onOpenMd,
  onNewDocument,
}: Props) {
  const [open, setOpen] = useState(false);
  const total = documents.length + mdSources.length;

  return (
    <div className="group yellow">
      <div className="group-head group-head-row">
        <span
          className="group-head-toggle"
          onClick={() => setOpen((v) => !v)}
          title="Your papers, theses & markdown manuscripts"
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
        (total > 0 ? (
          <div className="source-tree">
            {documents.map((d) => (
              <div
                key={d.id}
                className="source-row"
                title={d.title}
                onClick={() => onOpenDocument?.(d)}
              >
                <span className="source-dot doc" />
                <span className="source-name">{d.title}</span>
              </div>
            ))}
            {mdSources.map((s) => (
              <div
                key={s.id}
                className="source-row"
                title={s.filename}
                onClick={() => onOpenMd?.(s)}
              >
                <span className="source-dot doc" />
                <span className="source-name">{s.filename}</span>
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
