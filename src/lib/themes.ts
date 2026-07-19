export type ThemeVar =
  | "bg"
  | "panel"
  | "panel-2"
  | "panel-3"
  | "text"
  | "muted"
  | "blue"
  | "blue-bg"
  | "yellow"
  | "yellow-bg"
  | "purple"
  | "purple-bg"
  | "red"
  | "green"
  | "border";

export type ThemeVars = Record<ThemeVar, string>;

export interface Theme {
  id: string;
  name: string;
  colorScheme: "light" | "dark";
  vars: ThemeVars;
}

export const THEME_VAR_KEYS: ThemeVar[] = [
  "bg",
  "panel",
  "panel-2",
  "panel-3",
  "text",
  "muted",
  "blue",
  "blue-bg",
  "yellow",
  "yellow-bg",
  "purple",
  "purple-bg",
  "red",
  "green",
  "border",
];

const midnight: ThemeVars = {
  bg: "#0f172a",
  panel: "#1e293b",
  "panel-2": "#273449",
  "panel-3": "#334155",
  text: "#e2e8f0",
  muted: "#94a3b8",
  blue: "#3b82f6",
  "blue-bg": "#1e3a5f",
  yellow: "#eab308",
  "yellow-bg": "#42360f",
  purple: "#a855f7",
  "purple-bg": "#3a1d54",
  red: "#ef4444",
  green: "#22c55e",
  border: "#334155",
};

const candance: ThemeVars = {
  bg: "#fdf3f6",
  panel: "#fdeef0",
  "panel-2": "#f9e3ec",
  "panel-3": "#f4d7e2",
  text: "#6b4a5a",
  muted: "#a07a8c",
  blue: "#aed4f0",
  "blue-bg": "#e3f0fa",
  yellow: "#fbe59a",
  "yellow-bg": "#fdf3d4",
  purple: "#d6c0ef",
  "purple-bg": "#efe6fb",
  red: "#f5b8c0",
  green: "#b8e3c8",
  border: "#f0cdda",
};

const lilac: ThemeVars = {
  ...candance,
  bg: "#f5f0fb",
  panel: "#efe6fb",
  "panel-2": "#e7d8f7",
  "panel-3": "#ddc8f2",
  text: "#574a6b",
  muted: "#9080a8",
  border: "#ddc8f2",
};

const mint: ThemeVars = {
  ...candance,
  bg: "#f0f9f3",
  panel: "#e3f6ea",
  "panel-2": "#d4efde",
  "panel-3": "#c2e6cf",
  text: "#3f5a4a",
  muted: "#7a9a88",
  border: "#c2e6cf",
};

const sky: ThemeVars = {
  ...candance,
  bg: "#f0f6fb",
  panel: "#e3f0fa",
  "panel-2": "#d4e6f5",
  "panel-3": "#c2d8ee",
  text: "#3f526b",
  muted: "#7a90a8",
  border: "#c2d8ee",
};

const butter: ThemeVars = {
  ...candance,
  bg: "#fdf8ec",
  panel: "#fbf3d4",
  "panel-2": "#f7e9bb",
  "panel-3": "#f1dc9c",
  text: "#6b5a2e",
  muted: "#a8946a",
  border: "#f1dc9c",
};

export const THEMES: Theme[] = [
  { id: "midnight", name: "Midnight", colorScheme: "dark", vars: midnight },
  { id: "candance", name: "Candance", colorScheme: "light", vars: candance },
  { id: "candance-lilac", name: "Candance Lilac", colorScheme: "light", vars: lilac },
  { id: "candance-mint", name: "Candance Mint", colorScheme: "light", vars: mint },
  { id: "candance-sky", name: "Candance Sky", colorScheme: "light", vars: sky },
  { id: "candance-butter", name: "Candance Butter", colorScheme: "light", vars: butter },
];

export const DEFAULT_THEME_ID = "midnight";

export function themeById(id: string): Theme | undefined {
  return THEMES.find((t) => t.id === id);
}
