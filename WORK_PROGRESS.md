# hakuro session recovery

## 1.5.3 compact lyric shards, Script initialization and design guide — 2026-10-20

Goal: suppress lyric shards while compact lyrics are hidden, initialize this project with agent-skills' Script rules, document the current design conventions, and release 1.5.3 locally.
Scope: continue the previous local release workflow (commit, tag, installer; no push). This is a hotfix plus documentation, so work stays in the current checkout. No plan-mode approval/export, worktree-pool operation or Obsidian operation is requested; no project-specific configuration for those features is needed.
Plan: verify installed local rules; add a regression for hidden lyrics and clear existing shards on layout changes; document actual tokens, components and interaction rules with source links; verify tests/browser behavior; synchronize all version fields, package and commit/tag.
Acceptance:
- [x] Run C:/Projects/agent-skills/others/install-into.ps1 -Type script -Destination C:/Projects/hakuro; sync -Check passes and all generated personal files are git-ignored.
- [x] Collapsed compact mode generates no lyric shards and immediately removes existing ones; expanded compact/full mode keep the lyric effect.
- [x] design/DESIGN_GUIDELINES.md documents current design rules and is discoverable from README.
- [x] Version fields agree on 1.5.3; relevant checks pass; local installer, commit and v1.5.3 tag exist; no push.
Known: clean tracked checkout at start. Codebase-memory/Serena tools are unavailable in this session; scoped reads cover the relevant small file set. Root cause: deck.lineChanged() has no compact-lyrics visibility guard, and compact's fixed lyrics-zone overlay stays mounted for notices/shards even with its lyrics panel closed.
Verification: initialization wrote AGENTS.override.md (6119 bytes) and installed local-rules/ plus CLAUDE.local.md; .git/info/exclude contains all three paths. The repository has no committed AGENTS.md, so the installer's local-rules-only warning is expected.
Verification: the new regression first failed on the original code with 12 shards while hidden. After the three-line visibility/cleanup fix, all 130 frontend tests pass; TypeScript/Vite production build passes; Cargo reports 141 passed / 13 ignored. Real Edge against the production bundle confirms zero hidden shards, immediate cleanup, 12 shards after both Full/expanded transitions, and no shards with reduced motion; no browser exceptions. Evidence: app/node_modules/.cache/hakuro-153/results.json and compact-*.png. Browser playback/Tauri APIs are simulated; no real player account or installed-app interaction was exercised.
Documentation: design/DESIGN_GUIDELINES.md records tokens, type, Full/Compact face placement, shared button styles, lyrics/translation layout, motion visibility, child windows and scoped acceptance checks, with 12 verified source links; README links to it.
Delivery: all six version entries are 1.5.3. Tauri/NSIS packaging passed; executable and installer both report FileVersion/ProductVersion 1.5.3. Installer: app/src-tauri/target/release/bundle/nsis/Hakuro_1.5.3_x64-setup.exe (9,734,789 bytes; SHA256 14ae7c55a0f1f734db7a57e69e0764526e9539666eb80424bcd2a6be9b6e3f77). The local v1.5.3 tag identifies the release commit; Git is the authoritative commit/tag record. No push. Personal initialization files remain ignored. No requested work remains.

## 1.5.2 UI follow-up, startup update notification and local release — 2026-10-20

Goal: finish the interrupted Claude changes for the user's eight items, verify, commit and tag 1.5.2, and build a local Windows installer. Do not push.
Known: takeover begins on main with 16 modified app files implementing most of items 1–7; version files are still 1.5.1. Preserve and finish these changes. No repository-local AGENTS.md/CLAUDE.md found. Codebase-memory tools are unavailable in this session, so use scoped local source inspection.
Open questions: none.
Plan: inspect existing changes and affected flows; fix gaps and add focused regression coverage; verify frontend, Rust and browser interactions; bump all version files and package; commit and tag locally, verify clean status and artifact metadata.
Scope update: user requested startup update checks before release completion. Include in 1.5.2: default-on persisted setting; GitHub latest stable release check; notify only when newer, with a link to the official latest GitHub Release; no download/install. Rebuild the installer after integrating this addition.
Acceptance:
- [x] Compact lyrics can be toggled through Command Palette and assigned a shortcut.
- [x] Expanded compact lyrics replace the side song/artist spine with the existing record, retaining seek preview and release behavior.
- [x] Cover hover lens shows the current play/pause action.
- [x] Full-mode Follow/Pin/Mini controls match Source/Find/Reload icon and label sizing.
- [x] Settings persist Wave strength and preview it immediately with compatible defaults.
- [x] Queue removes the source/up-next subtitle and click-to-jump instruction.
- [x] Queue Refresh has a consistent visible button and correct clickable area.
- [x] Startup checks GitHub for a newer release when enabled, shows a dismissible popup with a Release link, and stays quiet when current/offline/disabled; the setting persists.
- [x] All six version entries in five files are 1.5.2; relevant checks pass; final local executable/installer built.
Delivery: the local v1.5.2 tag identifies the release commit; Git is the authoritative commit/tag record. No push. Installer: app/src-tauri/target/release/bundle/nsis/Hakuro_1.5.2_x64-setup.exe (9,733,376 bytes; SHA256 367c5f15f8465f1284ea8de9b92d24efe68a3e0eb4720e2714727e44ff1ea49b). Executable and installer both report FileVersion/ProductVersion 1.5.2. Final Tauri build completed after the update-notification addition and popup layout fix.
Verification: 129 frontend tests passed; TypeScript/Vite production build passed; Cargo 141 passed / 13 ignored; diff whitespace check passed. Edge browser confirms cover play/pause clicks and icons, identical six full-mode control sizes, visible gain change at 10%/200%, compact record preview (30s → ~35s) with exactly one request on release, Refresh hit targets at top/middle/bottom plus an actual click, and the settings/update popup. Evidence: app/node_modules/.cache/hakuro-152/results.json, update-results.json and PNGs. Real unauthenticated GitHub latest-release GET succeeded, returning v1.5.1; local 1.5.2 correctly does not need an update.
Implementation: reuse the existing reqwest client and installed semver dependency; 8-second update request timeout; release comparison ignores build metadata and rejects drafts/prereleases/invalid versions. A fixed backend release URL opens only on the user's click. Existing settings deserialize checkUpdates=true, waveStrength=100; both persist normally.
Limits: real player accounts, system audio capture and installed-app interaction were not exercised; playback/audio and Tauri window calls in browser tests are simulated. Repository-wide cargo fmt --check reports pre-existing formatting in unrelated functions/modules; only new/changed sections are formatted.
Reusable finding: headless Edge can become hidden even with Page.bringToFront, stopping both RAF and audio capture. Enable Emulation.setFocusEmulationEnabled for deterministic active-window interaction checks; inspect hit targets in projected cube faces before interpreting a missed drag as an app failure.

## Compact translations, cube icons, bind every command — 1.5.1 — 2026-10-20

Goal (user's four points): translated compact lyrics were crowded and cut off at the bottom; the lid's lyrics icon looked like the queue icon; the back face's SOURCE/FIND glyphs were too small; every command palette entry should take a shortcut, with the settings shortcut list made collapsible. Then 1.5.1, commit and tag, no push.
Acceptance:
- [x] Translated compact rows each take a third of the face (padding absorbs the rest, from --s and --lyric-size), so the sung line and one either side fill it with no partial row; the progress bar sits below the translation; window size unchanged with translations on/off.
- [x] Lid lyrics toggle is a microphone; back-face tools draw SVG glyphs at 9% of the edge (were 4% font glyphs).
- [x] 30 shortcut actions = every palette command + `commands`, in the same order in shortcuts.ts and shortcuts.rs (test reads the Rust list); Maximize is disabled in compact. Settings list is a `<details>` (closed by default) grouped GENERAL/PLAYBACK/LYRICS/WINDOW/CUBE with a bound count; folding cancels recording.
- [x] npm, Cargo, Tauri and both lockfiles at 1.5.1; README shortcut line updated.
Verification: 118 frontend tests, Cargo 137 passed / 13 ignored, TypeScript + Vite build. Headless Edge on the built bundle with bilingual cues: three exact rows, no peeking row, bar clear of the translation and unchanged window size at 12/18/26/36px with the wave both off and on; F9 bound to turnBack turned the cube in compact and full mode; settings section renders collapsed and open with 30 rows. Real players not exercised.
Known limit: rows that wrap are taller than a third. At 18px a 14-character Japanese line still fits; at 26px+ long lines (and at 44px even 11 characters) wrap and push the neighbours partly out of view. Plain rows already wrapped sooner, so this is not new. Possible follow-up: shrink long translated lines to fit one row.
Reusable finding: a horizontal scrollbar that appears for a moment (scrollWidth 2px over clientWidth during a window resize) drops the lyric viewport's clientHeight by 10px exactly when `recentre()` runs, leaving the sung line 5px low until the next line. Compact `.lyrics` now uses `overflow-x: hidden`. When centring looks off by a few px, log clientHeight vs offsetHeight at each scrollTo call.

## Compact translations and 1.5.0 — 2026-10-20

Goal: keep compact at its original-only size, shrink rows that show translations, then bump to 1.5.0, commit and push.
Scope: release the completed wave/queue/player controls already in this workspace together with this adjustment; preserve origin/main's 1.4.1 seek preview.
Acceptance:
- [x] Translated compact rows use smaller text and fit the same cube; plain rows and full mode keep their existing typography.
- [x] Changing songs or toggling translations leaves compact geometry unchanged, including with the wave enabled.
- [x] npm, Cargo, Tauri and both lockfiles agree on 1.5.0; frontend tests, Rust tests, build and browser layout checks pass.
Delivery: user authorized committing and pushing the integrated release to origin/main. Git's main/origin/main refs are the delivery record; verify them against `git ls-remote origin refs/heads/main`.
Progress: merged origin/main's 1.4.1 seek preview with the existing wave/queue/player controls. Compact uses the original-only geometry; translated rows use 80% original type and 60% translation type with tighter spacing, and hiding translations restores the original type. README and all version fields updated.
Verification: 115 frontend tests passed; Cargo 137 passed / 13 ignored; TypeScript + Vite production build passed; staged diff whitespace check passed. Independent review passed all four criteria (typography scope, geometry, merge preservation, version consistency), with 69 focused frontend tests rerun. Browser computed-style checks passed compact sizes 12/18/44 with the wave both on and off; independent Edge rendering confirmed readable bilingual compact lyrics and unchanged full-mode typography. Screenshots and diagnostic evidence: `app/node_modules/.cache/hakuro-150/diagnose-compact.png`, `diagnose-full.png`, `diagnosis.json`. Tauri release and NSIS packaging succeeded: `app/src-tauri/target/release/bundle/nsis/Hakuro_1.5.0_x64-setup.exe`; executable FileVersion/ProductVersion both 1.5.0. Real Spotify/ytmdesktop2 accounts and system audio were not exercised in this release check.
Reusable finding: a headless CDP page can become hidden after navigation, suspending requestAnimationFrame. A blank lyric viewport with existing rows and no active line can therefore be a harness issue: call Page.bringToFront and confirm document.visibilityState plus advancing frames before judging screenshots. Wait for Page.loadEventFired between navigations and use a tolerance when comparing computed CSS floats.

## Turntable seek preview — 2026-10-20

Goal: preview the timeline and synced lyrics locally while turning the record; submit one seek on release.
Known: the record already submits only on release; the render loop shares one position for times, progress, and lyrics.
Open questions: none. User authorized implementation in this session.

- [x] Add a gesture-start anchor and cumulative preview without mutating the live playback sample.
- [x] Commit the displayed position once on release; discard on cancel, capture loss, track change, or lost seek support.
- [x] Verify timeline/lyrics preview, polling stability, request count, cancellation, and track-change behavior with regression tests (4 new cases, written and run by an independent agent).
- [x] Run frontend tests and production build (96 tests passed; TypeScript/Vite build passed; git diff --check passed).

Progress: implementation complete. Native desktop interaction has not been manually tested; DOM integration tests cover the gesture and bridge request behavior.

Release follow-up: user authorized version 1.4.1 and commit/push to the tracked origin/main.
- [x] Update npm, Cargo, Tauri, and lockfile package versions to 1.4.1.
- [x] Verify tests and build the 1.4.1 NSIS installer (96 tests passed; Tauri release build succeeded).
Delivery: commit the verified seek preview and version update, then push origin/main. Use Git's HEAD/origin/main comparison to verify delivery status.

## In progress — 2026-10-20 wave C + queue A + Spotify modes, drop SMTC, fixed compact size

User decisions (after the design canvas): wave = C tile ripple; queue window = A tilted sheet; ytmdesktop2: no shuffle/repeat buttons, no jump, queue read-only; Spotify: everything (queue, jump via N× next, shuffle, repeat); remove the SMTC player (stored "ytmusic" → ytmdesktop2); compact window must not change size with/without translations; wave audio = whole-system loopback.
Placement (user's words): "上一首下一首移到封面 封面hover會有上下一首的按鈕 其他則是播放暫停 full mode 下 disc 一樣有seek 然後佇列放到disc 裡面 一樣hover顯示 隨機循環放在底部傳輸列 然後精簡一樣封面有播放暫停上下一首 佇列隨機循環頂部 波動一律放在設定 可以分別設定full compact開關 然後可以在command palette設定上述功能".
Acceptance:
- [x] SMTC gone: no PlayerKind::Ytmusic / smtc.rs / settings option; settings.json with "ytmusic" loads as ytmdesktop2 keeping every other value (test); split_artists kept for lyric matching; unused windows features dropped; README updated.
- [x] Spotify: sample carries shuffle + repeat (off/context/track) and whether each may toggle; set_shuffle / set_repeat commands; get_queue (now + upcoming: title, artists, duration, art, uri); jump = re-read queue, find the uri, POST next index+1 times; errors surface as notices.
- [x] ytmdesktop2: get_queue from /nav/queue, upcoming = items after the playing videoId, titles only, read-only; no shuffle/repeat fields.
- [x] Controls: cover hover shows prev/next (both modes), elsewhere tap = play/pause; dial skip removed; full: disc keeps spin-seek, queue button in the disc centre on hover; shuffle/repeat in the transport bar; compact lid row 2 = queue/shuffle/repeat (lid row 1 unchanged); controls the player lacks are hidden.
- [x] Queue window (A): own transparent window with the tilted 3D sheet; now + upcoming; Spotify rows jump, ytmdesktop2 read-only; refreshes on track change and after a jump.
- [x] Wave (C): tile floor under the cube driven by system loopback bands (Rust WASAPI → Tauri Channel); settings waveFull / waveCompact (separate), capture runs only while the current mode's wave is on and the window is visible; compact window grows to fit the floor.
- [x] Compact size depends on the translation switch, not on whether the song has translations.
- [x] Palette: queue, shuffle, repeat, wave full, wave compact (prev/next already there or added).
- [x] cargo test, vitest, tsc, build; real render of full + compact; independent review; installer rebuilt; no commit.
Progress (all done; not committed). Installer: app/src-tauri/target/release/bundle/nsis/Hakuro_1.4.0_x64-setup.exe (version still 1.4.0, not bumped). Not live-verified: WASAPI with real audio (no output device connected), Spotify jump/shuffle/repeat against a real account, ytmdesktop2 /nav/queue against the real app.
- Independent review (fresh agent): no critical/high. Fixed all of: M1 full-mode floor could never fit its column (cube corner alone nearly fills it) and was hard-cut at the column edge → fitRing() in floor.ts against restPoses(false), may reach 0.3 edge under the lyrics' margin, never below 0.4, both ends fade (.wave--fade mask; re-rendered at 940×760). M2 start/stop joined the capture thread on the UI thread (sync commands; open() can block) → finish() only signals and detaches. L1 queue header ignored the backend's "sp:" prefix. L2 jump counted skips in the filtered list → skips_to() counts Spotify's raw queue (test). L3 two jumps could interleave via keyboard → in-flight guard + aria-busy (test). L4 one empty tick cleared the FFT ring → cleared after QUIET_TICKS=4 (test). L5 doc overstated stop-on-reload → reworded. Trivia: modes rollback restores only the refused key; queue empty text reset; stale "media session" comment. After fixes: cargo test 137 pass / 13 ignored, vitest 111 pass, tsc clean, clippy no new warnings (2 pre-existing).
- Frontend: main.ts wires modes (shared createModes in modes.ts: press trusted 2.5 s over polls, reverted + notice on refusal), queue toggle (placeBesideMain 400×620, same button closes), wave lifecycle (setting for the current mode && visible && not minimized), compactGeometry(lyricSize, stretched, floor) sized by state.showTranslations (default on → translated size) + floorExtent of both rest poses → --floor-shift; objectZone glass drags compact. Palette: Queue…, Shuffle, Repeat (hidden for ytmd2), Sound wave full/compact.
- Queue window: queue.html / queue.ts / queue.css (design A sheet), vite input + children capability. Spotify rows → jump_queue {uri, position}; ytmd2 rows disabled; refetch on track change, shuffle change, focus, REFRESH, after jump; READING/empty/error states.
- Verified: tsc clean; vitest 108 pass (new queue.test, modes.test, floor.test; main/settings/search tests updated); cargo test 135 pass / 13 ignored; vite build OK. Headless Edge render with a stubbed bridge (scratchpad harness/): full (floor + bar shuffle/repeat-one), cover hover skip, disc hover queue, compact 549×591 (406×558 without floor), stretched 897×591, queue window Spotify + ytmd2 — all as designed. Fixed from render: .glow-btn:disabled made disabled cover-skip faintly visible → selector scoped to .cover-box.
- smtc.rs deleted; split_artists + tests → matching.rs; PlayerKind::Ytmdesktop2 has serde alias "ytmusic" (settings test: other values survive, save writes ytmdesktop2); lyric_cache_key lost its player arg (ytm-sync-v2 keys were SMTC-only); windows features now Win32_Media_Audio/Com/Com_StructuredStorage/Variant.
- player.rs: Repeat, QueueItem, Queue; Playback.shuffle/repeat/canShuffle/canRepeatContext/canRepeatTrack; Player::queue/jump(uri, position)/set_shuffle/set_repeat (ytmd2 → Refused).
- spotify.rs: parse_queue/jump_index (tests), jump = re-read queue + N× next (MAX_JUMP 50); ytmdesktop.rs: queue() reads /track first (no page call when nothing loaded), parse_queue after playing id or counterpart.
- lib.rs commands: set_shuffle, set_repeat, get_queue (now = last sample), jump_queue, start_wave(Channel<Vec<u8>>), stop_wave. settings: waveFull/waveCompact default true.
- visualizer.rs: WASAPI loopback thread, FFT 2048, 16 log bands 45 Hz–14 kHz, u8 levels, reopen on device change/failure. cargo test 135 pass. Live loopback NOT verified: every audio endpoint on this PC is disconnected right now (GetDefaultAudioEndpoint → 0x80070490); the no-device path was run live (stops in time, sends nothing).

## Research + design — 2026-10-20 3D wave, queue window, shuffle/repeat (nothing implemented)

User: "1. 方塊下面有隨歌曲的3D波動視覺回饋 ... 可以開關 在compact mode 跟 full mode 都可以使用 2. 追加看撥放佇列的功能 ... 帶有透視的3D面板 ... 查一下 ytmdesktop2跟spotify 是不是可以透過點擊佇列裡的歌曲跳轉過去 ... 按鈕必須在Compact mode 跟 full mode 都有 且在方塊上 compact mode 3. 檢查是否有辦法刷新 ... repeat mode 或 shuffle mode 然後有對應的按鈕 以上先調查是否有對應的api 然後以及先出3版視覺設計方案給我". Mid-task: wave = water-ripple rings made of bars/blocks, not curves (ref: EQ bar sheet).
Status: research + design canvas delivered; no app code changed. Next: user picks a design (or mixes), then plan implementation.
Design canvas: https://claude.ai/artifact/Q7wSTAG6nkT2WjmLz2jzsk — A 聲納柱環 (rings of thin bars + peak caps; controls in transport bar / lid), B LED 方塊環 (segmented LED columns; "NEXT ▸" strip / spine; drum queue), C 地磚漣漪 (tile heightfield ripple; cover-corner HUD; floating-stair queue). Each: full, compact, queue window (player tweak spotify/ytmdesktop2/ytmusic shows states) + shared Controls board. Tweaks: accent, palette accent|rainbow, wave on/off. Not rendered or checked by the assistant (canvas rule).
Findings:
- Wave needs audio data no player API gives: Spotify GET /audio-analysis/{id} page shows "Deprecated" (community: 403 for apps created after 2024-11-27 — every Hakuro user's own Client ID); ytmd2 API and SMTC carry no audio. Path: WASAPI loopback in Rust (windows 0.62.2 already a dependency; add Win32_Media_Audio/Win32_System_Com features) → ~32 band levels → Tauri Channel (docs: Channels for ordered high-throughput; events "not designed for low latency or high throughput"). Process loopback (AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS, min Windows 10 build 20348; user on 26200) can capture only Spotify.exe / ytmdesktop2 tree; browser YTM = whole browser. Spotify Connect on another device → no local audio → wave idle. Alternative crate `wasapi` 0.26 has new_application_loopback_client. Compact window must grow for the floor (designs assume ~380×396).
- Spotify queue: GET /v1/me/player/queue (scopes user-read-currently-playing + user-read-playback-state — already granted, no re-auth) → currently_playing + queue[]; item limit not stated on the page. No jump/skip-to endpoint: POST /me/player/next has only device_id (Premium) → jump = N× next (counts as skips, slower); PUT /me/player/play offset.uri works only within context_uri (album/artist/playlist); whether user-queued items survive is unverified.
- Spotify shuffle/repeat: GET /me/player shuffle_state, repeat_state off|track|context, actions.toggling_shuffle/toggling_repeat_context/toggling_repeat_track; set via PUT shuffle/repeat (Premium). smart_shuffle not on the page.
- ytmd2 master b287bb3 (latest v1.8.4-rc.0, 2026-10-19): GET /nav/queue still {index, videoId?, title?}; no jump route. /nav/watch {videoId, playlistId?} builds a fresh watchEndpoint (no index/params, RD ids stripped) → restarts/rebuilds the queue, not a jump. Official ytmdesktop playQueueIndex (src/renderer/ytmview/preload.ts:530-575, development) re-dispatches the queue item's own navigationEndpoint.watchEndpoint via yt-navigate → small upstream PR could add POST /nav/queue/play {index}.
- ytmd2 repeat: HTTP /track/repeat calls repeat() without an argument → cycles NONE→ALL→ONE; response loop=true for ALL or ONE. TrackState now has `loop` (service.ts:29-41) fed by track-player.renderer.ts:350-390 readLoop = getLoopVideo() — probably repeat-ONE only (inferred, needs live test). Shuffle: POST toggles, returns {shuffle}; no shuffle field in state → unknown until first press. Internal repeat(loop?: boolean) exists (api-controls.cmds.ts:174-185) but the route does not pass it.
- Browser YTM (SMTC): W3C MediaSession actions (MDN list of 16) have no shuffle/repeat and there is no queue → hide queue/shuffle/repeat for that player.
Evidence: ytmd2 sources in scratchpad 1b1b72af…/scratchpad/ytmd2/.

## Completed research — 2026-10-20 playlists, queue, shuffle/repeat API availability (nothing implemented)

User: "1. 列出使用者有的所有撥放清單 2. 點擊撥放清單 可以看到清單內的歌曲 3. 撥放佇列的功能 4. 轉盤快轉Seek的時候至少視覺表現要先知道時間軸前進多少 可以的話 歌詞也先一起前進 鬆開來才真的送出request ... 5. 切換random repeat模式 除了第4點 先幫我調查Spotify跟ytmdesktop2是否都有對應的api可以使用 先都不要實作"
Status: research reported to the user; no code changed. Item 4 (dial seek preview) needs no API: today deck.ts:389-392 already sends one seek per gesture; plan = while dragging, compute the target locally and move the timeline and lyrics, send the seek on release. Confirm with the user before building.

Spotify (developer.spotify.com reference pages, checked 2026-10-20; sonnet agent report, get-playlists-items restriction re-checked on the official page by the main thread):
- 1 SUPPORTED: GET /v1/me/playlists, scope playlist-read-private (+ playlist-read-collaborative for collaborative ones), limit ≤ 50, owned + followed playlists. Liked Songs not included: GET /v1/me/tracks, scope user-library-read.
- 2 PARTIAL: GET /v1/playlists/{id}/items (/tracks deprecated; entry field `track` → `item`; limit ≤ 50). Official: "only accessible for playlists owned by the current user or playlists the user is a collaborator of", else 403 — followed and Spotify playlists show their name only. Play: PUT /v1/me/player/play with context_uri + offset.position, Premium only. Starting a followed playlist in dev mode: unverified.
- 3 PARTIAL: GET /v1/me/player/queue (existing scopes; Premium requirement unverified) → {currently_playing, queue[]}; POST /v1/me/player/queue?uri= appends, Premium only. No remove / reorder / jump endpoint found.
- 5 SUPPORTED: PUT /v1/me/player/shuffle?state=true|false, PUT /v1/me/player/repeat?state=off|context|track, Premium only. State comes free from the GET /v1/me/player poll Hakuro already does (shuffle_state, repeat_state).
- Costs: new scopes force re-authorization; spotify.rs:126-133 `has_control_scope` checks only user-modify-playback-state → generalize to a required-scope list (granted scope string already stored, spotify.rs:241-242). Dev mode since 2026-03-09: app owner needs Premium, 5 users per Client ID. Rate and quota numbers unpublished; quota 429s carry reason QUOTA_EXCEEDED → fetch playlists/queue when a panel opens, cache playlists by snapshot_id, never poll them.

ytmdesktop2 (v1.8.3 source: nav-service.ts, api-controls.cmds.ts, routes.mdx):
- 1 NONE: no route lists library playlists.
- 2 NONE for listing; POST /nav/playlist {playlistId, play} opens or plays a known playlist id.
- 3 MINIMAL: GET /nav/queue → {items:[{index, videoId?, title?}], count, storeHooked} (no artist, duration, art or current-item marker); POST /nav/queue {videoId|playlistId} appends (a video needs an active queue); POST /nav/queue/clear. No remove / reorder / jump. Like every page command it hangs while nothing is loaded.
- 5 PARTIAL: POST /track/shuffle toggles and returns {shuffle}, but shuffle is absent from /track/state (initial state unknown). POST /track/repeat takes no HTTP argument: cycles NONE → ALL → ONE and returns `loop: bool`, so ALL and ONE look the same.
- No upstream issue asks for a playlist API. Security: issue #265 (open) — the API listens on 0.0.0.0, reachable from the LAN; advise turning on Require authorization (Hakuro pairing supports it).
- Options for 1/2: (a) YouTube Data API v3 playlists.list?mine=true — official, 1 quota unit, OAuth; the page does not say whether YTM playlists or Liked Music are returned (only Watch Later is stated as unlistable) → unverified, needs a live test, and the user would have to set up their own Google Cloud OAuth client. (b) Upstream ytmd2 PR adding library/playlist routes, a richer queue and shuffle/repeat state — cleanest. (c) Hakuro reading YTM session cookies — rejected (credentials, ToS).
- Suggestion: per-player capability flags; the UI hides what the active player cannot do.

Follow-up clarification — user asked how ytmdesktop2 itself can display playlists (2026-10-20):
- Re-checked public v1.8.3 source, commit `6e724c8e2e6c673a8bf87310134001151df1d5f2`. Its Electron WebContentsView loads the actual YouTube Music website: `apps/ytmdesktop2/src/main/infra/devUtils.ts:6` sets `https://music.youtube.com`; `main/windows/windowManager.ts:150` creates the view and `:343` loads it. Playlist browsing is provided by the logged-in website inside that view.
- `renderer-plugins/youtube/api-controls.cmds.ts:28-35,72-73` dispatches the website's `yt-navigate` event with a playlist browse endpoint; `:288-292` reads the website's queue store; `:308-324` already calls the page's Innertube request manager for `/music/get_queue`. The external REST API exposes only selected bridges; no library-playlist or playlist-item listing is documented in `apps/docs/content/docs/api/routes.mdx`.
- Precise distinction: the app can display playlists, but its current external API does not return those lists to Hakuro. A possible extension is to read/request playlist data inside the existing logged-in page and expose sanitized results over its local API; this is a proposed direction, not implemented or live-verified. Exact library requests, pagination and completeness still need investigation. No application code changed.

Follow-up research — user asked about `ytmdesktop/ytmdesktop` instead (2026-10-20; no implementation):
- Latest release verified through GitHub: v2.0.12 (2026-09-08), commit `178681e4107aa5b5482c958358f144e5d8f06b80`. Companion API/router/schema/get-playlists script are identical on development `882db48b6fa0594ee38b58e7098161261f048078`. Official docs: https://github.com/ytmdesktop/ytmdesktop/wiki/v2-%E2%80%90-Companion-Server-API-v1 .
- YES: `GET /api/v1/playlists` returns `{id,title}[]`; one request per 30 s, cache advised; Socket.IO `playlist-created` / `playlist-deleted` events. Source `src/main/integrations/companion-server/api/v1/index.ts:423-465,539-553`. This capability was absent from the earlier project-comparison summary and must not be conflated with Venipa/ytmdesktop2.
- Coverage caveat: `src/renderer/ytmview/scripts/getplaylists.script.js:13-25` requests `addToPlaylistEndpoint` using the currently loaded video, then `preload.ts:592-603` maps the add-to-playlist menu options to id/title. Hence all saved/followed playlists and Liked Music are NOT verified; no pagination/completeness guarantee found. Requires a loaded player response in this implementation. No live test performed.
- NO dedicated arbitrary playlist-items endpoint in API v1. `POST /api/v1/command` with `changeVideo` accepts playlistId and starts playback. Reading the resulting queue is not equivalent to browsing a playlist without changing playback, and does not establish complete playlist contents.
- Queue: `GET /api/v1/state` or Socket.IO `state-update` supplies title, author, duration string, thumbnails, videoId, selected flag, counterparts, selectedItemIndex and automixItems (`src/main/player-state-store/index.ts:52-69`). `playQueueIndex` plays a selected entry. No enqueue/remove/reorder/clear command in the external command schema.
- Repeat: `repeatMode` sets None=0 / All=1 / One=2; current repeatMode is returned. Shuffle: command invokes the page's `queue.shuffle()`, no boolean setter or shuffle-state field exposed (`preload.ts:500-527`; command schema and state transform checked). Seek: `seekTo` uses seconds; local drag/lyrics preview remains a Hakuro frontend task.
- Integration: Companion Server port 9863, authenticated pairing, REST commands plus Socket.IO `/api/v1/realtime`. GET state limited to once per 5 s; use pushed updates. Hakuro's existing ytmdesktop2 backend cannot be reused merely by changing the port. Research only; no app/config changes.

Also: v1.4.0 Release run 39302317704 finished with success.

## Completed task — 2026-10-20 ytmdesktop2 player option, v1.4.0

Goal: add "YouTube Music (ytmdesktop2)" as a third player (keep Spotify and browser SMTC), reading the exact videoId from ytmdesktop2's local API.
Acceptance:
- [x] `PlayerKind::Ytmdesktop2` (serde "ytmdesktop2", prefix "ytmd2"); settings `ytmdPort` default 13091, out of 9999–39999 → default; port change reconnects.
- [x] connect: GET / identifies the API; unreachable/wrong service gives an actionable error; authRequired → stored DPAPI token (own file `ytmd-session.bin`) or pairing (code in status "authorizing", 30 s window); stale token cleared and re-paired; 401 while polling → needs-auth (ytmdesktop2 wording).
- [x] playback: /track/state + /track each poll (both answered from ytmd2 memory); volume POST {} only when a track is loaded, 1 s timeout; seconds → ms; art meta.thumbnail; " - Topic" stripped.
- [x] controls: play/pause/next/prev; seek {time: ms, type:"seek"}; volume {volume}.
- [x] lyrics: Playback.video_ids (serde skip) → TrackQuery.video_ids (playing id, counterpartVideoId); providers::youtube_music fetches ids first (12 s shared), search fallback; spotify_id only for Spotify; YTM native source for both YTM players (`plays_youtube_music`).
- [x] frontend: option + port field (validated only when selected) + help text; volume title; tests.
- [x] cargo test 125 passed / 10 ignored, tsc, vitest 92 pass; sonnet review: no blocker/major (its one minor, volume stalling the sample, fixed); README updated.
- [x] live test against the user's ytmdesktop2 (v1.8.3, API 13091, authRequired false; user: "接下來你自己嘗試控制ytmusicdesktop2 把剩下的工作完成", "做完就把音樂暫停"):
  - ATV YhiQDARUJ7Y 甲乙丙丁Strangers: playback fields right, YTM 44 cues 0.53 s. owTWCbq_nSk: YTM 52 cues 0.48 s.
  - controls via Rust client: pause/play ok; seek 30000 → 31021 ms (ms absolute confirmed); volume 100→90→100 restored; next/prev ok (prev restarts after 3 s).
  - found: after /nav/watch to an MV, state.playing false for 15+ s while progress runs → `moving()` inference (second sample playing=true live).
  - found: MV FM7MFYoylVs counterpartVideoId null, own lyrics plain → `localized_song` generalised to plain titles (catalog_title) and used for player ids → YTM 52 cues 1.7 s live. Anonymous YTM `next` has no counterpart (checked).
  - found: MV author localized ("老菸槍雙人組和酷玩樂團") — only matters for search fallback.
  - pre-existing YTM live tests (smtc joint credit, smtc MV, localized song timing, search+lyrics) pass after the change.
  - found: MV gKM15TaKLUI (Coldplay "Ink", author 酷玩樂團) has no lyrics at all → bridge also tried when the video's own lyrics are empty → YTM 26 cues 1.2 s live.
  - second sonnet review (post-live changes): one major — a real pause mid-interval read as playing for a sample → `moving` now needs both samples flagged paused (`Position.flagged_playing`) and elapsed 500..=5000 ms. Third fresh agent verified that fix and the bridge change: PASS. Accepted minors: worst case ~24 s inside the YTM provider when bridge + search both stall; volume None (dial disabled) while ytmd2's page hangs with a track loaded; bridge skipped when the player gives no artist.
  - GUI: built release exe run portable with `{"player":"ytmdesktop2"}` in target/release (test files removed after): Connected, "YOUTUBE MUSIC · SYNCED" line highlight in sync on MV "Used To Love", volume 100% dial, pause in ytmd2 → play icon + grey art + frozen 2:30. Music left paused as the user asked.
  - cargo test 127 passed / 11 ignored; vitest 92; tsc ok; fmt only pre-existing diffs (lib.rs ~1467, matching.rs).
- [x] user: "如果做完沒有問題 就把說明更新 版號推進 1.4.0 然後推上去" — README updated; version 1.4.0 (six values, `cargo metadata --locked` ok); final NSIS app/src-tauri/target/release/bundle/nsis/Hakuro_1.4.0_x64-setup.exe 9,658,355 bytes SHA256 c98cf470...0f0bbb; commits feat + chore bump, push main, lightweight tag v1.4.0 (like v1.3.x) to start the Release workflow.
Live finding 2026-10-20: with nothing loaded, ytmd2 answers GET /track and /track/state at once (`null`) but every page command (POST /track/volume, /nav/watch, GET /nav/queue) hangs with no answer (8 s timeouts). Hence the volume gating and the "did not answer — let YouTube Music finish loading" message for a connect-then-timeout.
Also changed: poll loop re-emits "connected" after a failed sample recovers (all players).
Knowns (verified against ytmdesktop2 v1.8.3 source, not only docs): progress/duration seconds; seek `time` is ms with `type:"seek"` absolute (docs say seconds — source wins, api-controls.cmds.ts:200-206); POST /track/volume without volume returns `{volume}` unchanged (cmds 228-233, router zod optional); auth code TTL 60 s, approval wait 30 s, appId /^[a-z0-9]{2,32}$/, appVersion semver (auth/manager.ts); GET / is public and returns authRequired; meta.counterpartVideoId present in v1.8.3.
Decision: REST polling at the existing 1.5 s local interval, no WebSocket (no new dependency, same poll loop).
Resolved: the user installed ytmdesktop2 and asked Claude to drive it for the live test (done above).

## Completed — 2026-10-20 release 1.3.2, then research a non-SMTC YouTube Music source

v1.3.2 Release run 39290974423 finished: success.

Done: fix commit b08b2b1, version bump 053fb22 (six values: package.json, package-lock x2, tauri.conf.json, Cargo.toml, Cargo.lock hakuro; `cargo metadata --locked` ok), pushed main 20ddb04..053fb22, tag v1.3.2 pushed (lightweight, like v1.3.0/v1.3.1); Release run 39290974423 started. v1.3.1 run 39284433626 finished ok. (User asked for this commit/push explicitly.)
Next (user): study ytmdesktop/ytmdesktop (development), Venipa/ytmdesktop2, sigma67/ytmusicapi for an exact "what is playing" source; dropping SMTC for YouTube Music is acceptable. Three sonnet research agents running; reports to scratchpad/ytm-research/{ytmdesktop,ytmdesktop2,ytmusicapi}.md.
Research results (agents' evidence in those reports, unverified items marked there):
- ytmdesktop2 (Venipa, CC0, v1.8.3 2026-10-18, very active): local API off by default (Settings > API & Integrations), 127.0.0.1:13091; plain WebSocket /socket pushes track:change (video.videoId, title, author, album, duration) and track:state (playing, progress s) ~250ms; REST controls; auth optional (pairing code + approval → Bearer). Its own lyrics: Better Lyrics by videoId, LRCLIB, captions; not YTM native timed.
- ytmdesktop (official, GPL-3, v2.0.12 2026-09-08): Companion Server off by default, 0.0.0.0:9863, Socket.IO /api/v1/realtime state-update (video.id, title, author string, album, durationSeconds, player.videoProgress, trackState, queue); mandatory pairing (4-digit code, approval click, token stored by client); GET /state limited 1/5s; commands play/pause/next/prev/seekTo/setVolume... No lyrics. Rust Socket.IO client compatibility unverified.
- ytmusicapi (MIT): lyrics flow same as Hakuro's (next → ANDROID_MUSIC browse, line timing only). Anonymous search with hl = browser UI language may align strings (unverified). get_history needs cookie auth, gives exact videoId but latency/session stability unverified, risky. OAuth impractical.
- Not from the repos: own browser extension reading the player API (exact, keeps the browser; install step).
User picked ytmdesktop2, as an added player option (keep browser SMTC). ytmd2 API verified from its docs (apps/docs/content/docs/api/routes.mdx) and server.ts:260-290: messages `{"event","data":[...]}`, literal "null" on connect with no track; REST GET /track, /track/state, POST /track/play|pause|toggle-play-state|next|prev|seek {time s}|volume {volume}; 401 {"error":"unauthorized"}; pairing POST /auth/requestcode {appId,appName,appVersion} → {code}, POST /auth/request {appId,code} blocks until approval → {token}; WS closes 1008 when unauthorized. User asked whether ytmd2 requires the desktop app (yes) vs web YTM — answered; pairing + real-test questions pending.

## Completed task — 2026-10-20 YTM credit joined in the reader's language

Goal: user's YTM track owTWCbq_nSk (Something Just Like This) found no lyrics automatically; manual search had them. User also asked whether a YouTube API helps, or how Folia searches.
Acceptance: root cause shown from real SMTC metadata; automatic lookup for that metadata answers from native YTM; new tests fail without the fix; full cargo test passes; independent review; installer rebuilt; no commit.
Cause: SMTC (Vivaldi) artist = "The Chainsmokers和Coldplay" (U+548C). YTM joins credits in the UI language — public /next byline runs: zh-TW " 和 ", zh-CN "和", ja "、", ko " 및 ", en " & ". split_artists only split , 、 ， so the wanted list was the whole string; native YTM lists the artists apart and was rejected, as were the others. Automatic lookup only worked when LRCLIB held an entry with the exact joined credit and was not "busy" (it answered "The server is busy" during diagnosis). User's lyrics.db (read-only): key |248000 has a manual native binding (the failed run), key |247641 an automatic LRCLIB hit.
Fix: smtc.rs ARTIST_SEPARATORS += 和, 및 (whole credit still first, so primary_artist/search queries unchanged; & still not split). Tests: smtc a_credit_joined_in_the_readers_language_is_split, providers a_credit_joined_in_the_readers_language_matches_its_artists_listed_apart (both FAIL with old separators, pass with fix), ignored live_youtube_smtc_localized_joint_credit (before: source LRCLIB; after: YouTube Music, 52 timed cues, 0.9s).
Verified: cargo test --lib 110 passed / 8 ignored; rustfmt clean on smtc.rs and new providers hunk.
Folia = github.com/chthollyphile/folia-major (Electron player). It plays YTM itself, so it has the videoId and reads lyrics by id (/next lyrics browseId, mobile client for line timing), and retries cross-source matching with the artist's name from the en/zh song page. Hakuro sees only SMTC (no videoId), so it must search; no public YouTube API gives the browser's current videoId.
Review 1 (fresh sonnet): A/C/D pass; major — SMTC Playback.artists was the split list and the UI joins it (main.ts:871), so parts were displayed (pre-existing for comma credits). Fixed: smtc.rs Playback carries the whole credit only; lib.rs lyric_query splits each name for the lookup (test the_lyric_lookup_wants_a_joint_credit_whole_and_apart).
User also reported manual LRCLIB search always "Lyrics search failed: Http": LRCLIB answers 503 ServerOverloaded with retry-after: 1 (single tries 7/20 and 3/10 ok). request_json now retries 503/429 up to 2 times after retry-after (1s default, gives up if > 2s) and returns ProviderError::Busy when still busy. Local-server test an_overloaded_server_is_asked_again_after_the_wait_it_names; ignored live probe live_lrclib_search_rides_out_overload: 9/10 ok vs 3/10 single-try at the same time.
Verified: cargo test --lib 112 passed / 9 ignored; live joint-credit regression → YouTube Music 52 timed cues; rustfmt clean on touched hunks (pre-existing diffs in matching.rs, lib.rs ~1325 untouched).
Review 2 (fresh sonnet): A-D pass, no blocker/major. Applied: test waits use recv_timeout. Known, left: a name that itself contains a separator (e.g. Spotify "Tyler, The Creator", or 和 inside a name) adds stray parts to the matching list only (never display); worst case request_json outside the 12s chain deadline (LRCLIB exact, manual search) is 3x6s + 2x2s when the server is both slow and busy; other providers using request_json also retry 429/503.
Final: cargo test --lib 112 passed / 9 ignored; release + NSIS rebuilt: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe, 9,639,844 bytes, mtime 2026-10-20 00:59:30 +0800, SHA256 782cf6584016b76663a69a0353109d21c5d51563645120ddbfa809a08c7aea6a. Version still 1.3.1 (v1.3.1 already tagged/released from 20ddb04) — shipping this needs a version bump. Installed app/settings untouched (lyrics.db, settings.json read-only). No commit/push.

## Completed task — 2026-10-20 compact slab follow-up fixes

Goal: fix 4 user-reported compact issues. User decisions: (4) the "semi-transparent background" is the window-wide faint frame/shadow; (3) window made tall enough for the stretched cube end-on from the start (both states); (2) stretched back face: one row of four.
Acceptance: (1) NO COVER placeholder centred in the cover square (compact off/on, full); (2) stretched back: SOURCE/FIND/RELOAD/SETTINGS one row, all on the face, no text overflow; unstretched column all on the face; (3) stretched cube inside the window at all 4 rest faces; toggling lyrics only widens the window; (4) compact setShadow(false), full setShadow(true), permission added; tests + render + independent review + installer; no commit.
Causes: (1) `.cover-empty` moved into new `.cover-box` (not a grid) lost the face's grid centring — also hit full mode; (2) `.tools` padding-top 8% is relative to the face width, which grows when stretched; (3) window was 2*edge tall but the stretched cube end-on at rest needs ~2.45-2.6 edges (perspective); (4) Tauri `shadow` defaults true (tauri-utils 2.9.3 config.rs:2093), which on undecorated Windows windows adds a 1px border + rounded corners round the clear glass.
Done: styles.css `.cover-box` grid centring, compact back tools padding-top 0 + stretched row; deck.ts `stretchedHeight` (corner projection, BOB/SWAY consts shared with the frame loop); main.ts compactGeometry height = ceil(stretchedHeight)+24 in both states, setShadow(false/true); capability allow-set-shadow; main.test.ts updated + new stretchedHeight test (reference values computed separately in Python).
Verified so far: tsc clean; vitest 89/89. Render suite (scratchpad/render, extended): all assertions pass — compact window 300x402, stretched 585x402, cube inside window turned left (t/b 52/380), back, right (58/388), front; stretched back tools in one row 4x86px on a 435px face, overflow 0; unstretched column within 150px face; placeholder centre 74.5/75 (compact both), 99/99.5 (full); setShadow calls [false…] in compact, [true] in full.
Independent review (fresh sonnet): A-D all PASS, no blocker/major; nit addressed (comment that the plain cube stands well under the stretched height). Left as known: drag to extreme angles can still overflow (user accepted); more transparent glass above/below (402 vs 300 at edge 150).
Final: tsc clean; vitest 89/89; release + NSIS rebuilt: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe, 9,640,144 bytes, mtime 2026-10-20 00:10:06 +0800, SHA256 573325adb633848c32850667d1b28b5bab8d03c890a6db6fe4695daca8e533f2; dist contains the stretched back-row rule and setShadow. Not exercised: real Windows shadow/border removal (headless can't show it). No commit/push.

## Completed task — 2026-10-19 compact slab cube

Goal: compact mode becomes design option C "Slab": a transparent window holding only the 3D cube; lyrics stretch the cube sideways. Design canvas https://claude.ai/artifact/K5b4QypwPDdRjqcJ7vkhn1 (board C).
Acceptance: (1) compact hides chrome/bar/poster, window background transparent; drag empty area moves window, drag cube turns it and snaps to 90°. (2) faces: front cover (tap play/pause, grey when paused); top lid prev/play/next + lyrics/pin/full; right spine vertical title+artist; left volume dial; back SOURCE/FIND/RELOAD/SETTINGS (SETTINGS compact-only); bottom logo. (3) lyrics ON stretches cube right, front shows synced lyrics (centred active line, words/translations), lid right of controls shows title+artist+display-only progress with times, window widens, rest angle turns frontal. (4) pin ON lights cube edges, same alwaysOnTop setting. (5) new persisted setting compactLyrics. (6) full mode unchanged. (7) frontend+Rust tests pass incl. new coverage; real Edge render of both compact states; independent review; release installer rebuilt; no commit.
User decisions: lid controls stay left, title right; compact always transparent, hide compact-opacity slider (value kept, unused); window size derived from compact lyric size, not user-resizable in compact; back face gains SETTINGS; progress bar under lid title (display only).
Known: compact shares full-mode DOM via CSS; `.tool[data-proxy]` mirrors real controls; #lyrics can be reparented into the front face keeping centre logic; window already transparent.
Progress: implemented in settings.rs/config.ts (compactLyrics, default false, round-trip test), capabilities (allow-set-resizable), settings.html (compact opacity hidden, copy updated), index.html (cover-box, cube-lyrics, lid with proxies + meta/progress, spine, back SETTINGS; bar skip buttons removed), styles.css (@property --w stretch, new compact section, pin glow), deck.ts (setLayout: dial left/right, stretched rest angle; empty-glass startDragging; lens/tap scoped to cover-box), main.ts (compactGeometry/applyWindowBounds non-resizable, lyrics reparenting, lid/spine mirrors, transitionend --s recentre). README 精簡模式 bullet rewritten.
Verification: tsc clean; vitest 87/87 (new: geometry, stretch persist/reparent/restore, glass drag, lid transport/progress/pin, recentre-on-settle — that last test shown failing without the fix); cargo test 108 passed/7 ignored. Real headless-Edge render of the real build with mocked Tauri API (scratchpad/render: build.mjs, mock-tauri.js, render.mjs): compact cube 300x300, turned left (dial) and back (SETTINGS), stretched+pinned+translated 792x406 (cube 589 wide), stretched paused 585x300, lyric size 44 stretched 956x490, full 940x760 — all assertions pass (transparent body, chrome/bar hidden, cube inside window, active line centred, lid times, pin glow, full mode without compact pieces). Render found and fixed: back-face SETTINGS leaked into full mode (`.tool` display overrode `.tool--compact`); lyric centre drifted when `--s` eased after resize (transitionend recentre).
Findings not fixed (pre-existing, out of scope): with prefers-reduced-motion the global `transition-duration: 1ms` makes `.lyrics__list` padding transition from 0, so the first centring after lyrics load is off until the next line (both modes; visible when paused). Long lines wrap in the stretched face at the approved 1.9x width. Headless fps measurements were noise (machine under load; old and new builds both 1–60fps).
Independent review (fresh sonnet) found and the author fixed: (1) full-mode regression — `.cube` transitioned `--w` on top of body's `--s`, cube measured 221.8x299.1 mid-resize; now only registered `--stretch` eases and `--w = --s + --stretch`, re-sampled width==height every frame, compact stretch still eases 150→435; (2) entering compact while maximized now unmaximizes first and re-maximizes on return (capabilities allow-maximize/allow-unmaximize; test fails without fix); (3) lid "Full mode" proxy no longer mirrors aria-pressed (`data-plain`). Reviewer's "full-mode rules changed" item was the earlier large-window task (cube 198.719 / same bounds as its evidence). Second fresh review of the delta: all criteria pass, two nits left (innerSize read right after unmaximize; roomyMaximized not reset). Not fixed nits: translation toggle during settings preview resizes to stored size; titles of lid pin/lyrics tools static.
Final: tsc clean; vitest 88/88; cargo test 108 passed/7 ignored; render suite all assertions pass, no frame stalls. Release + NSIS rebuilt: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe, 9,639,096 bytes, mtime 2026-10-19 21:56:55 +0800, SHA256 35d2006f7927db034e38f84d7e1af7ef5df29b65ca73f95cbafd8c2c3d037aaa. Not exercised: real WebView2 window (maximize/unmaximize, non-resizable, startDragging) — mocked only. No install, no user config touched, no commit/push.

## Completed task — 2026-10-19 palette shortcut hints

Goal: Command palette shows current bindings beside actions. Acceptance: configured keys/scopes display on normal/search rows; unset keys hidden; opening after edit/clear uses fresh config; narrow palette remains usable; tests/build pass and installer rebuilt. Known: existing palette has key-badge rendering but commands pass empty keys. Reuse shortcut action IDs and formatter; no backend changes. Progress: savedbindings joined by stableactionID into palette snapshots, reusedkeycaps plus GLOBALscope; added click-through row and launcherfooter. Narrowmetadata wraps to secondrow. Frontend84tests passed including normal/searchscope/state, clear/replace snapshots and main settingsclose-to-reopen refresh. Diffcheckpassed. Independent actualEdge renderpassed600x540/340x460: longcombo+GLOBAL+state, disabledaction, search, clearedfreshsnapshot and updatedkey; evidence C:/Users/screa/AppData/Local/Temp/hakuro-palette-bindings-TPd7oP/results.json. RootvisuallyinspectednarrowPNG. Allcriteria passed; release2m59s+NSIS built successfully. Installer1.3.1:9670501bytes,mtime1792411869067,SHA256 550e93d97b57984e224ad9fdee6446eb01f14ad4f5e116105133746690fe5e88. Path app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe. No install/userconfigchanges orcommit/push. Backend unchanged.


## Completed task — 2026-10-19 configurable shortcuts

Goal: Settings can bind/edit/clear keyboard shortcuts with persistence and visible conflict errors.
Acceptance: defaults retained; capture/cancel/clear/reset and duplicate validation; local/global dispatch uses existing capability guards; save/restart preserves bindings and OS registration failures restore previous state; tests/build/render and independent review pass.
Known: user explicitly wants new bindings LOCAL by default, Global optional. Existing recovery Ctrl+Alt+P global retained and explained. Root frontend/docs, folia_ytm_audio backend; lyrics_ui renders and lyrics_review independently reviews. No installed user configuration changes.
Progress: editor implements16actions, per-actionGlobal, default/reset/clear, captureEsc cancellation, duplicate and IME/repeat protection. Frontend82tests and fullRust107tests passed (7ignored). Registry per-key diff rolls back registration/save failures; settings write tempthenrename. Startup canonical aliases normalized in memory and warning shown on main. Settings native shortcut:capture supports already-registered OS chords without running original actions. Edge640x780 and420x360 verified16rows/nooverflow/footer; moved status into fixedfooter after hidden-message finding. Root viewed narrow duplicate screenshot. Final independent review passed allcriteria; final Edge actualmodules+mockTauri capture/clear/reset/duplicate/nativecapture/scope checks passed. Latest evidence C:/Users/screa/AppData/Local/Temp/hakuro-shortcuts-render-9q28A9/results.json. Windows global keypress/OS collision not manually exercised; lifecycle has mockedregistry tests.Release build2m55s and NSIS packaging passed. All criteria verified with above OS-test limitation. Artifact app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe:9669683bytes,mtime1792410862294,SHA256 fd5adae8aac17e3e88a92835526a22a20aff811e7aaf1b7bf5ebb2873acbdc6e. Installer/executable both1.3.1. No install/userconfig changes or commit/push. Reusable: registered Windows chords may bypass DOM capture; forward native chord to settings recording handler, suppress action, retain shared validation. User preference pointer: newshortcutbindingslocal;Globaloptin.


## Completed task — 2026-10-19 large-window layout and synced YTM lyrics

Goal: prevent pink background overlapping lyrics at high resolution, scale the cube with full-window space, and prefer synchronized lyrics when YTM native retrieval is Plain. User allows broader YTM integration changes if evidence requires them.
Acceptance: responsive layout verified at minimum/default/1080p/1440p plus compact; native Plain no longer stops automatic synced-provider search; old automatic Plain cache does not hide improved policy; exact screenshot recording tested end-to-end for real timing availability; tests/build/review pass and installer rebuilt.
Initial knowns: Chain returned any native nonempty result immediately. Prior probe incorrectly counted35 text entries as timed; timestamp validation below corrected this. No need to assume SMTC causes missing lyrics timing. No open user questions.
Ownership: lyrics_ui owns responsive CSS/render validation; folia_ytm_audio owns native timing diagnosis and youtube_music.rs if needed; root owns selection/cache/integration/docs. Continue ponytail minimal architecture approach.
Progress: responsive CSS fixed with shared left-column boundaries and cube sizing from width/height (no220px cap). Real Edge rendering passed520x460,940x760,1920x1080,2560x1440 and compact340/460 with small/large bilingual text. Cube edges112/198.7/360/504px; background remains44px from lyrics. Compact metadata gets opaque background. Root visually inspected desktop and compact screenshots; evidence C:/Users/screa/AppData/Local/Temp/hakuro-compact-layout-svah69 (8png + layout-results.json). Prior render failures were sandbox limits; tool-reviewed escalated Edge worked without user-profile changes.
Native diagnosis correction: MV -VKIqrvVOpo has35 lyric entries butZERO timestamps; prior agent count was not timing validation. Song ZdzoLCLliW0 has38 real timestamps. Added localized_song_lyrics: checks selected/current MV ID/full title/known duration; requires same native artist ID, exact bilingual original title and song duration within4s; fetches song's own synced timeline. No explicit counterpart link was returned by tested /next variants, so selection uses these identity checks, not a claimed direct mapping. SMTC unchanged.
Integration: native Plain no longer stops Chain; native timed wins. Video plain retained before bounded song-enrichment so failures/timeouts do not erase it. New YTM automatic/native-pin cache policy keys re-fetch old Plain once; Spotify, other pins and manual bindings retained. Root live fullautomatic test with actualSMTCmetadata succeeded2.12s: sourceYouTubeMusic, titleただ君に晴れ,38lines/38cues,noerrors. Frontend77tests and Rust102tests pass (7ignored); independent review passed identity, fallback/deadline, cache/manual/pin and rendered layout checks. Release build and NSIS packaging passed (Rust release2m35s). All acceptance criteria passed. New artifact: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe,9620770bytes,mtime epoch1792409298971,SHA256 b26d49e62d50d2fff34bb3d9ef9be8c0a7859baf0009c740a3676208c93f9909. Installer and executable both report1.3.1. Installed application/settings untouched; actual installed-GUI playback was not retested. Layout used real browser rendering and lookup used actual screenshot metadata against live YTM. No commit/push. Reusable finding: count valid timing fields, not lyric-array entries; MV and Song can expose different timing availability.

## Completed fix — 2026-10-19 YTM lyrics missing for localized song title

Goal: reproduce and fix the user's 1.3.1 screenshot failure: SMTC reports Just a Sunny Day for You / YORUSHIKA / ~199s while YTM shows ただ君に晴れ - Just a Sunny Day for You and visible Japanese lyrics. Rebuild local installer after verification.
Acceptance: demonstrate root cause against public YTM response; automatic lookup succeeds for this recording without weakening unrelated/live/cover identity checks; regressions and existing tests/build pass; rebuild 1.3.1 installer and verify artifact.
Known: SMTC has no videoId; current native lookup searches Songs and requires exact normalized title/artist plus ±4s duration. Existing app version 1.3.1. Open questions: whether localized metadata, video-vs-song IDs, or response handling prevents lookup; investigate before choosing fix.
Ownership: folia_ytm_audio read-only public API diagnosis; root integration/fix/cache behavior. No installed settings, account/login or playback architecture changes.
Progress: reproduced public metadata mismatch. Songs returns ZdzoLCLliW0 / ただ君に晴れ / ヨルシカ / 199s; Videos returns the screenshot MV -VKIqrvVOpo / ただ君に晴れ - Just a Sunny Day for You / Yorushika / 200s. Both supply native lyrics (later timestamp validation: Song38 timed entries; MV35 text entries with no timestamps). Strict matching rejected localized Song metadata before lyrics fetch. Implemented YTM-only Videos fallback after Songs has no usable lyrics, within the existing 12s total deadline, and conservative bilingual-segment matching with unchanged artist/duration requirements. No song-specific alias or global matching changes. Empty answers are not cached, so no cache migration required. Installed app1.3.1 and player=ytmusic verified read-only.
Verification: actual SMTC-query regression failed before (0 lines, no provider error) and passes after (native source, exact bilingual MV title, 47 text lines / 0 timed cues, no errors, 4.26s). This real run exercised plain-text fallback; timed availability is provider-dependent. Full cargo test100 passed /5ignored; targeted rustfmt and diff checks pass. Independent review passed after tightening ignored title segments to CJK letters/whitespace and rejecting additional version descriptions (Off Vocal/Piano/Japanese equivalents); unsupported titles remain manual choices. Fixed1.3.1 installer rebuilt successfully (release2m58s plus NSIS), including a fresh frontend build; frontend unchanged from previous77-pass verification.
Updated artifact: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe, 9,614,721 bytes, mtime epoch1792408338172. Installer and executable both report1.3.1. SHA256 53ccfd7aa5370fba1b05b6bd07c6d4cc7cb31c9f6d1844efc546e26b8655b869 replaces earlier ce3c... build. Installed application/settings left untouched; no commit/push.
Reusable finding: a successful native lyric fetch by videoId does not verify SMTC integration. Regressions must start from actual SMTC title/artist/duration and include song-vs-MV and localization differences. Preserve generic matching for other sources.

## Completed build — 2026-10-19 local 1.3.1 installer

Goal: user requested a local installer rebuild and version 1.3.1.
Acceptance: npm/Tauri/Cargo package versions and lockfiles agree on 1.3.1; release NSIS build succeeds; installer and executable version/size verified and path reported.
Known: prior functionality tests passed (Rust 99, frontend 77). Preserve all current uncommitted changes. No commit/push or installation requested. Open questions: none.
Progress: version fields updated and diff verified (only six version values across five files). Initial release build stopped at Tauri version checks: earlier no-save npm install had resolved newer compatible-range packages than package-lock (API 2.12 vs Rust 2.11, opener 2.7 vs 2.5). Restored exact locked frontend dependencies with npm ci; frontend 77 tests passed again. Release NSIS build succeeded, including TypeScript/Vite build (optimized Rust compile 2m52s). No dependency version upgrades or manifest changes beyond app version.
Verified artifact: app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.1_x64-setup.exe, 9,611,062 bytes, built 2026-10-19 17:58 local. Both installer and release hakuro.exe report ProductVersion/FileVersion 1.3.1. Installer SHA256: ce3c61b98f5dd389f03df69922e629ab2bb10827e5614480a58ee77954b2c7d4. No install/commit/push performed.
Reusable build finding: use npm ci for restoring this project's dependencies. A no-save install can still update node_modules within semver ranges and break Tauri's frontend/Rust minor-version agreement despite leaving package-lock unchanged.

## Completed correction — 2026-10-19 native lyrics follow the selected player

Goal: user clarified YouTube Music refers to the playback terminal chosen in Settings. Native lyrics must be tried first only for that player, while Spotify keeps its existing lyric lookup.
Acceptance: Ytmusic automatic lookup starts with native lyrics then existing configured providers; Spotify never queries native YTM; global fallback settings retain five existing providers; native manual search/source is available only for Ytmusic; compact fix retained; tests/build and independent review pass.
Known: previous implementation incorrectly exposed YTM as a sixth generic source. No open questions. Root owns backend routing/config and progress; lyrics_ui owns search UI/tests and README. Preserve manual selections and per-track source overrides within the selected player.
Progress: corrected provider scope and effective lookup order; no playback/login changes. Global settings normalize to the original five fallback providers. Runtime config exposes native search/source only for Ytmusic; automatic cache keys include the effective native-first order. Spotify ignores native pins/manual bindings left by the earlier implementation. Native timed or plain lyrics stop the chain; empty/error outcomes continue through configured fallback providers. Full cargo test 99 passed / 4 ignored; frontend 77 passed; frontend build, targeted Rust formatting and diff checks passed. Final independent review passed all criteria with no blocking findings; backend command guards were statically reviewed, while order/migration/fallback/search flows have regression tests.
Limits unchanged: no rebuilt installer or interactive SMTC/desktop layout check. Compact metadata fix retained.
Correction to retain: distinguish the selected playback terminal from a generic lyric-provider preference. Native YouTube Music lyrics follow Settings > Player = YouTube Music automatically; Spotify retains its previous behavior.

## Completed implementation — 2026-10-19 YouTube Music lyrics and compact metadata

Goal: add native YouTube Music lyric retrieval while retaining SMTC playback controls; show song title and artist in Compact mode.
Acceptance:
- [x] YouTube Music is available in automatic lookup, source selection and manual search/preview/binding, with conservative recording matching and existing cache/fallback behavior.
- [x] Native timed/plain lyric parsing and missing/error responses have runnable coverage; public live retrieval succeeds.
- [x] Compact mode has a separate title/artist row; static layout review and tests cover minimum-height budget, track changes and long names. Actual rendered layout remains unverified (see limits).
- [x] Rust/frontend tests and frontend production build pass; independent integration, parser and static layout review passed with no remaining blocking findings.
Known: clean worktree at start; current UI uses separate source/search windows. No login, audio streaming, SMTC, user settings file or dependency changes planned.
Open questions: none. Retain configured source order and append the new source for existing configurations.
Ownership: root integrates providers/settings/search and docs; folia_ytm_audio owns new youtube_music.rs; lyrics_ui owns compact metadata in index/main/styles and tests. Fresh reviewer validates integration.
Progress: source registry, automatic/manual dispatch, settings migration and search UI integrated. New source inherits conservative title/artist/duration matching and persistent manual binding. Frontend 75 tests, full cargo test 97 passed / 4 ignored, production build and diff check pass. New module/providers rustfmt check passes; whole-repo fmt reports pre-existing formatting in matching.rs/settings.rs (left untouched). Public live native lookup returned 20 candidates and 58 timed lines in 1.24 s; root reran the final live smoke successfully after fixes. Compact metadata uses existing DOM with a separate 44px row and matching minimum-height budget. Independent review findings fixed: mobile-error plain fallback, preserved timed interlude gaps, and updated search-source help text. A test fixture accidentally used a 12-character video ID and was corrected to the required 11 characters. Existing font dependencies were missing locally and installed without manifest/lock changes.
Limits: no interactive desktop SMTC/GUI test or successful rendered screenshot. Edge CDP disconnected, Edge CLI produced no screenshot, and CUA reported no browser; no layout claim is based on a screenshot. Compact layout was checked statically and metadata lifecycle exercised in jsdom. No installer rebuilt, no commit/push, no installed-app settings changed.
Reusable finding: preserve provider-supplied blank/instrumental timed cues so the preceding lyric does not stay highlighted throughout a gap. Empty timed timelines must still fall back to plain lyrics or another source.

## Completed task — 2026-10-19 Find lyrics and source in their own windows, quieter brand mark

Goal: (user) move Find lyrics and Lyrics source out of the main window like settings; the icon on the accent plate looks out of place — offer alternatives.
Acceptance:
- [x] Four brand variants rendered side by side (scratchpad shots/brand-variants-2x.png); C chosen: accent-coloured outline of the icon, no plate (CSS luminance mask on `--accent`), full and compact.
- [x] Find lyrics: own panel window (search.html/search.ts), opened by FIND, the back face and the palette; song passed in the URL (track key, title, query, manual, translations); search/preview/apply/restore as before; closes on save, Close/×/Esc and when the song changes; translation switch drives main via `search:translations`.
- [x] Lyrics source: own panel window (source.html/source.ts); Automatic + providers, requested source preselected; apply sends the URL's track key; failure stays open; closes on Cancel/×/Esc and song change.
- [x] Shared panel helpers (panel.ts, panel.css, windows.ts `openPanel`); settings moved onto them; in-window dialogs and click-away code removed from main.
- [x] Tests: search.test (9) and source.test (6) added, main.test adapted; 73 pass; tsc clean; vite builds five pages; children capability covers search/source.
- [x] Real-app check of both windows and the brand mark; installer rebuilt at 16:38; not committed.

Handoff verification (Codex, 2026-10-19): Claude stopped at the session limit after the real-app checks, before updating this file. The user confirmed the installer was already rebuilt; its successful build log and `app/src-tauri/target/release/bundle/nsis/Hakuro_1.3.0_x64-setup.exe` timestamp were verified. No rebuild or implementation changes were needed. Fresh checks: all 73 frontend tests pass, `npx tsc --noEmit` and `git diff --check` pass. Rust source is unchanged; Rust tests were not rerun.

Real-app evidence: attached to Claude's release test instance (separate WebView2 profile, debug port 9333). Find lyrics opens at 600x680 with the synthetic song/query, enabled searchable sources and selected query; Lyrics source opens at 480x380 with Automatic plus all five providers. Both receive no-track close requests and actually disappear after releasing the temporary screenshot hold. Main is 940x760 with a 34x22 accent outline mark; the existing compact screenshot at 460x198 was visually checked. Claude's final recorded checks also cover Escape/Cancel, source-save failure remaining open, settings opening/closing through the shared helper, and compact/full switching. Fresh screenshots: `C:/Users/User/AppData/Local/Temp/claude/C--Projects-hakuro/56719b9e-b540-41bd-8cd0-0081ccff9329/scratchpad/shots/codex-{main,search,source}.png`.

Limit: no actual song was playing during the real-app check, so live search/preview/apply/restore against a playing track is not verified in this handoff. Those paths, stale responses, save failures, translations and track changes pass the frontend regression tests. Synthetic playback was used only to inspect the windows; the real backend correctly rejects track operations with "Nothing is playing."

Cleanup: the release test process (PID 7056, verified executable path) was closed through its own close button and confirmed exited. Claude's temporary release-folder `settings.json` was moved to the scratchpad as `codex-verified-test-settings.json`; installed-app settings were untouched. No commit/push. Keep the existing installer for user testing.

## Previous task (same session, uncommitted) — 2026-10-19 brand icon, palette and settings in their own windows

Goal: (user) top-left shows the project icon on the accent plate instead of "H"; the command palette and the settings panel open as their own windows so a small (compact) main window cannot cramp them.
Already done this session, uncommitted: bar play/pause icon replaces FOLLOW/RELOAD (no idle fade), bar 64->48px, background shards drift.
Acceptance:
- [x] Brand mark is the HR icon (src-tauri/icons) on the accent plate, full and compact.
- [x] Palette: own window (owned by main, so above a pinned main), placed over main and clamped to the monitor work area; Ctrl+K / COMMANDS open it; commands and lyric jumps still run in main; Esc, Enter-run, click-away and blur close it; IME guard kept.
- [x] Settings: own window (owned by main); opened by the header button, the palette and first run; dials preview live on main; Cancel/Esc/close restore; Save applies; version and storage info shown; save failure keeps the window and values.
- [x] In-window palette/settings dialogs removed; source and Find-lyrics dialogs unchanged.
- [x] Frontend tests moved/extended (main, palette, settings), tsc, vite multi-page build, cargo test if Rust touched; real-app check of both windows; installer rebuilt; not committed.
Decisions: windows created from JS (`WebviewWindow`, `parent: "main"`), pages palette.html/settings.html as Vite inputs; children get their own capability. Palette is created on first use and then hidden/shown (snappy reopen); settings is created per open and destroyed on close. Main re-reads `get_config` when the settings window is destroyed (covers save, cancel and Alt+F4 in one path). Palette receives a plain-data snapshot (commands, lyric lines, track key) and sends back {command id | line index}; closures stay in main.
Progress:
- Brand icon done (img of src-tauri/icons/64x64.png, bundled by Vite). Compact accent band sized to the 124px cube column (user report: cube's right side fell off the band); verified by screenshot 460x198/258.
- CSS split: base.css (fonts, tokens, resets, brand, window buttons), sheet.css (form styles, `.sheet`), palette.css, settings.css; styles.css imports base+sheet.
- palette.html + palette-window.ts + palette.ts (snapshot/actions), settings.html + settings.ts, windows.ts (placement, owned child options), config.ts (shared types, applyTheme). Capabilities: main gains create-webview-window/set-position/set-focus; children.json for palette+settings.
- Tests: 61 pass (main 40, palette 7, settings 6, clock 8); tsc clean; vite build emits three pages. Test helper isolateListeners fixes a cross-test listener leak (fresh module per test, one jsdom window per file).
- Real app (release exe, own WebView2 profile + debug port, temporary ytmusic settings.json removed afterwards): palette window created/placed over main (334,190 for main 956x769 at 156,156), commands run in main (Compact mode), Escape hides and main regains focus, palette full-size over compact main (476x207); settings window opens focused, compact dial previews on main (30px), Cancel reverts (18px), Save applies (22px) and writes settings.json, settings stays above a pinned main (desktop capture).
- Fixes from the real-app check: first open after launch hid the palette at once (momentary blur while the webview takes focus) -> blur must last 150 ms and isFocused() must be false; palette list scrollbar styled thin/dark. Re-verified on two fresh launches (button and Ctrl+K paths). Main dialogs (Find lyrics, source) re-checked after the CSS split.
- Tests 62 pass, tsc clean, Rust untouched (capabilities validated by `tauri build`). README updated. Installer rebuilt (still 1.3.0). Not committed.
Reusable findings: a frameless child window's first show can report focus-lost while WebView2 takes focus, so blur-to-dismiss needs a grace check. jsdom keeps one window per test file while each test re-imports the page module, so window/document listeners must be removed between tests (src/test-listeners.ts). The scratchpad stub bridge must send `trackKey`, or every track-dependent control stays disabled.

## Previous completed task — 2026-10-19 Cube Deck redesign, v1.3.0

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
