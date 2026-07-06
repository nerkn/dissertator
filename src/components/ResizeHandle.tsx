// ResizeHandle — single bottom-right (SE) corner grip for the frameless
// window. With `decorations: false`, Windows/macOS lose the OS resize
// borders, so this is how you resize on those platforms (Linux/GTK still
// resizes via its own edges). Guarded for plain-browser (`dev:web`) mode,
// where there's no window to resize.

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function ResizeHandle() {
  if (!isTauri()) return null;

  const onMouseDown = async (e: React.MouseEvent) => {
    // Left-button only; don't hijack right/middle clicks.
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const { getCurrentWindow } = await import(
        "@tauri-apps/api/window"
      );
      // ResizeDirection is a string union ('SouthEast' | 'North' | ...),
      // not an exported enum, so we pass the literal.
      await getCurrentWindow().startResizeDragging("SouthEast");
    } catch {
      /* runtime missing or permission denied — no-op */
    }
  };

  return (
    <div
      className="resize-handle-se"
      onMouseDown={onMouseDown}
      title="Resize"
      aria-label="Resize window"
    />
  );
}
