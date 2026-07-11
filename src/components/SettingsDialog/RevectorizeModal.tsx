import { Warning, X } from "@phosphor-icons/react";

/** Confirm modal before an embed binding change re-vectorizes the corpus. */
function RevectorizeModal({
  onCancel,
  onConfirm,
  busy,
}: {
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <div className="overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h2>
            <Warning size={18} /> Re-vectorize everything?
          </h2>
          <button className="icon-btn" onClick={onCancel} title="Close">
            <X size={18} />
          </button>
        </div>
        <div className="settings-tab-body">
          <p>
            You changed the <strong>Embed</strong> provider or model. Vector
            dimensions change, so <strong>all chunks must be re-embedded</strong>:
          </p>
          <ul className="muted small">
            <li>every chunk is reset to "pending"</li>
            <li>the vector index is rebuilt</li>
            <li>this costs API calls and runs in the background</li>
          </ul>
          <p className="muted small">
            Chats, notes, and source text are NOT touched.
          </p>
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? "re-vectorizing…" : "Re-vectorize"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { RevectorizeModal };
