import type { Settings, SettingsPatch } from "@dissertator/shared";
import { req } from "./_client";

export const settingsApi = {
  getSettings: () => req<Settings>("/settings"),
  saveSettings: (patch: SettingsPatch) =>
    req<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
};
