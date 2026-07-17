import { invoke } from "@tauri-apps/api/core";

export const ipc = {
  /** The port Tauri's sidecar bound; `null` if unavailable (or under web). */
  sidecarPort: () => invoke<number | null>("sidecar_port"),
};
