// Tauri (Rust) shell.
//
// Responsibilities:
//   - window + IPC bridge to the React frontend
//   - OWN the Bun sidecar process: spawn it, learn its port from stdout, and
//     hand that port to the frontend over IPC. Tauri-ownership means each app
//     instance gets its own sidecar on its own free port — so multi-instance
//     ("open another project") just works, and the frontend never guesses.
//   - OS keychain access for API keys (secrets never touch the visible
//     Dissertator/ folder)
//   - dialog + filesystem plugins

use keyring::Entry;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tokio::sync::watch;

const SERVICE: &str = "dissertator";

/// Holds the spawned sidecar child plus a watch channel the frontend polls to
/// learn the port. `port_rx` yields `None` until the sidecar prints its ready
/// handshake, then `Some(port)` for the process's lifetime.
struct SidecarState {
    port_rx: watch::Receiver<Option<u16>>,
    child: Mutex<Option<Child>>,
}

/// Build the command that launches the sidecar.
///
/// - **Debug (dev):** `bun run <root>/sidecar/src/index.ts` — no compile step,
///   edits land on the next `tauri dev`. Multi-instance: the 2nd app's sidecar
///   finds 4319 busy and binds 4320; we read whichever port back from stdout.
/// - **Release:** the bundled `dissertator-sidecar` binary (built upstream by
///   `bun build --compile`, placed next to the executable / in resources).
fn sidecar_command(workspace_root: &Path, resource_dir: Option<&Path>) -> Option<Command> {
    if cfg!(debug_assertions) {
        let mut cmd = Command::new("bun");
        cmd.arg("run")
            .arg(workspace_root.join("sidecar").join("src").join("index.ts"))
            // cwd = workspace root so `@dissertator/shared` workspace import resolves.
            .current_dir(workspace_root);
        return Some(cmd);
    }

    let name = if cfg!(windows) {
        "dissertator-sidecar.exe"
    } else {
        "dissertator-sidecar"
    };
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(rd) = resource_dir {
        candidates.push(rd.join(name));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(name));
        }
    }
    for c in candidates {
        if c.exists() {
            return Some(Command::new(c));
        }
    }
    eprintln!(
        "[dissertator] bundled sidecar binary '{name}' not found; \
         the backend will be unavailable. Build it with \
         `bun --filter sidecar build` and place it as \
         src-tauri/binaries/dissertator-sidecar-<target-triple> before `tauri build`."
    );
    None
}

/// Spawn the sidecar, wire its stdout into a port-discovery watch channel, and
/// return the (receiver, child). On any failure, returns a dead channel so the
/// frontend's health poll degrades to "down" rather than crashing the app.
fn spawn_sidecar(app: &tauri::App) -> (watch::Receiver<Option<u16>>, Option<Child>) {
    // CARGO_MANIFEST_DIR is `.../src-tauri` at compile time → its parent is the
    // workspace root (dev only; unused in release).
    let workspace_root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let resource_dir = app.path().resource_dir().ok();

    let mut cmd = match sidecar_command(&workspace_root, resource_dir.as_deref()) {
        Some(c) => c,
        None => {
            let (_tx, rx) = watch::channel(None);
            return (rx, None);
        }
    };

    // Release only: point the sidecar at Tauri's bundled native resources.
    //   - LD_LIBRARY_PATH / PATH  → onnxruntime's (bun-extracted) .node finds
    //     libonnxruntime.so.1 / onnxruntime.dll in the resource dir
    //   - DISSERTATOR_GRANITE_DIR  → granite ONNX + tokenizer (sidecar local.ts)
    //   - DISSERTATOR_VEC0_PATH    → sqlite-vec vec0 lib (sidecar project.ts)
    // `bun build --compile` bundles JS but NOT native .so/.dll, so without
    // this the release binary can't load onnxruntime or sqlite-vec. Dev is
    // untouched — it resolves everything from node_modules.
    #[cfg(not(debug_assertions))]
    if let Some(rd) = resource_dir.as_deref() {
        let native = rd.join("native");
        cmd.env("DISSERTATOR_RESOURCE_DIR", rd);
        cmd.env(
            "DISSERTATOR_GRANITE_DIR",
            rd.join("granite-embedding-97m-multilingual-r2"),
        );
        let vec_name = if cfg!(windows) {
            "vec0.dll"
        } else if cfg!(target_os = "macos") {
            "vec0.dylib"
        } else {
            "vec0.so"
        };
        cmd.env("DISSERTATOR_VEC0_PATH", native.join(vec_name));
        // Dynamic-linker search path so the .node resolves its native lib.
        #[cfg(target_os = "windows")]
        {
            let prev = std::env::var("PATH").unwrap_or_default();
            cmd.env(
                "PATH",
                if prev.is_empty() {
                    native.display().to_string()
                } else {
                    format!("{};{}", native.display(), prev)
                },
            );
        }
        #[cfg(not(target_os = "windows"))]
        {
            let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            cmd.env(
                "LD_LIBRARY_PATH",
                if prev.is_empty() {
                    native.display().to_string()
                } else {
                    format!("{}:{}", native.display(), prev)
                },
            );
        }
    }

    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[dissertator] failed to spawn sidecar: {e}");
            let (_tx, rx) = watch::channel(None);
            return (rx, None);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, rx) = watch::channel(None::<u16>);

    // Read stdout until EOF, parsing the `{"sidecar":"ready","port":N}` line.
    // We keep draining (not just the first line) so the pipe never fills and
    // blocks the child.
    if let Some(out) = stdout {
        let tx_ready = tx.clone();
        thread::spawn(move || {
            for line in std::io::BufReader::new(out).lines().flatten() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                    if v.get("sidecar").and_then(|x| x.as_str()) == Some("ready") {
                        if let Some(p) = v.get("port").and_then(|x| x.as_u64()) {
                            let _ = tx_ready.send(Some(p as u16));
                        }
                    }
                }
            }
        });
    }
    // Mirror sidecar stderr into our stderr so its logs are visible in one place.
    if let Some(err) = stderr {
        thread::spawn(move || {
            for line in std::io::BufReader::new(err).lines().flatten() {
                eprintln!("[sidecar] {line}");
            }
        });
    }

    (rx, Some(child))
}

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

/// The port the sidecar bound. Returns `null` if it hasn't reported (or failed
/// to start) within a short grace window — the frontend then shows its usual
/// "sidecar down" state and retries via its health poll.
#[tauri::command]
async fn sidecar_port(state: tauri::State<'_, SidecarState>) -> Result<Option<u16>, String> {
    let mut rx = state.port_rx.clone();
    // `select!` pins both futures on the stack, which lets `wait_for` keep its
    // `&mut rx` borrow across the await (an inline `timeout(wait_for(..))`
    // trips the borrow checker here).
    let port = tokio::select! {
        res = rx.wait_for(|v| v.is_some()) => res.ok().and_then(|v| *v),
        _ = tokio::time::sleep(Duration::from_secs(8)) => None,
    };
    Ok(port)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let (port_rx, child) = spawn_sidecar(app);
            app.manage(SidecarState {
                port_rx,
                child: Mutex::new(child),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_secret,
            set_secret,
            delete_secret,
            sidecar_port,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Dissertator");

    // Kill the sidecar when the app exits so we don't leak a listening process.
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<SidecarState>() {
                if let Ok(mut guard) = state.child.lock() {
                    if let Some(mut child) = guard.take() {
                        let _ = child.kill();
                        let _ = child.wait();
                    }
                }
            }
        }
    });
}
