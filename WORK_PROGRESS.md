# hakuro session recovery

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
