import { chatsApi } from "./chats";
import { agentApi } from "./agent";
import { assetsApi } from "./assets";
import { listsApi } from "./lists";
import { notesApi } from "./notes";
import { projectApi } from "./project";
import { promptsApi } from "./prompts";
import { providersApi } from "./providers";
import { referencesApi } from "./references";
import { settingsApi } from "./settings";
import { sourcesApi } from "./sources";

export const api = {
  ...projectApi,
  ...agentApi,
  ...settingsApi,
  ...providersApi,
  ...sourcesApi,
  ...referencesApi,
  ...listsApi,
  ...notesApi,
  ...assetsApi,
  ...chatsApi,
  ...promptsApi,
};

export { resolveSidecarBase, resetSidecarBase, sidecarBase } from "./_client";
export { streamChat } from "./stream";
export type { ToolCallEvent, ToolResultEvent, EditEvent, DebugEvent } from "./events";
export type { SourceFile, SourcesResponse } from "@dissertator/shared";
export type { SourceHistoryEntry } from "./sources";
