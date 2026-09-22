# hakuro session recovery

Goal: finish the interrupted rename, source selector, settings, SQLite cache, icon, and packaging documentation.

Acceptance:
- [x] English UI offers per-track source choice and Settings; Refresh has distinct cache-bypass behavior.
- [x] Client ID, provider order/enabled state, colors and follow preference persist beside executable.
- [x] SQLite stores downloaded lyrics and track source preferences beside executable.
- [x] hakuro naming and supplied icon included; README explains setup/build/deployment.
- [x] Frontend build/tests and Rust tests pass; independent review completed.

Known: prior session has unstaged Rust changes and staged legacy Python deletions. Preserve these. Historical HEAD handoff describes obsolete Python implementation.
Open questions: none; preserve English UI. Keep both Refresh and source selector because they serve different actions.

Ownership: main = frontend/integration; backend agent = Rust/Cargo; packaging agent = README/lock/config/icons/gitignore.
Progress: implementation complete. Rust tests: 53 passed / 1 ignored live-provider probe. Frontend: 14 tests passed, production build passed. Independent UI review found an IPC track-switch race; corrected by sending and validating the selected track key. Final release/NSIS build succeeded after all source changes.

Artifacts: app/src-tauri/target/release/hakuro.exe and app/src-tauri/target/release/bundle/nsis/Hakuro_4.0.0_x64-setup.exe.
Native smoke: final release launched; Orca accessibility tree confirmed first-run Settings dialog, all five provider choices, color fields, Save/Cancel, and executable-relative data folder. No credentials entered or settings saved. App left open for user setup.

Keep: production storage must remain executable-relative (no environment override). Rust settings tests use thread-local paths to avoid parallel test interference. Subscribe to Tauri events before connecting. Same-song source changes need request-version guards in addition to track generation guards.

Not verified: real Spotify authorization/playback and live provider availability require user account interaction. NSIS installer was built but not installed. Build has an existing unused Rust active_line warning.
