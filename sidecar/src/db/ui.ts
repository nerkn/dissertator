// Working-docs persistence (UI tabs).

import { current } from "./_core.ts";

export interface UiTab {
  sourceId: string;
  kind: string;
  title: string;
}

export function getUiTabs(): { tabs: UiTab[]; activeTabId: string | null } {
  if (!current) return { tabs: [], activeTabId: null };
  const tabsRaw = current.db
    .prepare("SELECT value FROM settings WHERE key = 'ui_open_tabs'")
    .get() as { value?: string } | null;
  const activeRaw = current.db
    .prepare("SELECT value FROM settings WHERE key = 'ui_active_tab'")
    .get() as { value?: string } | null;
  let tabs: UiTab[] = [];
  if (tabsRaw?.value) {
    try {
      const parsed = JSON.parse(tabsRaw.value);
      if (Array.isArray(parsed)) {
        tabs = parsed.filter(
          (t): t is UiTab =>
            t &&
            typeof t.sourceId === "string" &&
            typeof t.kind === "string" &&
            typeof t.title === "string",
        );
      }
    } catch {
      /* corrupt — treat as empty */
    }
  }
  const activeTabId = activeRaw?.value ?? null;
  return { tabs, activeTabId };
}

export function setUiTabs(tabs: UiTab[], activeTabId: string | null): void {
  if (!current) return;
  const upsert = current.db.prepare(
    "INSERT INTO settings(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  upsert.run("ui_open_tabs", JSON.stringify(tabs));
  upsert.run("ui_active_tab", activeTabId ?? "");
}
