//! Application wiring: Spotify polling, lyric lookups, and the commands the
//! interface calls.
//!
//! The backend owns every network call and pushes events to the frontend; the
//! frontend owns only presentation and the sub-second position extrapolation
//! that keeps the highlight smooth between polls.

mod lrc;
mod matching;
mod musixmatch;
mod petitlyrics;
mod providers;
mod spotify;
mod token_store;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::RwLock;

use lrc::Cue;
use providers::{LyricsResult, TrackQuery};
use spotify::{Playback, Spotify, SpotifyError};

/// Poll politely: 1.5 s keeps the highlight honest without burning rate limit.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Enough songs for an evening of listening, without unbounded growth.
const CACHE_LIMIT: usize = 100;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatusEvent {
    state: &'static str,
    message: String,
    /// A non-fatal warning, e.g. the sign-in could not be cached.
    notice: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackEvent {
    #[serde(flatten)]
    playback: Playback,
    /// Bumped on every track change so late lyric results can be discarded.
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LyricsEvent {
    generation: u64,
    track_id: String,
    source: String,
    synced: bool,
    cues: Vec<Cue>,
    text: String,
    /// Set when some providers failed but another one answered.
    partial: bool,
}

#[derive(Default)]
struct Session {
    spotify: RwLock<Option<Arc<Spotify>>>,
    cache: RwLock<HashMap<String, LyricsResult>>,
    /// Incremented on every track change; a lyric result from an older
    /// generation belongs to a song that is no longer playing.
    generation: AtomicU64,
    current_track: RwLock<String>,
    polling: RwLock<bool>,
}

struct AppState {
    http: reqwest::Client,
    musixmatch: musixmatch::Session,
    session: Session,
}

impl AppState {
    fn new() -> Self {
        Self {
            http: providers::client().expect("HTTPS client must start"),
            musixmatch: musixmatch::Session::new(),
            session: Session::default(),
        }
    }
}

fn emit_status(
    app: &AppHandle,
    state: &'static str,
    message: impl Into<String>,
    notice: impl Into<String>,
) {
    let _ = app.emit(
        "status",
        StatusEvent {
            state,
            message: message.into(),
            notice: notice.into(),
        },
    );
}

/// Connect using the cached session, falling back to browser authorization.
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if state.session.spotify.read().await.is_some() {
        return Ok(());
    }

    emit_status(&app, "connecting", "Connecting to Spotify…", "");

    let client_id = match spotify::read_client_id() {
        Ok(client_id) => client_id,
        Err(error) => {
            emit_status(&app, "error", "Client ID configuration needed", error.to_string());
            return Err(error.to_string());
        }
    };

    let client = Arc::new(Spotify::new(client_id).map_err(|error| error.to_string())?);

    let needs_browser = match client.connect_session().await {
        Ok(needs_browser) => needs_browser,
        Err(error) => {
            emit_status(&app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    };

    if needs_browser {
        emit_status(
            &app,
            "authorizing",
            "Waiting for Spotify authorization in your browser…",
            "",
        );
        let (url, verifier, expected_state) = client.authorization_request();
        if app.opener().open_url(url, None::<&str>).is_err() {
            let message = "Cannot open the browser for Spotify authorization.";
            emit_status(&app, "error", "Connection failed", message);
            return Err(message.to_string());
        }
        if let Err(error) = client.complete_authorization(verifier, expected_state).await {
            emit_status(&app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    }

    let notice = client.cache_warning().await;
    *state.session.spotify.write().await = Some(client);
    emit_status(&app, "connected", "Connected", notice);

    start_polling(&app, &state).await;
    Ok(())
}

async fn start_polling(app: &AppHandle, state: &State<'_, AppState>) {
    {
        let mut polling = state.session.polling.write().await;
        if *polling {
            return;
        }
        *polling = true;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        poll_loop(handle).await;
    });
}

async fn poll_loop(app: AppHandle) {
    loop {
        let (client, has_client) = {
            let state = app.state::<AppState>();
            let client = state.session.spotify.read().await.clone();
            (client.clone(), client.is_some())
        };
        if !has_client {
            break;
        }
        let client = client.expect("client presence was just checked");

        let mut delay = POLL_INTERVAL;
        match client.playback().await {
            Ok(playback) => apply_playback(&app, playback).await,
            Err(SpotifyError::LoginRequired) => {
                let state = app.state::<AppState>();
                *state.session.spotify.write().await = None;
                *state.session.polling.write().await = false;
                emit_status(&app, "needs-auth", "Spotify sign-in expired", "");
                break;
            }
            Err(SpotifyError::RateLimited { retry_after }) => {
                delay = Duration::from_secs(retry_after.max(2));
                emit_status(&app, "waiting", "Spotify rate limit; waiting before retry", "");
            }
            Err(error) => {
                emit_status(&app, "waiting", error.to_string(), "");
            }
        }

        tokio::time::sleep(delay).await;
    }
}

/// Publish the sample, and start a lyric lookup when the song changed.
async fn apply_playback(app: &AppHandle, playback: Playback) {
    let state = app.state::<AppState>();

    // A stopped player or a non-track item clears the view.
    let key = if playback.has_track {
        if playback.track_id.is_empty() {
            format!("{}|{}", playback.name, playback.duration_ms)
        } else {
            playback.track_id.clone()
        }
    } else {
        String::new()
    };

    let changed = *state.session.current_track.read().await != key;
    if changed {
        *state.session.current_track.write().await = key.clone();
        state.session.generation.fetch_add(1, Ordering::SeqCst);
    }
    let generation = state.session.generation.load(Ordering::SeqCst);

    let _ = app.emit(
        "playback",
        PlaybackEvent {
            playback: playback.clone(),
            generation,
        },
    );

    if !changed || !playback.has_track {
        return;
    }

    if let Some(cached) = state.session.cache.read().await.get(&key).cloned() {
        emit_lyrics(app, generation, &key, cached);
        return;
    }

    let query = TrackQuery {
        track: playback.name.clone(),
        artists: playback.artists.clone(),
        album: playback.album.clone(),
        duration_ms: playback.duration_ms,
        spotify_id: (!playback.track_id.is_empty()).then(|| playback.track_id.clone()),
    };

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = {
            let state = handle.state::<AppState>();
            providers::fetch_lyrics(&state.http, &state.musixmatch, &query).await
        };

        let state = handle.state::<AppState>();
        // Drop the answer if the song moved on while the lookup was in flight.
        if state.session.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if !result.is_empty() {
            let mut cache = state.session.cache.write().await;
            if cache.len() >= CACHE_LIMIT {
                if let Some(oldest) = cache.keys().next().cloned() {
                    cache.remove(&oldest);
                }
            }
            cache.insert(key.clone(), result.clone());
        }
        emit_lyrics(&handle, generation, &key, result);
    });
}

fn emit_lyrics(app: &AppHandle, generation: u64, track_id: &str, result: LyricsResult) {
    let _ = app.emit(
        "lyrics",
        LyricsEvent {
            generation,
            track_id: track_id.to_string(),
            source: result.source.clone(),
            synced: !result.cues.is_empty(),
            cues: result.cues,
            text: result.text,
            partial: !result.errors.is_empty(),
        },
    );
}

/// Forget the cached lyrics for the current song and look it up again.
#[tauri::command]
async fn reload_lyrics(state: State<'_, AppState>) -> Result<(), String> {
    let key = state.session.current_track.read().await.clone();
    state.session.cache.write().await.remove(&key);
    // Clearing the current track makes the next poll treat it as a new song.
    state.session.current_track.write().await.clear();
    Ok(())
}

/// Transport control. Spotify's refusals — Premium required, no active device —
/// arrive with its own wording, which is passed through unchanged rather than
/// matched against a string this app would have to guess.
async fn with_client<F, Fut>(state: &State<'_, AppState>, action: F) -> Result<(), String>
where
    F: FnOnce(Arc<Spotify>) -> Fut,
    Fut: std::future::Future<Output = Result<(), SpotifyError>>,
{
    let client = state
        .session
        .spotify
        .read()
        .await
        .clone()
        .ok_or_else(|| "Not connected to Spotify".to_string())?;
    action(client).await.map_err(|error| error.to_string())
}

#[tauri::command]
async fn play(state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.play().await }).await
}

#[tauri::command]
async fn pause(state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.pause().await }).await
}

#[tauri::command]
async fn next_track(state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.next().await }).await
}

#[tauri::command]
async fn previous_track(state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.previous().await }).await
}

#[tauri::command]
async fn seek(position_ms: i64, state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.seek(position_ms).await }).await
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The interface reads these names literally. A flattened struct does not
    /// inherit the wrapper's `rename_all`, so this pins every key the frontend
    /// depends on: a mismatch here silently blanks the track, disables the
    /// transport and stops the highlight, while lyrics keep working.
    #[test]
    fn playback_event_keys_match_what_the_interface_reads() {
        let event = PlaybackEvent {
            playback: Playback {
                track_id: "id".into(),
                name: "Title".into(),
                artists: vec!["Artist".into()],
                album: "Album".into(),
                album_art: Some("https://example.test/art.jpg".into()),
                duration_ms: 180_000,
                progress_ms: Some(1000),
                is_playing: true,
                has_track: true,
                can_skip_next: true,
                can_skip_previous: false,
                can_seek: true,
                device_name: Some("Device".into()),
            },
            generation: 7,
        };
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().unwrap();

        for key in [
            "trackId",
            "name",
            "artists",
            "album",
            "albumArt",
            "durationMs",
            "progressMs",
            "isPlaying",
            "hasTrack",
            "canSkipNext",
            "canSkipPrevious",
            "canSeek",
            "deviceName",
            "generation",
        ] {
            assert!(object.contains_key(key), "missing key: {key}");
        }
        // Nothing may reach the interface under its Rust spelling.
        for key in ["track_id", "has_track", "duration_ms", "is_playing", "can_seek"] {
            assert!(!object.contains_key(key), "snake_case leaked: {key}");
        }
        assert_eq!(object["hasTrack"], serde_json::json!(true));
        assert_eq!(object["durationMs"], serde_json::json!(180_000));
    }

    #[test]
    fn lyrics_event_keys_match_and_cues_keep_their_own_spelling() {
        let event = LyricsEvent {
            generation: 3,
            track_id: "id".into(),
            source: "LRCLIB".into(),
            synced: true,
            cues: vec![Cue {
                time_ms: 1000,
                text: "LINE_A".into(),
            }],
            text: "LINE_A".into(),
            partial: false,
        };
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().unwrap();

        for key in ["generation", "trackId", "source", "synced", "cues", "text", "partial"] {
            assert!(object.contains_key(key), "missing key: {key}");
        }
        // The interface reads cue timings as `time_ms`; keep that spelling.
        assert_eq!(object["cues"][0]["time_ms"], serde_json::json!(1000));
    }

    #[test]
    fn status_event_keys_match() {
        let json = serde_json::to_value(StatusEvent {
            state: "connected",
            message: "Connected".into(),
            notice: String::new(),
        })
        .unwrap();
        for key in ["state", "message", "notice"] {
            assert!(json.as_object().unwrap().contains_key(key), "missing key: {key}");
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect,
            reload_lyrics,
            play,
            pause,
            next_track,
            previous_track,
            seek
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
