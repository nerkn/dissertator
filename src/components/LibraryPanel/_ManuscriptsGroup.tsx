import { useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { SourceFile } from "@dissertator/shared";

interface Props {
  mdSources: SourceFile[];
  onOpen?: (src: SourceFile) => void;
  onNewDocument?: () => void;
}

export function ManuscriptsGroup({ mdSources, onOpen, onNewDocument }: Props) {
  const [open, setOpen] = useState(false);

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
