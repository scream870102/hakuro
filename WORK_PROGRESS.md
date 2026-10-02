# hakuro session recovery

## Active task — 2026-10-02 localized lyric titles

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
