// Tauri (Rust) shell.
//
// Responsibilities:
//   - window + IPC bridge to the React frontend
//   - OS keychain access for API keys (secrets never touch the visible
//     Dissertator/ folder)
//   - dialog + filesystem plugins (folder picker; living-folder watcher arrives P1)
//
// The Bun sidecar owns the database, extraction, embeddings, and agent loop.

use keyring::Entry;

const SERVICE: &str = "dissertator";

/// Read a secret from the OS keychain. Returns `null` if none is stored.
#[tauri::command]
fn get_secret(user: String) -> Result<Option<String>, String> {
    match Entry::new(SERVICE, &user).and_then(|e| e.get_password()) {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keychain read failed: {e}")),
    }
}

/// Store (or overwrite) a secret in the OS keychain.
#[tauri::command]
fn set_secret(user: String, value: String) -> Result<(), String> {
    Entry::new(SERVICE, &user)
        .and_then(|e| e.set_password(&value))
        .map_err(|e| format!("keychain write failed: {e}"))
}

/// Delete a secret from the OS keychain (no error if it was absent).
#[tauri::command]
fn delete_secret(user: String) -> Result<(), String> {
    match Entry::new(SERVICE, &user).and_then(|e| e.delete_credential()) {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keychain delete failed: {e}")),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            get_secret,
            set_secret,
            delete_secret,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dissertator");
}
