import { invoke } from "@tauri-apps/api/core";

// Secrets (API keys) are stored in the OS keychain via Rust (keyring crate),
// never in the visible Dissertator/ folder.
export const ipc = {
  getSecret: (user: string) => invoke<string | null>("get_secret", { user }),
  setSecret: (user: string, value: string) =>
    invoke<void>("set_secret", { user, value }),
  deleteSecret: (user: string) =>
    invoke<void>("delete_secret", { user }),
};
