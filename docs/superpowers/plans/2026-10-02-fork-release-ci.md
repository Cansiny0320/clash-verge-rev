# Fork release implementation plan

Approved design: `docs/superpowers/specs/2026-10-02-fork-release-ci.md`.

1. Repair `scripts/updater.mjs` and `scripts/updater-fixed-webview2.mjs` to emit one version field. Extend `scripts/fork-updates.mjs` and its existing regression tests to reject the reported alias collision. Validate and replace the existing remote 2.5.5 manifest, preserving its URLs, signatures and notes; read back the canonical URL and check the installed client's UI.
2. Add `.github/workflows/fork-release.yml` and focused release helpers under `scripts/`. Check stable version consistency and compare against the latest fork release. Run existing frontend checks on pushes; build Windows x64 only for a new version, using repository-pinned tool versions and the existing prebuild process. Publish with the workflow token, restricting write permissions to the publishing job.
3. Validate release decisions (new/same/older versions), duplicate-version rejection, recovery of incomplete publication, actual Tauri manifest parsing and installer signature verification. Use `node --test`, TypeScript/ESLint checks, Rust checks where changed, and a YAML validation tool before pushing. Preserve unrelated baseline failures.
4. Store the existing local key as the fork-specific Actions secret through stdin without printing it. Review the entire merge and task diff, commit and push `dev` without pushing upstream tags. Monitor the first CI run, fix failures within scope and verify published assets and the canonical manifest.
5. Back up the installed application and configuration, perform the authorized upgrade, read back the installed version and the real update UI, and check the latency-only menu. Preserve existing proxy selections, TUN and system proxy settings.

Commands that build, format, prebuild, publish or install have write effects and are not read-only checks. No force push, branch reset or unrelated file cleanup is planned. Rollback consists of restoring the saved channel manifest and retaining the prior installer/configuration backup; changes to the CI can be reverted with a normal follow-up commit if needed.
