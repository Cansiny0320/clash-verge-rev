# Implementation plan

1. Backend: add `src-tauri/src/cmd/speedtest/`, register commands in `cmd/mod.rs` and `lib.rs`. Reuse runtime configuration, provider assets and Mihomo executable resolution. Build an isolated runtime, run one cancellable download queue, and emit progress via Tauri Channel. Tests must prove no production listener/TUN/port leakage, correct provider selection and cleanup, and transfer limits/error handling.
2. Frontend: add `src/services/speedtest.ts` and a shared speed result component. Connect only the manual group button through `proxy-groups.tsx` / `proxy-group-tools.tsx`, keep automatic latency jobs unchanged. Render speed beside latency in both node layouts. Cover cancellation, late events and group/profile identity using Vitest.
3. Settings: add `download_test_url` to Rust/TypeScript settings and `misc-viewer.tsx`; add localized speed statuses and settings labels, regenerate i18n types. Validate the URL before saving and again in Rust.
4. Updates: centralize fork release constants, replace app update sources (including alpha and fixed WebView2), adapt manifest/release scripts, generate a local signing key outside the repository and configure its public key. Document required release secrets without writing them remotely. Verify source consistency and unpublished-source handling.
5. Validation: install locked dependencies without Git hooks; run targeted tests, `pnpm typecheck`, `pnpm lint`, affected-file formatting checks, `pnpm web:build`, `cargo fmt --all -- --check`, targeted Rust tests and repository Clippy if available. Dependency installs and builds write caches/artifacts; prebuild downloads application resources; none deploy or install the app. Inspect the UI with a controlled fixture if native launch is unavailable. Real traffic checks must stay bounded and must not alter the user's active proxy.

Risks: provider caches may live with the service, TUN could intercept a secondary core, public test servers may reject traffic, and inherited CI requires signing/platform secrets. Resolve these in implementation or report the concrete limitation. Never downgrade TLS validation or fabricate a throughput result.

Rollback: revert only this task's files, retain unrelated changes, and remove only task-owned temporary files/processes. Local private signing material is separate from source and should be retained for subsequent releases. No Git history or remote operation is part of rollback.

## Validation completed on 2026-09-21

- `node node_modules/vitest/vitest.mjs run`: 14 tests passed across six files.
- `node --test scripts/fork-updates.test.mjs`: two tests passed.
- `node node_modules/typescript/bin/tsc --noEmit`: passed.
- `node node_modules/eslint/bin/eslint.js -c eslint.config.ts --max-warnings=0 --cache --cache-location .eslintcache src`: passed.
- Biome format checks for all 50 changed JavaScript/TypeScript/JSON files and `cargo fmt --all -- --check`: passed.
- `node node_modules/vite/bin/vite.js build`: production frontend build passed.
- `cargo clippy -p clash-verge --features clippy --locked -j 4 -- -D warnings`: passed.
- With `VERGE_TEST_CORE` pointing to the existing bundled Mihomo, `cargo test -p clash-verge --features clippy --locked -j 4 speedtest -- --include-ignored`: seven tests passed, none ignored. Coverage includes isolated configuration, provider identity, real-core routing between same-named local proxy nodes, process/config cleanup, HTTP/HTML/empty-body errors, 50 MB cutoff and a stalled stream's five-second cutoff.
- A local file signed by the fork's private key was independently verified against the public key pinned in the app configuration.
- Browser inspection of actual group tools and both card components with mocked Tauri responses confirmed start, stop, queue/result states, MB/s labels and dark/narrow layout. The temporary fixture and server were removed. Existing single-row card markup emits a nested `div`/`p` warning; this pre-existing markup was not changed.

The initial validation above used local mock proxies and no subscription download traffic. Installation and bounded real subscription testing were subsequently authorized by the owner; the follow-up validation below supersedes the initial installation/testing limits. Remote secrets, commits, pushes and releases remain untouched.

## Installation follow-up on 2026-09-21

- Backed up the original application and configuration under `target/installation-backup-20260921/` before installing to the owner-specified `D:\software\Clash Verge`.
- The first native UI test exposed TUN interception of the isolated test core. Those initial speed values were discarded. Added `src-tauri/src/cmd/speedtest/egress.rs` to bind a safe outbound interface without changing production routes or selections.
- Regression coverage now includes combined route/interface metric selection, exclusion of the active TUN/virtual/loopback interfaces, preservation of explicit outbound selection, failure when no safe default exists, and native Windows route discovery. All ten speed test tests passed with `--include-ignored`, including real bundled Mihomo/local proxy routing; `cargo fmt --all -- --check` and `cargo clippy -p clash-verge --lib --features clippy --locked -j 4 -- -D warnings` passed.
- Before repackaging, a bounded real download using the installed Mihomo with explicit physical egress returned HTTP 200 and received 38,400,192 bytes in ten seconds. Windows socket inspection confirmed the outbound interface was `以太网` while production TUN remained enabled. This was a diagnostic test, not the final GUI measurement.
- The installed app's actual Check updates button displayed the translated `Cansiny0320` update-source-unavailable message. A published update cycle remains untested because no fork release has been published.
- The corrected optimized Release installer completed and its updater signature was independently verified. Installer SHA-256: `3c5f44e40ab8e31e5e7a29895fe655e4145ce07cfe82a4033c42f4d14d3b0790`. The first same-version installation attempt returned zero but retained the old executable; after the app had exited, a second installation replaced it successfully. Verification compared every byte against the new build, allowing only Tauri's expected `UNK` to `NSS` bundle marker. Installed executable SHA-256: `A9E4F035E96124CA91D9652067CA8FD986610BC407CDA1B1571E5F53358EAE37`.
- Final native GUI test: the original group button completed four entries before cancellation. The first selected Hong Kong node measured 52 ms / 19.86 MB/s; other samples measured 0.14–0.33 MB/s. These are individual samples to Cloudflare, not maximum line rates.
- During that GUI run, Windows socket inspection recorded the test core on the physical Ethernet interface, with no TUN connections observed. Clicking Stop restored the start button and left zero temporary test processes/directories. Core API readback retained rule mode, TUN enabled and the original main selection.
- The own-fork update manifest returned HTTP 404, consistent with the native unavailable-source message. Existing subscription/settings backups remain at `target/installation-backup-20260921/`; no remote publication occurred.

## v2.5.5 publication follow-up

The owner explicitly authorized GitHub publication. Added the single-node latency/download entry point and regression tests for provider identity, preserving existing results and not interrupting active batches. All 16 frontend tests, two updater tests, TypeScript, changed-file ESLint and formatting checks passed before the signed Windows x64 build. Publication must include matching source, installer, signature and the stable update manifest.
