# Spotify Original Lyrics (Tauri)

Desktop lyrics viewer for whatever the account is currently playing on Spotify:
original-language lyrics, line highlighting against the real playback position,
and transport control.

This is the Tauri rewrite of the Python/Tkinter version that still lives in the
repository root. Rust owns every network call; the interface is HTML/CSS/TS
running in the system WebView2 runtime.

## Setup

1. Create a Spotify Developer application and set its Redirect URI to exactly:

   ```text
   http://127.0.0.1:8787/callback
   ```

   The literal loopback address is required — Spotify no longer accepts
   `localhost` for new authorizations. The app uses PKCE, so no client secret is
   involved.

2. Put a `secret.env` file beside the executable, UTF-8, holding only the
   Client ID:

   ```dotenv
   SPOTIFY_CLIENT_ID=your_client_id
   ```

   `CLIENT_ID` and `clientId` are accepted too, quoted values are fine, and a
   bare Client ID on its own line works. The file is never bundled into the
   executable, so sharing the app does not share the Spotify identity.

3. Launch it. A saved session resumes silently; the first run opens the browser
   once for authorization.

## What needs Premium

Play/pause, previous, next and seek go through the Spotify Web API, which
restricts playback control to Premium accounts. The buttons follow whatever
Spotify reports as currently allowed, and a refusal is shown using Spotify's own
wording rather than a guess.

Control also requires the `user-modify-playback-state` scope. Upgrading from a
build without it invalidates the stored session once, so the browser opens for a
single re-authorization.

## Lyrics sources

Queried in order, first synchronized result wins:

| Source | Timeline | Notes |
| --- | --- | --- |
| LRCLIB | Yes | Open API, documented at <https://lrclib.net/docs> |
| Musixmatch | Yes | Unofficial endpoint. See the caveat below. |
| PetitLyrics | Yes | Unofficial endpoint, word-level timings folded to lines |
| NetEase | Yes | Unofficial endpoint |
| QQ Music | Yes | Unofficial endpoint |

Plain text from an earlier source is kept only as a fallback, so a source with
words but no timeline never prevents a later source from supplying the timeline.
A failing source is noted in the interface and skipped; none of them can break
the chain.

**Musixmatch caveat (checked 2026-09-21):** the classic `apic-desktop` client
identity was retired upstream and now answers with a decoy all-zero token, so
this app targets `apic.musixmatch.com` with a fallback chain of application ids
and rejects degenerate tokens. That host is rate-limited per IP and may answer a
captcha challenge, in which case the lookup simply moves on to the next source.

Only the track title, artist, album and duration — plus the Spotify track id for
Musixmatch, which accepts it as a matching key — are sent to lyrics sources.
No Spotify token and no contents of `secret.env` ever leave the app.

Matching is deliberately strict: the title must be identical after Unicode
folding, at least one artist must overlap, and durations must agree within four
seconds. Version words such as *Live* or *Remix* are never stripped, because
stripping them selects the wrong recording. Traditional and Simplified Chinese
are folded together for comparison only; displayed lyrics are never rewritten.

## Reading the lyrics

- With a timeline, the current line is highlighted and centred as it plays.
- **Follow lyrics** turns auto-scroll off for manual reading; scrolling by hand
  also pauses it for a few seconds.
- Clicking a timed line seeks the player to that line.
- Without a timeline, plain text is shown and no timings are invented.
- Spotify is polled every 1.5 s and the position is extrapolated between polls,
  but never more than five seconds past the last sample — a dead connection
  stops the lyrics rather than letting them drift away from the music.

## Sign-in storage

The refresh token is encrypted with Windows DPAPI, bound to both the current
Windows user and the Client ID, and stored at
`%LOCALAPPDATA%/SpotifyOriginalLyrics/session.bin`. It never enters the
repository, the executable, or Git. Changing the Client ID does not carry the old
session over. A transient network failure never clears the cache; only an
explicit rejection from Spotify does.

## Development

```powershell
npm install
npm test                      # frontend: position clock and line selection
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri dev
npm run tauri build
```

Windows needs the MSVC build tools and the WebView2 runtime, which Windows 11
already ships. The release installer lands under
`src-tauri/target/release/bundle/`.

The Chinese conversion dictionaries are embedded into the binary at build time,
so nothing has to be shipped beside the executable.
