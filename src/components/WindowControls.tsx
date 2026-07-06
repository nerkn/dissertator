// WindowControls — custom title-bar buttons for the frameless Tauri window.
//
// `decorations: false` in tauri.conf.json removes the OS chrome (title bar +
// min/max/close), so we render our own. The drag affordance itself lives on
// the `.topbar` (`data-tauri-drag-region`); these buttons are the only
// interactive window bits. All calls are guarded so the app still renders in a
// plain browser (e.g. `dev:web`) — there's no window to control there.

import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "@phosphor-icons/react";

// `window.__TAURI_INTERNALS__` is injected by the Tauri runtime. Absent in a
// normal browser tab → we hide the controls there.
function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function getWindow() {
  if (!isTauri()) return null;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow();
}

export function WindowControls() {
  const [tauri, setTauri] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    setTauri(true);
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const w = await getWindow();
        if (!w) return;
        setMaximized(await w.isMaximized());
        // onResized keeps the maximize/restore icon in sync. Wrapped so a
        // missing event-listen permission can't reject the setup promise.
        unlisten = await w.onResized(async () => {
          try {
            setMaximized(await w.isMaximized());
          } catch {
            /* ignore */
          }
        });
      } catch {
        /* runtime missing or permission denied — buttons still work */
      }
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  if (!tauri) return null;

  const minimize = async () => (await getWindow())?.minimize();
  const toggleMax = async () => (await getWindow())?.toggleMaximize();
  const close = async () => (await getWindow())?.close();

  return (
    <div className="window-controls">
      <button
        className="wc-btn"
        onClick={minimize}
        title="Minimize"
        aria-label="Minimize"
      >
        <Minus size={14} weight="bold" />
      </button>
      <button
        className="wc-btn"
        onClick={toggleMax}
        title={maximized ? "Restore" : "Maximize"}
        aria-label={maximized ? "Restore" : "Maximize"}
      >
        {maximized ? <Copy size={12} weight="bold" /> : <Square size={12} weight="bold" />}
      </button>
      <button
        className="wc-btn wc-close"
        onClick={close}
        title="Close"
        aria-label="Close"
      >
        <X size={15} weight="bold" />
      </button>
    </div>
  );
}
