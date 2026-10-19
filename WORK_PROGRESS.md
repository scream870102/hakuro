# hakuro session recovery

## Active task — 2026-10-19 Cube Deck redesign, v1.3.0

Goal: replace the interface with design concept A (Cube Deck, `design/concepts/a-cube.html`), bump to 1.3.0, commit, and build a local installer for the user to test.
Acceptance:
- [x] Prototype: compact "HAKURO" readable (solid header background); verified by screenshot at 560x250 and 1100x700.
- [x] App: cube with cover on the front (colour = playing, tap toggles, lens previews), volume dial with skip under VOL, record on top, tool faces; compact puts skip in the bar.
- [x] Command palette (Ctrl+K) runs real commands and jumps to lyric lines; settings shows the version from `getVersion()`.
- [x] Every existing element id and behaviour kept; frontend tests updated/extended; `npm test`, `npm run build`, `cargo test` pass.
- [x] Version 1.3.0 in tauri.conf.json, Cargo.toml/lock, package.json/lock.
- [x] Committed (no push/tag); NSIS installer built.
Known: user's stored accent is #df498a (custom), so only the default for new installs changed (#1db954 -> #e6ff1f). No SFX in the app: a lyrics window playing over music should not add sounds, and it would need a new setting.
Decisions: gestures in `deck.ts` end as clicks on the real controls (or input/change on the hidden volume range), so main.ts keeps one path per command. Cover colour follows the confirmed play state, not the tap. Record spin seeks once on release (10 s per turn). Fonts bundled via @fontsource 5.3.0 (Noto Sans JP variable adds ~5 MB). COMPACT_CHROME 108 -> 72 (32px chrome + 34px bar + hairlines + slack).
Follow-up fix (user report "lyrics never found"): backend cache showed fresh synced lyrics, so the backend worked. Real-app debugging (release exe with WEBVIEW2_USER_DATA_FOLDER + WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port, attached via CDP) showed playback trackId "" vs lyrics trackId "ytm:<name>|<duration>". Commit 74af7bd added a frontend trackId check against the backend's source-prefixed `track_key`, which the frontend rebuilt without the prefix, so every lyrics event was dropped and source/match commands failed validation. 1.2.2 predates it; 1.3.0 was the first install with it. Fix: PlaybackEvent carries `trackKey`; frontend uses it verbatim. Tests now use prefixed keys; regression test fails on the old line. Reinstalled-app issue 2 (focus/click-through) was the user's own setting; not changed.
Reusable finding: an identity shared across the IPC boundary must come from one side only; tests that mirror the same assumption on both sides cannot catch a mismatch.
Verification: headless Chrome against the built dist with a stub Tauri bridge (scratchpad `tauri-stub.js`): full 940x760, minimum 520x460, compact 460x198/258, palette, settings, lens, tap/flood, drag-to-turn. No interactive WebView2 desktop test by the assistant.

## Previous completed task — 2026-10-19 lyric search, word timing and translations

Goal: keep the existing Spotify companion integration while adding manual lyric search/preview/binding, stronger automatic fallback, word timing and provider-supplied bilingual lyrics.
Scope update: user additionally requested volume control. Add a Spotify active-device volume slider using the existing playback-control scope; SMTC/unsupported devices remain disabled without altering system master volume.
Acceptance:
- [x] Search enabled LRCLIB/NetEase/QQ sources, preview candidates, save a per-track match across restart, and restore automatic matching; stale requests cannot bind to another track.
- [x] LRCLIB search fallback and continued candidate attempts work without weakening recording identity safeguards.
- [x] Word timing and translations survive parsing, SQLite, events and full/compact rendering; old line-only caches remain readable.
- [x] Parser/provider/database/frontend regressions, build and independent review pass.
- [x] Volume 0–100 is read from Spotify, submitted on slider commit, and disabled when unsupported; errors and stale requests do not leave misleading UI.
Known: clean tracked worktree at start; untracked app/public/design-preview.html is pre-existing and must remain untouched. No Spotify playback/auth changes or commits requested. Translations come from lyric providers, not machine translation.
Ownership: root = lib.rs/db.rs/integration; hakuro_spotify = providers.rs/matching.rs; rich_lyrics = lrc.rs/petitlyrics.rs/musixmatch.rs; lyrics_ui = main.ts/main.test.ts/styles.css/index.html.
Plan: establish additive cue/candidate contracts, implement independent layers, integrate persistent overrides and race guards, then run tests and a fresh review.
Progress: complete. Final full checks: Rust 93 passed / 3 live tests ignored by default, frontend 44 passed, production frontend build and diff check passed. Independent lyric and volume reviews passed after fixes. Manual matches are stored independently of expiring cache; old JSON remains readable. Spotify auth/playback model unchanged, with one new volume endpoint using the existing scope and reported device ID. README updated; no commits or installed-app/user-configuration changes.
Live evidence: NetEase manual search returned 20 candidates per query; selected Lemon returned 42 original lines and 42 translations. The two tested anonymous v1 responses had no YRC/YTLRC; parser/word rendering are fixture-tested, but live NetEase word availability is not verified. Network sandbox could not reach the endpoints; the permitted escalated public-source probe succeeded without printing lyric bodies.
Limits: no interactive desktop playback/volume or real WebView layout test. YouTube Music SMTC does not expose volume, so its slider is disabled. Translations and word timing require provider data; no machine translation, QQ proprietary decryption or NetEase eapi integration. Translation toggle is session-only. Pre-existing app/public/design-preview.html left untouched.
Reusable findings: serialize revision validation together with DB save and event emission, not just a check before a concurrent commit. Rich timelines must preserve original lines and reserve all exact matches before approximate one-to-one pairing. Put candidate time budgets inside the loop so cancellation preserves an already downloaded fallback. Volume request/UI identity should use device ID rather than a display name.

## Previous completed task — 2026-10-02 localized lyric titles

Goal: find lyrics for Spotify's `エリーの休日` and show the matched lyric title in parentheses beside the player title when different.
Acceptance:
- [x] Live automatic/default-order and pinned NetEase lookups return 68 synced cues under `丽都假日` for the supplied Spotify recording.
- [x] Alias requires the verified Spotify ID, title, HOYO-MiX credit and duration; retries use only enabled/pinned sources. Regression and independent review passed.
- [x] Matched title survives SQLite cache migration/events/playback polls; UI clears it on track change, refresh or empty lyrics and rejects stale events.
- [x] Rust: 74 passed, 2 live tests ignored by default; targeted live regression passed. Frontend: 35 passed. `npm run build` and diff whitespace check passed; independent review completed.
Known: current title equality rejects translations; no alias lookup exists. Chinese title is 麗都假日 / 丽都假日. No user config changes or commits authorized.
Plan: verified provider metadata supplied no automatic cross-language bridge. Implement a bounded alias for this recording, then persist/display the title and test/review.
Progress: complete. Live default lookup: NetEase, title `丽都假日`, 68 cues; QQ Music returned Http but fallback succeeded. No installed app/config changes or commits.
Limits: this is a verified alias for the reported recording, not a general song-title translator. NetEase must be enabled (or pinned) for the verified successful path. Old cached lyrics without title metadata retain their original display until refreshed. No interactive desktop playback test performed.
Review decision: when a provider omits its returned title, record the successful query title, matching the user's request to show which title found the lyrics. Otherwise show the provider's actual title.
Reusable finding: same song can have different localized Spotify release IDs; title-only translation is unsafe. This recording shares HOYO-MiX and exactly 258640 ms with NetEase 3334395674; Sān-Z is credited there as 三Z-STUDIO.

## Previous completed task

Goal: add a YouTube Music playback source alongside Spotify, switchable in Settings, one active at a time.

Acceptance:
- [x] Settings offers a player choice; the Client ID field hides and stops being required when YouTube Music is chosen. Covered by two new frontend tests.
- [x] Switching players takes effect at once: the old poll loop stops, the new source reports, lyrics follow. Confirmed live by the user on 2026-09-22.
- [x] YouTube Music positions stay correct while playing and recalibrate after pause, resume, seek and track change. `smtc::position_now` is unit-tested against the measured spike values, and the user confirmed it live on 2026-09-22.
- [x] YouTube Music transport (play/pause/next/previous/seek) follows the SMTC capability flags and works. Confirmed live by the user on 2026-09-22.
- [x] Cache keys carry a source prefix so the two players cannot read each other's entries.
- [x] `cargo test` (70 passed, 1 ignored live-provider probe), `npm test` (29 passed) and `npm run build` pass.

Approach: Windows SMTC (`Windows.Media.Control`) as the second backend. No OAuth, no Client ID, and the app is Windows-only already.

Known (measured with a spike on 2026-09-22, kept at
`%TEMP%/claude/C--Project-hakuro/<session>/scratchpad/smtc-spike`):
- The blocking wait on a WinRT `IAsyncOperation` is `join()`, not `get()`.
- `PlaybackStatus`: Playing is 4 and Paused is 5, against the order the names suggest.
- A browser never refreshes `Position` while playing — it stays at the value it
  was born with, so the position has to be extrapolated from `LastUpdatedTime`.
- Pause, resume, seek and track change all refresh the anchor within 300 ms, so
  extrapolation recalibrates on every interaction.
- Spotify.exe refreshes its own anchor every 4-5 s even while paused.
- YouTube Music metadata is clean: real artist, real album, no "(Official Video)"
  noise. A plain YouTube video instead reports the channel as the artist and no album.
- At a track change the album arrives about 500 ms after the title.
- WinRT needs an apartment per thread, so the SMTC backend owns one thread.

Open questions: none.

Deferred by the user: a browser exposes one session id for every tab, so media
playing in another tab can be picked up. Left alone for now; noted as a TODO.

Shape: `player.rs` holds `PlayerKind`, the shared `Playback` and `PlayerError`,
and a `Player` enum with a per-connection serial. An enum rather than a trait
object: two backends, one alive, and no `dyn` gymnastics around async methods.
`smtc.rs` owns one thread so WinRT gets its apartment once. `spotify.rs` kept its
own error type and converts into the shared one.

Fixed along the way: dropping the client and starting a new poll loop raced, so a
switch could leave nothing polling. The poll loop now holds the polling flag
while it decides whether to stop.

Also done, beyond the list above: YouTube Music album art. SMTC hands over a
stream rather than a URL, so it is read and inlined as a data URI; without it
compact mode would show an empty square.

Progress: complete. All criteria ticked, automated checks green, live check passed.

Next, if it is ever wanted: the deferred browser-tab problem. Every tab shares
one application id, so media in another tab can be followed by mistake. A cheap
first filter would be to ignore a session with no album and a length over about
fifteen minutes, which is what a video looks like and a song does not.
