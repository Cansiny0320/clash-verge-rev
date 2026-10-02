# Fork release CI

Approved on 2026-10-02: pushes to `dev` run checks and publish Windows x64 only when the package version exceeds the latest published stable fork release. The owner authorized committing and pushing the current upstream synchronization, updater repair and CI, and storing the existing updater signing key as a repository Actions secret.

## Release behavior

- Run frontend type checks, lint and tests, plus updater manifest regression checks on every `dev` push. Allow manual reruns on `dev`.
- Require matching stable versions in `package.json`, `Cargo.lock`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- Skip publishing an unchanged or older version. Never replace the assets of a published version.
- Build a signed Windows x64 NSIS installer using the existing Rust, pnpm and prebuild setup. Preserve the current fork public key and updater URL.
- Verify the manifest with Tauri's actual parser and verify the installer signature before publishing. Publish complete release assets before promoting `updater/update.json`.
- Serialize releases and reject stale commits before promotion. A failed build leaves the existing update channel intact. A retry may recover an unpublished draft; it must not overwrite a published release.
- Use a fork-specific signing secret so legacy upstream workflows do not gain access to it. The secret stays out of source, logs and artifacts.

## Review findings

The inherited release workflow requires a version tag reachable from `main`; the working branch is `dev`. The inherited updater workflow is manual. Neither implements the approved branch-push contract. The current manifest erroneously includes both `version` and its Tauri alias `name`; actual Tauri parsing rejects it. The repaired canonical manifest contains `version` only. GitHub asset caches can temporarily serve an older manifest after replacement, so acceptance requires the canonical URL and the installed client to read back the new state.

Scope is Windows x64 with the normal WebView2 installer. No new macOS/Linux signing, upstream publication, Telegram notifications, or per-push version invention. The existing stable 2.5.5 installation is the upgrade starting point; 2.5.6 is the first CI release.

## Acceptance and rollback

The first authorized push must finish successfully, publish signed 2.5.6 assets from that exact commit and advertise them through the existing updater URL. The installed 2.5.5 client must find the release; after installation the client and executable must report 2.5.6 and a subsequent update check must report no newer version. Retain a pre-upgrade local backup. If promotion fails, keep or restore the previous manifest. Do not lower installed versions automatically.
