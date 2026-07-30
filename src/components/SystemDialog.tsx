// SystemDialog — the single renderer for the promise-backed dialog store
// (see src/lib/stores/dialogs.ts). Mounted once in App. Handles prompt /
// confirm / alert, plus Escape-to-cancel and click-backdrop-to-cancel, so it
// feels like the native boxes it replaces.
//
// Reuses .overlay / .dialog / .field / .actions from settings.css; the only
// addition is .dialog-message (overlays.css) for the body text.

import { useEffect, useRef, useState } from "react";
import { useDialogStore } from "../lib/stores/dialogs";

export function SystemDialog() {
  const current = useDialogStore((s) => s.current);
  const resolve = useDialogStore((s) => s.resolve);

  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);

  // Reset the input + move focus when a new dialog opens.
  useEffect(() => {
    if (!current) return;
    if (current.kind === "prompt") {
      setValue(current.defaultValue ?? "");
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
    // confirm/alert: focus the primary action so Enter confirms.
    const id = requestAnimationFrame(() => okRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [current?.id]);

  // Escape cancels the current dialog whatever its kind.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  if (!current) return null;

  const ok = () => {
    if (current.kind === "prompt") resolve(value);
    else if (current.kind === "confirm") resolve(true);
    else resolve(null);
  };
  const cancel = () => {
    // prompt/alert/select → null/void; confirm → false.
    resolve(current.kind === "confirm" ? false : null);
  };
  const pick = (id: string) => resolve(id);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div
        className="dialog system-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={current.title}
      >
        <div className="dialog-head">
          <h2>{current.title}</h2>
        </div>
        {current.message && (
          <p className="dialog-message">{current.message}</p>
        )}
        {current.kind === "prompt" && (
          <label className="field">
            {current.label && <span>{current.label}</span>}
            <input
              ref={inputRef}
              value={value}
              placeholder={current.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  ok();
                }
              }}
            />
          </label>
        )}
        {current.kind === "select" && (
          <div className="dialog-options">
            {(current.options ?? []).map((opt) => (
              <button
                key={opt.id}
                type="button"
                className="dialog-option"
                onClick={() => pick(opt.id)}
              >
                <span className="dialog-option-label">{opt.label}</span>
                {opt.description && (
                  <span className="dialog-option-desc">{opt.description}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="actions">
          {current.kind === "alert" || current.kind === "select" ? null : (
            <button className="btn ghost" onClick={cancel}>
              {current.cancelLabel ?? "Cancel"}
            </button>
          )}
          <button
            ref={okRef}
            className={`btn ${current.destructive ? "danger" : "primary"}`}
            onClick={ok}
            style={current.kind === "select" ? { display: "none" } : undefined}
          >
            {current.okLabel ?? "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
