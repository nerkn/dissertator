// Tauri (Rust) shell.
//
// Responsibilities:
//   - window + IPC bridge to the React frontend
//   - OWN the Bun sidecar process: spawn it, learn its port from stdout, and
//     hand that port to the frontend over IPC. Tauri-ownership means each app
//     instance gets its own sidecar on its own free port — so multi-instance
//     ("open another project") just works, and the frontend never guesses.
//   - dialog + filesystem plugins

use std::io::BufRead;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use tauri::{Manager, RunEvent};
use tokio::sync::watch;

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

/// Best-effort path for the sidecar log, in a per-OS app/log dir. Returns
/// None if no home/app-data dir is resolvable.
fn sidecar_log_path() -> Option<PathBuf> {
    let base = if cfg!(target_os = "windows") {
        std::env::var_os("APPDATA").map(PathBuf::from)
    } else if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library").join("Logs"))
    } else {
        std::env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|h| PathBuf::from(h).join(".local").join("state"))
            })
    }?;
    Some(base.join("Dissertator").join("sidecar.log"))
}

/// Open (append) the sidecar log file and write a launch header. None on any
/// failure so the caller falls back to a piped stderr.
fn sidecar_log_file() -> Option<std::fs::File> {
    use std::io::Write;
    let path = sidecar_log_path()?;
    let parent = path.parent()?;
    let _ = std::fs::create_dir_all(parent);
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let _ = writeln!(f, "\n==== dissertator sidecar launch @ {secs} ====");
    eprintln!("[dissertator] sidecar log file: {}", path.display());
    Some(f)
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
    //   - LD_LIBRARY_PATH / PATH  → onnxruntime's .node finds
    //     libonnxruntime.so.1 / onnxruntime.dll in the resource dir
    //   - DISSERTATOR_GRANITE_DIR  → granite ONNX + tokenizer (sidecar local.ts)
    //   - DISSERTATOR_VEC0_PATH    → sqlite-vec vec0 lib (sidecar project.ts)
    // `bun build --compile` bundles JS but NOT native .so/.dll, so without
    // this the release binary can't load onnxruntime or sqlite-vec. Dev is
    // untouched — it resolves everything from node_modules.
    //
    // We probe several `native/` roots (resource dir, exe dir, exe sibling)
    // and only set an env var to a path that actually EXISTS. This covers
    // installed apps, portable runs, and the case where Tauri's
    // `resource_dir()` resolves to a different root than expected — and it
    // stops the sidecar falling through to `getLoadablePath()`, which throws
    // "sqlite-vec ... not found" inside a compiled binary (the bug that left
    // embeddings silently disabled on Windows).
    #[cfg(not(debug_assertions))]
    {
        let vec_name = if cfg!(windows) {
            "vec0.dll"
        } else if cfg!(target_os = "macos") {
            "vec0.dylib"
        } else {
            "vec0.so"
        };

        let mut native_dirs: Vec<PathBuf> = Vec::new();
        // For each anchor (resource dir + exe dir) check the layouts Tauri
        // actually uses across MSI/NSIS/AppImage: bare `native/`, and
        // `resources/native/`. Probing all of them makes the search robust to
        // whichever install layout the user ended up with.
        let mut anchors: Vec<PathBuf> = Vec::new();
        if let Some(rd) = resource_dir.as_deref() {
            anchors.push(rd.to_path_buf());
            cmd.env("DISSERTATOR_RESOURCE_DIR", rd);
            cmd.env(
                "DISSERTATOR_GRANITE_DIR",
                rd.join("granite-embedding-97m-multilingual-r2"),
            );
        }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                anchors.push(dir.to_path_buf());
                anchors.push(dir.join("resources"));
            }
        }
        for a in &anchors {
            native_dirs.push(a.join("native"));
            native_dirs.push(a.clone());
        }

        // vec0 lib: first native dir that actually contains it.
        let mut vec_set = false;
        for nd in &native_dirs {
            let candidate = nd.join(vec_name);
            if candidate.exists() {
                cmd.env("DISSERTATOR_VEC0_PATH", &candidate);
                vec_set = true;
                break;
            }
        }
        if !vec_set {
            eprintln!(
                "[dissertator] vec0 native lib '{vec_name}' not found in any \
                 candidate dir; sqlite-vec (embeddings) will be unavailable. \
                 Searched: {}",
                native_dirs
                    .iter()
                    .map(|d| d.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }

        // Dynamic-linker search path so onnxruntime's .node resolves its lib.
        // Include every existing native dir so a portable layout still works.
        let existing: Vec<String> = native_dirs
            .iter()
            .filter(|d| d.exists())
            .map(|d| d.display().to_string())
            .collect();
        #[cfg(target_os = "windows")]
        if !existing.is_empty() {
            let prev = std::env::var("PATH").unwrap_or_default();
            let joined = existing.join(";");
            cmd.env("PATH", if prev.is_empty() { joined } else { format!("{joined};{prev}") });
        }
        #[cfg(not(target_os = "windows"))]
        if !existing.is_empty() {
            let prev = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
            let joined = existing.join(":");
            cmd.env("LD_LIBRARY_PATH", if prev.is_empty() { joined } else { format!("{joined}:{prev}") });
        }
    }

    // Suppress the lingering black console window on Windows. The bundled
    // sidecar is a console-subsystem binary (bun build --compile); without
    // CREATE_NO_WINDOW Windows allocates a fresh console for the child, which
    // is exactly the stray black cmd box users see on first run.
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    cmd.stdout(Stdio::piped());
    // Capture the sidecar's stderr to a log file. Its console is now hidden
    // (CREATE_NO_WINDOW) and the parent is a GUI app with no console, so a
    // piped stderr would vanish entirely — leaving sqlite-vec / onnxruntime
    // load failures invisible. Best-effort: fall back to a pipe if the file
    // can't be opened.
    cmd.stderr(match sidecar_log_file() {
        Some(f) => Stdio::from(f),
        None => Stdio::piped(),
    });

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
        // The compiled sidecar binary is large (~100 MB); its cold start on
        // Windows (especially with AV scanning) can exceed the old 8s grace.
        // 20s gives margin while the watch still returns immediately once the
        // sidecar actually reports its port — this is only the ceiling.
        _ = tokio::time::sleep(Duration::from_secs(20)) => None,
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
