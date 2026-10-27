# Project settings

## Rules

### Version bumps

A version bump ships with its version notes in the same change; never bump the
number alone.

1. Version fields, all equal. `.github/workflows/release.yml` refuses a tag that
   differs from `tauri.conf.json`.
   - `app/package.json` and `app/package-lock.json`: run
     `npm version <x.y.z> --no-git-tag-version` in `app/`.
   - `app/src-tauri/Cargo.toml`; `Cargo.lock` follows on the next cargo build or test.
   - `app/src-tauri/tauri.conf.json`.
2. Version notes.
   - `app/src/releases.ts`: a new entry at the top, in Traditional Chinese, dated
     today. The in-app What's new window reads it.
   - `app/src/whats-new.test.ts`: the installed version, the release expected
     open, the full version list, and the per-entry content checks.
   - `README.md`: any new or changed user-visible behavior.
   - `WORK_PROGRESS.md`: a section for the release.
   - GitHub Release notes need no edit: `release.yml` generates them from commits.
3. Verify: `npm test` and `npm run build` in `app/`, `cargo test --lib` in
   `app/src-tauri/`.
