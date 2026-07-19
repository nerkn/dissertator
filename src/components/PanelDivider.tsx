import { useCallback, useRef } from "react";

export function PanelDivider({
  onDelta,
  label,
}: {
  onDelta: (delta: number) => void;
  label: string;
}) {
  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      (e.target as HTMLDivElement).setPointerCapture(e.pointerId);
      const startX = e.clientX;
      let lastX = startX;
      let dragging = true;

      const onMove = (ev: PointerEvent) => {
        if (!dragging) return;
        const x = ev.clientX;
        onDelta(x - lastX);
        lastX = x;
      };
      const onUp = (ev: PointerEvent) => {
        dragging = false;
        try {
          (e.target as HTMLDivElement).releasePointerCapture(ev.pointerId);
        } catch {
          /* already released */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.classList.remove("dragging-col");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.classList.add("dragging-col");
    },
    [onDelta],
  );

  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      className="col-divider"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onPointerDown={onPointerDown}
    >
      <span className="col-divider-grip" />
    </div>
  );
}
