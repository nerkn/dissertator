
## P9 — Keychain: make Cargo features cross-platform (Linux/macOS/Windows)

`src-tauri/Cargo.toml` currently enables `sync-secret-service` +
`apple-native` + `windows-native` + `crypto-rust` all at once. The cfg gating
in keyring 3.6.3 (src/lib.rs ~200-310) means **only the feature matching the
build target is actually used as `default`** — but the macOS dep
(`security-framework`) and Windows dep (`windows-sys`) are still compiled
into the dependency graph on every target, and `security-framework` will
**fail to build on Windows**.

Options to verify before shipping:
1. Per-platform features via target-specific deps:
   ```toml
   [target.'cfg(target_os = "linux")'.dependencies]
   keyring = { version = "3", features = ["sync-secret-service", "crypto-rust"] }
   [target.'cfg(target_os = "macos")'.dependencies]
   keyring = { version = "3", features = ["apple-native"] }
   [target.'cfg(target_os = "windows")'.dependencies]
   keyring = { version = "3", features = ["windows-native"] }
   ```
2. Or test whether enabling all three compiles cleanly on each target in CI.

**Verify on Linux (done):** `sync-secret-service` + `crypto-rust` writes to
real gnome-keyring (confirmed via DBus SearchItems = 1).
**TODO:** confirm `apple-native`/`windows-native` are harmless to enable on
other targets, or switch to target-conditional deps.

While here: the in-memory `keys` map in `src/App.tsx` (the "merge instead of
replace" fix) should stay as a defensive fallback for `dev:web` (no Tauri
runtime) and for a locked keyring session.
