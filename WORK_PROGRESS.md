# hakuro session recovery

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
