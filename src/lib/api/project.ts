import type {
  HealthResponse,
  InitProjectResponse,
  ProjectStatus,
} from "@dissertator/shared";
import { req } from "./_client";

export const projectApi = {
  health: () => req<HealthResponse>("/health"),
  initProject: (path: string) =>
    req<InitProjectResponse>("/project/init", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  projectStatus: () => req<ProjectStatus>("/project/status"),

  // --- Working-docs persistence (UI tabs) ----------------------------------

  getUiTabs: () =>
    req<{ tabs: Array<{ sourceId: string; kind: string; title: string }>; activeTabId: string | null }>("/ui/tabs"),
  saveUiTabs: (
    tabs: Array<{ sourceId: string; kind: string; title: string }>,
    activeTabId: string | null,
  ) =>
    req<{ ok: true }>("/ui/tabs", {
      method: "PUT",
      body: JSON.stringify({ tabs, activeTabId }),
    }),
};
