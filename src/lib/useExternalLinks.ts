import { useEffect } from "react";

export function useExternalLinks(): void {
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.(
        "a",
      ) as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.href;
      if (!href || !/^https?:/i.test(href)) return;
      e.preventDefault();
      import("@tauri-apps/api/core")
        .then(({ invoke }) => invoke("open_url", { url: href }))
        .catch(() => {
          window.open(href, "_blank", "noopener,noreferrer");
        });
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);
}
