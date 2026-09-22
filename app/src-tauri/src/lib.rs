//! Application wiring: playback polling, lyric lookups, and the commands the
//! interface calls.
//!
//! Two playback sources are supported and exactly one is live: Spotify over its
//! Web API, or YouTube Music through the Windows system media session. The
//! choice is a setting, and changing it drops the old connection so the poll
//! loop below ends and a new one starts.
//!
//! The backend owns every network call and pushes events to the frontend; the
//! frontend owns only presentation and the sub-second position extrapolation
//! that keeps the highlight smooth between polls.

mod db;
mod lrc;
mod matching;
mod musixmatch;
mod petitlyrics;
mod player;
mod providers;
mod settings;
mod smtc;
mod spotify;
mod token_store;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::RwLock;

use db::Db;
use lrc::Cue;
use providers::{LyricsResult, TrackQuery};
use player::{Playback, Player, PlayerError, PlayerKind};
use settings::Settings;
use smtc::Smtc;
use spotify::Spotify;

/// Poll politely: 1.5 s keeps the highlight honest without burning rate limit.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// The way back from a click-through window, which by definition cannot be
/// clicked. The interface listens for this and flips the stored mode.
const TOGGLE_CLICK_THROUGH: &str = "toggle-click-through";

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
    /// The source this track is pinned to, or empty for the normal order. The
    /// interface shows it as the current choice in the source menu.
    requested: String,
}

/// One lyrics source as the settings panel and the source menu list it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderInfo {
    id: String,
    label: String,
}

/// Everything the interface needs to draw the settings panel in one answer.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConfigPayload {
    settings: Settings,
    providers: Vec<ProviderInfo>,
    /// Shown in the panel so the reader can find their own files.
    data_dir: String,
    stored_tracks: i64,
    /// Non-empty when lyrics cannot be kept between sessions.
    storage_warning: String,
}

#[derive(Default)]
struct Session {
    /// The one live playback source, or nothing while disconnected.
    player: RwLock<Option<Player>>,
    /// Incremented on every track change; a lyric result from an older
    /// generation belongs to a song that is no longer playing.
    generation: AtomicU64,
    /// Also supersede lookups when refreshing or changing sources on the same song.
    lookup_request: AtomicU64,
    current_track: RwLock<String>,
    /// The last sample, kept so a source change can look the song up again
    /// straight away instead of waiting for the next poll.
    current_playback: RwLock<Option<Playback>>,
    polling: RwLock<bool>,
    connecting: tokio::sync::Mutex<()>,
}

struct AppState {
    http: reqwest::Client,
    musixmatch: musixmatch::Session,
    session: Session,
    settings: RwLock<Settings>,
    db: Db,
}

impl AppState {
    fn new() -> Self {
        Self {
            http: providers::client().expect("HTTPS client must start"),
            musixmatch: musixmatch::Session::new(),
            session: Session::default(),
            settings: RwLock::new(settings::load()),
            db: Db::open(),
        }
    }

    fn config(&self, settings: &Settings) -> ConfigPayload {
        ConfigPayload {
            settings: settings.clone(),
            providers: settings::PROVIDERS
                .iter()
                .map(|(id, label)| ProviderInfo {
                    id: (*id).to_string(),
                    label: (*label).to_string(),
                })
                .collect(),
            data_dir: settings::data_dir()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|error| error),
            stored_tracks: self.db.stored_track_count(),
            storage_warning: self.db.warning().unwrap_or_default().to_string(),
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

// ------------------------------------------------------------------ settings

/// Everything the settings panel needs, including the provider list so the
/// interface never hard-codes source names the backend owns.
#[tauri::command]
async fn get_config(state: State<'_, AppState>) -> Result<ConfigPayload, String> {
    let settings = state.settings.read().await.clone();
    Ok(state.config(&settings))
}

/// Persist the panel's contents, apply them, and reconnect if the identity changed.
#[tauri::command]
async fn save_settings(
    app: AppHandle,
    incoming: Settings,
    state: State<'_, AppState>,
) -> Result<ConfigPayload, String> {
    let mut incoming = incoming;
    incoming.normalize();
    // An empty Client ID is allowed — it is the first-run state, and refusing
    // to save would also throw away the colours typed in the same panel.
    if !incoming.client_id.is_empty() {
        incoming.client_id = settings::validate_client_id(&incoming.client_id)?;
    }

    let previous = state.settings.read().await.clone();
    let sources_changed = incoming.sources != previous.sources;
    // Either half of the identity invalidates the open connection: a new Client
    // ID cannot reuse the cached refresh token, and a new player is a different
    // source altogether. A Client ID edited while following YouTube Music
    // changes nothing that is running, so it does not reconnect.
    let identity_changed = incoming.player != previous.player
        || (incoming.player.needs_client_id() && incoming.client_id != previous.client_id);
    settings::save(&incoming)?;
    *state.settings.write().await = incoming.clone();

    if identity_changed {
        // Dropping the client makes the next connect start clean, and ends the
        // poll loop the old one was feeding.
        *state.session.player.write().await = None;
        state.session.current_track.write().await.clear();
        *state.session.current_playback.write().await = None;
        state.session.generation.fetch_add(1, Ordering::SeqCst);
        if incoming.player.needs_client_id() && incoming.client_id.is_empty() {
            emit_status(
                &app,
                "needs-client-id",
                "Client ID configuration needed",
                "",
            );
        } else {
            let handle = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let _ = connect(handle.clone(), state).await;
            });
        }
    } else if sources_changed {
        refresh_current(&app).await;
    }

    Ok(state.config(&incoming))
}

/// Forget every downloaded lyric. The per-track source choices are kept,
/// because they are decisions, not cached data.
#[tauri::command]
async fn clear_lyrics_cache(state: State<'_, AppState>) -> Result<ConfigPayload, String> {
    state.db.clear_lyrics();
    let settings = state.settings.read().await.clone();
    Ok(state.config(&settings))
}

// -------------------------------------------------------------------- players

/// Connect to whichever source the settings name.
///
/// Spotify resumes from its cached session and falls back to browser
/// authorization; YouTube Music has nothing to authorize, so it only has to
/// reach the system media session.
#[tauri::command]
async fn connect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let _connecting = state.session.connecting.lock().await;
    if state.session.player.read().await.is_some() {
        return Ok(());
    }

    let settings = state.settings.read().await.clone();
    emit_status(
        &app,
        "connecting",
        format!("Connecting to {}…", settings.player.label()),
        "",
    );

    if settings.player == PlayerKind::Ytmusic {
        return connect_ytmusic(&app, &state).await;
    }

    let stored = settings.client_id.clone();
    let client_id = match settings::validate_client_id(&stored) {
        Ok(client_id) => client_id,
        Err(error) => {
            emit_status(
                &app,
                "needs-client-id",
                "Client ID configuration needed",
                error.clone(),
            );
            return Err(error);
        }
    };

    let client = Arc::new(Spotify::new(client_id.clone()).map_err(|error| error.to_string())?);

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
        if let Err(error) = client
            .complete_authorization(verifier, expected_state)
            .await
        {
            emit_status(&app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    }

    // A sign-in that cannot be cached and a cache that cannot be written are
    // both "your work will not survive a restart"; say so together.
    let mut notice = client.cache_warning().await;
    if let Some(warning) = state.db.warning() {
        notice = if notice.is_empty() {
            warning.to_string()
        } else {
            format!("{notice} {warning}")
        };
    }
    if state.settings.read().await.client_id != client_id {
        return Err("Client ID changed during authorization. Connect again.".into());
    }
    *state.session.player.write().await = Some(Player::spotify(client));
    emit_status(&app, "connected", "Connected", notice);

    start_polling(&app, &state).await;
    Ok(())
}

/// YouTube Music needs no sign-in: the system media session is either there or
/// Windows refuses, and the only lasting warning is the lyric database.
async fn connect_ytmusic(app: &AppHandle, state: &State<'_, AppState>) -> Result<(), String> {
    let client = match Smtc::connect().await {
        Ok(client) => Arc::new(client),
        Err(error) => {
            emit_status(app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    };
    // The reader may have switched back to Spotify while Windows was answering.
    if state.settings.read().await.player != PlayerKind::Ytmusic {
        return Err("The player changed while connecting. Connect again.".into());
    }
    let notice = state.db.warning().unwrap_or_default().to_string();
    *state.session.player.write().await = Some(Player::ytmusic(client));
    emit_status(app, "connected", "Connected", notice);
    start_polling(app, state).await;
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
        let client = {
            let state = app.state::<AppState>();
            // The flag is held across the decision on purpose. A reconnect that
            // installs its client between reading the slot and clearing the
            // flag would otherwise find the flag still set, decline to start a
            // loop of its own, and leave nothing polling at all.
            let mut polling = state.session.polling.write().await;
            let current = state.session.player.read().await.clone();
            if current.is_none() {
                // Something dropped the client — a settings change, usually.
                // Release the flag so the next connect can start a loop.
                *polling = false;
            }
            current
        };
        // Outside the block, so both guards are released before the loop ends.
        let Some(client) = client else { break };

        let mut delay = POLL_INTERVAL;
        let result = client.playback().await;
        // A response from a source replaced in Settings must not reset the new
        // one. The serial is unique per connection, which a pointer comparison
        // can no longer be now that two kinds of client share one slot.
        let active = app.state::<AppState>().session.player.read().await.clone();
        if !active.as_ref().is_some_and(|open| open.serial == client.serial) {
            continue;
        }
        match result {
            Ok(playback) => apply_playback(&app, playback).await,
            Err(PlayerError::NeedsAuth) => {
                let state = app.state::<AppState>();
                *state.session.player.write().await = None;
                *state.session.polling.write().await = false;
                emit_status(&app, "needs-auth", "Spotify sign-in expired", "");
                break;
            }
            Err(PlayerError::RateLimited { retry_after }) => {
                delay = Duration::from_secs(retry_after.max(2));
                emit_status(&app, "waiting", "Rate limited; waiting before retry", "");
            }
            Err(error) => {
                emit_status(&app, "waiting", error.to_string(), "");
            }
        }

        tokio::time::sleep(delay).await;
    }
}

/// A key that survives restarts, so the database can be read back next session.
///
/// The source is part of the key. It has to be: YouTube Music has no track id
/// at all, so its key is title and length — exactly the shape Spotify falls back
/// to — and without a prefix the two would read each other's cached lyrics.
fn track_key(playback: &Playback) -> String {
    if !playback.has_track {
        return String::new();
    }
    let prefix = playback.source.prefix();
    if playback.track_id.is_empty() {
        format!("{prefix}:{}|{}", playback.name, playback.duration_ms)
    } else {
        format!("{prefix}:{}", playback.track_id)
    }
}

/// Publish the sample, and start a lyric lookup when the song changed.
async fn apply_playback(app: &AppHandle, playback: Playback) {
    let state = app.state::<AppState>();
    let key = track_key(&playback);

    let changed = *state.session.current_track.read().await != key;
    if changed {
        *state.session.current_track.write().await = key.clone();
        state.session.generation.fetch_add(1, Ordering::SeqCst);
    }
    *state.session.current_playback.write().await = Some(playback.clone());
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

    deliver_lyrics(app, &playback, generation).await;
}

/// Answer from the database if it can, otherwise look the song up.
async fn deliver_lyrics(app: &AppHandle, playback: &Playback, generation: u64) {
    let state = app.state::<AppState>();
    let request = state.session.lookup_request.fetch_add(1, Ordering::SeqCst) + 1;
    let key = track_key(playback);
    let requested = state
        .db
        .preferred_source(&key)
        .unwrap_or_else(|| db::AUTO.to_string());

    let order = state.settings.read().await.lookup_order();
    // An automatic answer is only valid for the order that produced it.
    let cache_key = if requested.is_empty() {
        format!("auto:{}", order.join(","))
    } else {
        requested.clone()
    };
    if let Some(cached) = state.db.lyrics(&key, &cache_key) {
        emit_lyrics(app, generation, &key, &requested, cached);
        return;
    }

    let query = TrackQuery {
        track: playback.name.clone(),
        artists: playback.artists.clone(),
        album: playback.album.clone(),
        duration_ms: playback.duration_ms,
        spotify_id: (!playback.track_id.is_empty()).then(|| playback.track_id.clone()),
    };
    let track_name = playback.name.clone();
    let artist = playback.artists.first().cloned().unwrap_or_default();

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = {
            let state = handle.state::<AppState>();
            if requested.is_empty() {
                // Read the order into a value: the lookup can take seconds, and
                // the settings panel must not block behind it.
                providers::fetch_lyrics(&state.http, &state.musixmatch, &query, &order).await
            } else {
                providers::fetch_pinned(&state.http, &state.musixmatch, &requested, &query).await
            }
        };

        let state = handle.state::<AppState>();
        // Drop the answer if the song moved on while the lookup was in flight.
        if state.session.generation.load(Ordering::SeqCst) != generation
            || state.session.lookup_request.load(Ordering::SeqCst) != request
        {
            return;
        }
        state.db.save_lyrics(
            &key,
            &cache_key,
            db::TrackInfo {
                name: &track_name,
                artist: &artist,
            },
            &result,
        );
        emit_lyrics(&handle, generation, &key, &requested, result);
    });
}

fn emit_lyrics(
    app: &AppHandle,
    generation: u64,
    track_id: &str,
    requested: &str,
    result: LyricsResult,
) {
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
            requested: requested.to_string(),
        },
    );
}

/// Re-run the lookup for whatever is playing right now.
async fn refresh_current(app: &AppHandle) {
    let playback = {
        let state = app.state::<AppState>();
        let playback = state.session.current_playback.read().await.clone();
        playback
    };
    let Some(playback) = playback else { return };
    if !playback.has_track {
        return;
    }
    let generation = {
        let state = app.state::<AppState>();
        state.session.generation.load(Ordering::SeqCst)
    };
    deliver_lyrics(app, &playback, generation).await;
}

/// Forget the downloaded lyrics for the current song and look them up again.
#[tauri::command]
async fn reload_lyrics(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let key = state.session.current_track.read().await.clone();
    state.db.forget(&key);
    refresh_current(&app).await;
    Ok(())
}

/// Pin the current song to one lyrics source, or clear the pin with `None`.
///
/// The lookup runs immediately rather than at the next poll, because this is a
/// direct answer to a click.
#[tauri::command]
async fn set_track_source(
    app: AppHandle,
    track_id: String,
    source: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let key = state.session.current_track.read().await.clone();
    validate_source_track(&key, &track_id)?;
    let source = source.filter(|id| !id.is_empty());
    if let Some(id) = &source {
        if settings::provider_label(id).is_none() {
            return Err(format!("Unknown lyrics source: {id}"));
        }
    }
    state.db.set_preferred_source(&key, source.as_deref())?;
    refresh_current(&app).await;
    Ok(())
}

fn validate_source_track(current: &str, selected: &str) -> Result<(), String> {
    if current.is_empty() {
        return Err("Nothing is playing.".into());
    }
    if current != selected {
        return Err("The playing song changed. Open the source menu again.".into());
    }
    Ok(())
}

/// Transport control. A source's refusals — Premium required, no active device,
/// a button the player does not offer — arrive with its own wording, which is
/// passed through unchanged rather than matched against a string this app would
/// have to guess.
async fn with_client<F, Fut>(state: &State<'_, AppState>, action: F) -> Result<(), String>
where
    F: FnOnce(Player) -> Fut,
    Fut: std::future::Future<Output = Result<(), PlayerError>>,
{
    let client = state
        .session
        .player
        .read()
        .await
        .clone()
        .ok_or_else(|| "Not connected to a player".to_string())?;
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
    with_client(
        &state,
        |client| async move { client.seek(position_ms).await },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_selection_rejects_a_song_changed_since_the_menu_opened() {
        assert!(validate_source_track("song-b", "song-a").is_err());
        assert!(validate_source_track("", "song-a").is_err());
        assert!(validate_source_track("song-a", "song-a").is_ok());
        assert!(validate_source_track("Title|180000", "Title|180000").is_ok());
    }

    fn playback() -> Playback {
        Playback {
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
            source: PlayerKind::Spotify,
        }
    }

    /// The interface reads these names literally. A flattened struct does not
    /// inherit the wrapper's `rename_all`, so this pins every key the frontend
    /// depends on: a mismatch here silently blanks the track, disables the
    /// transport and stops the highlight, while lyrics keep working.
    #[test]
    fn playback_event_keys_match_what_the_interface_reads() {
        let event = PlaybackEvent {
            playback: playback(),
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
        for key in [
            "track_id",
            "has_track",
            "duration_ms",
            "is_playing",
            "can_seek",
        ] {
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
            requested: "netease".into(),
        };
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().unwrap();

        for key in [
            "generation",
            "trackId",
            "source",
            "synced",
            "cues",
            "text",
            "partial",
            "requested",
        ] {
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
            assert!(
                json.as_object().unwrap().contains_key(key),
                "missing key: {key}"
            );
        }
    }

    /// The settings panel reads this payload directly, including the nested
    /// settings object it posts straight back to `save_settings`.
    #[test]
    fn config_payload_keys_match_what_the_settings_panel_reads() {
        let payload = ConfigPayload {
            settings: Settings::default(),
            providers: vec![ProviderInfo {
                id: "lrclib".into(),
                label: "LRCLIB".into(),
            }],
            data_dir: "C:/Hakuro".into(),
            stored_tracks: 12,
            storage_warning: String::new(),
        };
        let json = serde_json::to_value(&payload).unwrap();
        let object = json.as_object().unwrap();

        for key in [
            "settings",
            "providers",
            "dataDir",
            "storedTracks",
            "storageWarning",
        ] {
            assert!(object.contains_key(key), "missing key: {key}");
        }
        for key in ["clientId", "sources", "theme", "followLyrics"] {
            assert!(
                object["settings"].get(key).is_some(),
                "missing settings key: {key}"
            );
        }
        for key in ["accent", "activeLine", "pastLine"] {
            assert!(
                object["settings"]["theme"].get(key).is_some(),
                "missing theme key: {key}"
            );
        }
        assert_eq!(object["providers"][0]["label"], serde_json::json!("LRCLIB"));
    }

    /// The panel posts the payload's own `settings` object back unchanged, so
    /// what serializes out has to deserialize in.
    #[test]
    fn settings_round_trip_through_the_shape_the_interface_sends_back() {
        let original = Settings::default();
        let json = serde_json::to_string(&original).unwrap();
        assert_eq!(serde_json::from_str::<Settings>(&json).unwrap(), original);
    }

    /// The database key has to survive a restart, so it is the Spotify id when
    /// there is one and never anything derived from the session.
    #[test]
    fn track_key_prefers_the_spotify_id_and_falls_back_to_title_and_length() {
        assert_eq!(track_key(&playback()), "sp:id");

        let mut local = playback();
        local.track_id = String::new();
        assert_eq!(track_key(&local), "sp:Title|180000");

        let mut stopped = playback();
        stopped.has_track = false;
        assert_eq!(track_key(&stopped), "");
    }

    /// The two sources reach the same fallback shape — title and length — so
    /// only the prefix keeps one from serving the other's cached lyrics.
    #[test]
    fn the_same_song_on_each_source_gets_its_own_database_key() {
        let mut spotify = playback();
        spotify.track_id = String::new();
        let mut ytmusic = spotify.clone();
        ytmusic.source = PlayerKind::Ytmusic;
        assert_eq!(track_key(&ytmusic), "ytm:Title|180000");
        assert_ne!(track_key(&spotify), track_key(&ytmusic));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    // Key-up would fire the toggle a second time and undo it.
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit(TOGGLE_CLICK_THROUGH, ());
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Registered here rather than on the plugin builder so that losing
            // the chord to another program costs the shortcut, not the launch.
            // The same toggle still lives in the settings panel.
            let chord = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::KeyP);
            if let Err(error) = app.global_shortcut().register(chord) {
                eprintln!("Ctrl+Alt+P is unavailable, click-through keeps its panel toggle: {error}");
            }
            Ok(())
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect,
            get_config,
            save_settings,
            clear_lyrics_cache,
            set_track_source,
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
