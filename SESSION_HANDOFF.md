# Session Handoff

## Project

We are building **Spotify Original Lyrics**, a small Windows desktop app.

The user's Spotify account is Japan-region. The original goal was to keep that account while obtaining original-language lyrics externally because some lyrics are unavailable in the Japan Spotify experience.

## Scope decision

The user explicitly said to ignore song-title metadata for now and solve **lyrics only**.

Do not implement original song-title replacement unless the user asks.

## Current implementation

- Python + Tkinter desktop UI
- English UI
- Spotify Web API for currently playing track
- Spotify Authorization Code with PKCE
- Redirect URI: `http://127.0.0.1:8787/callback`
- Scopes:
  - `user-read-currently-playing`
  - `user-read-playback-state`
- Poll interval: 1.5 seconds; UI clock updates every 100 ms
- LRCLIB / NetEase / QQ Music for lyrics; conservative title, artist and duration matching
- Plain/original-language lyrics
- In-memory cache during the app session
- LRC line highlighting and optional follow-scroll; no word-level karaoke

## Problem that was encountered

The first version failed during Spotify OAuth token exchange:

`[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate`

The user clarified this is a home PC.

## Fix in this version

The app now uses Python's `truststore` package:

```python
import truststore
truststore.inject_into_ssl()
```

This makes Python HTTPS use the native Windows certificate store.

`requirements.txt` installs `truststore`.

The release is dist/SpotifyOriginalLyrics.exe (PyInstaller onefile/windowed). Read the external secret.env beside the EXE for the Client ID; no startup script or Python installation is required.

The app refuses to authorize if `truststore` is missing.

## Security decision

Never work around the certificate problem by disabling TLS verification with `ssl._create_unverified_context()`.

If `truststore` still fails, investigate:

1. Antivirus HTTPS/SSL inspection
2. VPN/proxy software
3. A custom root CA missing from Windows Trusted Root Certification Authorities
4. Python installation/version problems

## Current files

- `app.py` — application
- `requirements.txt` — dependency
- `test_app.py` — config and startup regression checks
- `README.md` — user-facing documentation
- `SESSION_HANDOFF.md` — this handoff document

## Spotify setup

The user needs a Spotify Developer application.

Exact Redirect URI:

`http://127.0.0.1:8787/callback`

The desktop app uses PKCE, so it does not need a client secret.

## Current lyrics lookup

LRCLIB is queried using:

- track name
- first artist
- album name
- duration

Current endpoint:

`https://lrclib.net/api/get`

## Useful next improvements

If the user confirms this version works:

1. Improve lyrics matching reliability, potentially using ISRC where available.
2. Add a fallback lyrics provider abstraction.
3. Add album artwork.
4. Add font-size controls.
5. Add always-on-top / compact mode.
6. Add minimize-to-tray.
7. Persist window position/settings.
8. Consider Windows startup.
9. Only revisit synchronized lyrics after checking applicable API/provider terms.

## User preferences for this project

- Windows desktop
- Comfortable with PowerShell
- Wants directly runnable tools
- UI should be English
- Explanations can be Traditional Chinese
- Wants a Markdown handoff when another ChatGPT session will continue the project

## Immediate objective of this handoff

The current session:
1. Fixed the Windows SSL/certificate issue by using `truststore`.
2. Changed the UI to English.
3. Added `README.md`.
4. Added this `SESSION_HANDOFF.md`.
5. Packaged all files together.

The next session should test dist/SpotifyOriginalLyrics.exe with the user-provided secret.env and complete real Spotify authorization and lyrics playback. Automated tests cover config parsing, startup, and deferred authorization errors.


## Multi-source synchronized lyrics update

lyrics_sources.py owns providers, matching and LRC parsing (milliseconds). app.py uses separate Spotify/lyrics workers and a Tk-main-thread queue. Track generation guards reject stale results; pending requests keep only the newest song. Plain lyrics remain a fallback. OpenCC normalizes Traditional/Simplified Chinese for matching only; package its data files. Tests: test_app, test_sync, test_lyrics_sources. API-based pause/seek correction has polling/network latency. NetEase/QQ public endpoints are unofficial and may change. Actual user Spotify OAuth/playback still needs end-to-end verification.
