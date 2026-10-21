//! Application wiring: playback polling, lyric lookups, and the commands the
//! interface calls.
//!
//! Exactly one playback source is live: Spotify over its Web API, or YouTube
//! Music through either desktop app's local API. The choice is a
//! setting, and changing it drops the old connection so the poll loop below
//! ends and a new one starts.
//!
//! The backend owns every network call and pushes events to the frontend; the
//! frontend owns only presentation and the sub-second position extrapolation
//! that keeps the highlight smooth between polls.

mod companion;
mod db;
mod lrc;
mod matching;
mod musixmatch;
mod petitlyrics;
mod player;
mod providers;
mod settings;
mod shortcuts;
mod spotify;
mod token_store;
mod updates;
mod visualizer;
mod youtube_music;
mod ytmdesktop;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::RwLock;

use companion::Companion;
use db::Db;
use lrc::Cue;
use player::{Playback, Player, PlayerError, PlayerKind, Queue, QueueItem, Repeat};
use providers::{LyricCandidate, LyricsResult, TrackQuery};
use settings::Settings;
use spotify::Spotify;
use ytmdesktop::Ytmdesktop;

/// Local backends are sampled briskly; Companion reads its realtime cache.
const LOCAL_POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Spotify counts every request against a daily quota. While a song plays the
/// frontend extrapolates the position, so a sample only has to catch changes
/// made elsewhere — a seek on the phone, a skip from another device.
const SPOTIFY_PLAYING_INTERVAL: Duration = Duration::from_secs(5);
/// Paused or nothing loaded. Playing from another device shows up this late;
/// the refresh button, or any transport button here, asks at once.
const SPOTIFY_STOPPED_INTERVAL: Duration = Duration::from_secs(5 * 60);
/// After this long with nothing playing, Spotify is not asked at all until the
/// window comes back to the front or the reader presses refresh.
const SPOTIFY_DORMANT_AFTER: Duration = Duration::from_secs(60 * 60);
/// Slack after the predicted end of a song, so the next sample already sees
/// the next one rather than the last second of this one.
const TRACK_END_SLACK: Duration = Duration::from_millis(500);
/// Spotify reports a transport command's effect a moment after accepting it.
const AFTER_COMMAND_DELAY: Duration = Duration::from_millis(400);

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
    /// This song's `track_key`: the identity lyric events carry and the source
    /// and match commands check. The interface echoes it back as given, so it
    /// never has to rebuild the key (and its source prefix) on its own.
    track_key: String,
    /// Bumped on every track change so late lyric results can be discarded.
    generation: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LyricsEvent {
    generation: u64,
    track_id: String,
    source: String,
    matched_title: String,
    synced: bool,
    cues: Vec<Cue>,
    text: String,
    /// Set when some providers failed but another one answered.
    partial: bool,
    /// The source this track is pinned to, or empty for the normal order. The
    /// interface shows it as the current choice in the source menu.
    requested: String,
    manual: bool,
}

struct LyricPreview {
    track_key: String,
    generation: u64,
    candidate: LyricCandidate,
    lyrics: LyricsResult,
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
    /// Serialize checking a lookup revision with saving and emitting its result.
    /// Network requests never hold this lock.
    lyrics_update: tokio::sync::Mutex<()>,
    preview_request: AtomicU64,
    lyric_preview: RwLock<Option<LyricPreview>>,
    current_track: RwLock<String>,
    /// The last sample, kept so a source change can look the song up again
    /// straight away instead of waiting for the next poll.
    current_playback: RwLock<Option<Playback>>,
    polling: RwLock<bool>,
    /// Cuts the poll loop's wait short, so a button press shows at once
    /// instead of at the next sample.
    wake: tokio::sync::Notify,
    connecting: tokio::sync::Mutex<()>,
    /// Queue selection and playback form one action, including concurrent gestures.
    queue_action: tokio::sync::Mutex<()>,
}

struct AppState {
    http: reqwest::Client,
    musixmatch: musixmatch::Session,
    session: Session,
    settings: RwLock<Settings>,
    settings_update: tokio::sync::Mutex<()>,
    shortcuts: std::sync::RwLock<shortcuts::Active>,
    shortcut_warning: std::sync::RwLock<String>,
    db: Db,
    visualizer: visualizer::Visualizer,
}

impl AppState {
    fn new() -> Self {
        Self {
            http: providers::client().expect("HTTPS client must start"),
            musixmatch: musixmatch::Session::new(),
            session: Session::default(),
            settings: RwLock::new(settings::load()),
            settings_update: tokio::sync::Mutex::new(()),
            shortcuts: std::sync::RwLock::new(shortcuts::Active::new()),
            shortcut_warning: std::sync::RwLock::new(String::new()),
            db: Db::open(),
            visualizer: visualizer::Visualizer::default(),
        }
    }

    fn config(&self, settings: &Settings) -> ConfigPayload {
        ConfigPayload {
            settings: settings.clone(),
            providers: settings::available_providers(settings.player)
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
            storage_warning: [
                self.db.warning().unwrap_or_default().to_string(),
                self.shortcut_warning.read().unwrap().clone(),
            ]
            .into_iter()
            .filter(|warning| !warning.is_empty())
            .collect::<Vec<_>>()
            .join("; "),
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

#[tauri::command]
async fn check_for_updates(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let enabled = state.settings.read().await.check_updates;
    let release = updates::check(&state.http, enabled).await;
    // Turning the setting off while a request is pending also cancels its notification.
    Ok(if state.settings.read().await.check_updates {
        release
    } else {
        None
    })
}

#[tauri::command]
fn open_latest_release(app: AppHandle) -> Result<(), String> {
    app.opener()
        .open_url(updates::RELEASE_URL, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Persist the panel's contents, apply them, and reconnect if the identity changed.
#[tauri::command]
async fn save_settings(
    app: AppHandle,
    incoming: Settings,
    state: State<'_, AppState>,
) -> Result<ConfigPayload, String> {
    let update = state.settings_update.lock().await;
    let mut incoming = incoming;
    incoming.normalize();
    let desired_shortcuts = shortcuts::validate(&mut incoming.shortcuts)?;
    // An empty Client ID is allowed — it is the first-run state, and refusing
    // to save would also throw away the colours typed in the same panel.
    if !incoming.client_id.is_empty() {
        incoming.client_id = settings::validate_client_id(&incoming.client_id)?;
    }

    let previous = state.settings.read().await.clone();
    // An older settings panel must not erase an acknowledgement made meanwhile.
    incoming
        .last_seen_version
        .clone_from(&previous.last_seen_version);
    let sources_changed = incoming.sources != previous.sources;
    // Either half of the identity invalidates the open connection: a new Client
    // ID cannot reuse the cached refresh token, and a new player is a different
    // source altogether. A Client ID edited while following YouTube Music
    // changes nothing that is running, so it does not reconnect. ytmdesktop2's
    // port is where the open connection points, so moving it does.
    let identity_changed = !same_player_connection(&incoming, &previous);
    let mut active = state.shortcuts.read().unwrap().clone();
    let outcome = shortcuts::replace(
        &mut active,
        desired_shortcuts,
        |key| {
            app.global_shortcut()
                .register(key)
                .map_err(|error| format!("Cannot register {key}: {error}"))
        },
        |key| {
            app.global_shortcut()
                .unregister(key)
                .map_err(|error| format!("Cannot release {key}: {error}"))
        },
        || settings::save(&incoming),
    );
    *state.shortcuts.write().unwrap() = active;
    if let Err(error) = outcome {
        *state.shortcut_warning.write().unwrap() = error.clone();
        return Err(error);
    }
    state.shortcut_warning.write().unwrap().clear();
    *state.settings.write().await = incoming.clone();
    drop(update);

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

#[tauri::command]
async fn mark_whats_new_seen(state: State<'_, AppState>) -> Result<ConfigPayload, String> {
    let latest = acknowledge_release(&state.settings, &state.settings_update).await?;
    Ok(state.config(&latest))
}

async fn acknowledge_release(
    current: &RwLock<Settings>,
    update: &tokio::sync::Mutex<()>,
) -> Result<Settings, String> {
    let _update = update.lock().await;
    let mut latest = current.write().await;
    let mut saved = latest.clone();
    saved.last_seen_version = env!("CARGO_PKG_VERSION").into();
    settings::save(&saved)?;
    *latest = saved.clone();
    Ok(saved)
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
/// authorization; ytmdesktop2 resumes its pairing or asks for one.
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

    match settings.player {
        PlayerKind::Ytmdesktop => return connect_companion(&app, &state, &settings).await,
        PlayerKind::Ytmdesktop2 => return connect_ytmdesktop2(&app, &state, &settings).await,
        PlayerKind::Spotify => {}
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

    let session = client.connect_session().await;
    if !same_player_connection(&*state.settings.read().await, &settings) {
        return Err("The player changed while connecting. Connect again.".into());
    }
    let needs_browser = match session {
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
        let authorization = client
            .complete_authorization(verifier, expected_state)
            .await;
        if !same_player_connection(&*state.settings.read().await, &settings) {
            return Err("The player changed during authorization. Connect again.".into());
        }
        if let Err(error) = authorization {
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
    let current_settings = state.settings.read().await;
    if !same_player_connection(&current_settings, &settings) {
        return Err("The player changed during authorization. Connect again.".into());
    }
    *state.session.player.write().await = Some(Player::spotify(client));
    drop(current_settings);
    emit_status(&app, "connected", "Connected", notice);

    start_polling(&app, &state).await;
    Ok(())
}

/// Only settings that identify the active connection can invalidate its result.
fn same_player_connection(current: &Settings, requested: &Settings) -> bool {
    current.player == requested.player
        && match current.player {
            PlayerKind::Spotify => current.client_id == requested.client_id,
            PlayerKind::Ytmdesktop2 => current.ytmd_port == requested.ytmd_port,
            PlayerKind::Ytmdesktop => true,
        }
}

async fn connect_companion(
    app: &AppHandle,
    state: &State<'_, AppState>,
    requested: &Settings,
) -> Result<(), String> {
    let client = Companion::connect(|code| {
        emit_status(
            app,
            "authorizing",
            format!("Approve Hakuro in ytmdesktop - code {code}"),
            "In ytmdesktop, open Settings > Integrations, enable Companion server and Enable companion authorization, then approve Hakuro within 30 seconds.",
        )
    })
    .await;
    let current_settings = state.settings.read().await;
    if !same_player_connection(&current_settings, requested) {
        return Err("The player changed while connecting. Connect again.".into());
    }
    let client = match client {
        Ok(client) => Arc::new(client),
        Err(error) => {
            emit_status(app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    };
    let notice = [
        client.cache_warning(),
        state.db.warning().unwrap_or_default(),
    ]
    .into_iter()
    .filter(|warning| !warning.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    *state.session.player.write().await = Some(Player::ytmdesktop(client));
    drop(current_settings);
    emit_status(app, "connected", "Connected", notice);
    start_polling(app, state).await;
    Ok(())
}

/// ytmdesktop2 answers on a local port, and pairs once when its Settings ask
/// for authorization: the reader approves the code shown here in ytmdesktop2.
async fn connect_ytmdesktop2(
    app: &AppHandle,
    state: &State<'_, AppState>,
    requested: &Settings,
) -> Result<(), String> {
    let client = Ytmdesktop::connect(requested.ytmd_port, |code| {
        emit_status(
            app,
            "authorizing",
            format!("Approve Hakuro in ytmdesktop2 · code {code}"),
            "In ytmdesktop2, open Settings → API & Integrations → Authentication and approve Hakuro within 30 seconds.",
        )
    })
    .await;
    // Hold the settings read guard through installation, so a late result
    // cannot attach a backend after its source or port has been changed.
    let current_settings = state.settings.read().await;
    if !same_player_connection(&current_settings, requested) {
        return Err("The player changed while connecting. Connect again.".into());
    }
    let client = match client {
        Ok(client) => Arc::new(client),
        Err(error) => {
            emit_status(app, "error", "Connection failed", error.to_string());
            return Err(error.to_string());
        }
    };
    let notice = [
        client.cache_warning(),
        state.db.warning().unwrap_or_default(),
    ]
    .into_iter()
    .filter(|warning| !warning.is_empty())
    .collect::<Vec<_>>()
    .join(" ");
    *state.session.player.write().await = Some(Player::ytmdesktop2(client));
    drop(current_settings);
    emit_status(app, "connected", "Connected", notice);
    start_polling(app, state).await;
    Ok(())
}

async fn start_polling(app: &AppHandle, state: &State<'_, AppState>) {
    {
        let mut polling = state.session.polling.write().await;
        if *polling {
            // The running loop may be asleep for minutes, or until woken; make
            // it pick up the new client now.
            state.session.wake.notify_one();
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
    // When Spotify was last seen not playing, or None while it plays.
    let mut stopped_since: Option<Instant> = None;
    // Whether the last sample failed, so the next good one can say it recovered.
    let mut faulted = false;
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

        // Nobody is looking, or nothing has played for an hour: ask nothing
        // until the window is focused again or refresh is pressed.
        let dormant = stopped_since.is_some_and(|since| since.elapsed() >= SPOTIFY_DORMANT_AFTER);
        if dormant || window_hidden(&app) {
            if dormant {
                emit_status(&app, "idle", "Nothing playing; press refresh to check", "");
            }
            app.state::<AppState>().session.wake.notified().await;
            if dormant {
                emit_status(&app, "connected", "Connected", "");
            }
            stopped_since = None;
            continue;
        }

        let mut delay = LOCAL_POLL_INTERVAL;
        let mut interruptible = true;
        let result = client.playback().await;
        // A response from a source replaced in Settings must not reset the new
        // one. The serial is unique per connection, which a pointer comparison
        // can no longer be now that two kinds of client share one slot.
        let active = app.state::<AppState>().session.player.read().await.clone();
        if !active
            .as_ref()
            .is_some_and(|open| open.serial == client.serial)
        {
            continue;
        }
        match result {
            Ok(playback) => {
                if std::mem::take(&mut faulted) {
                    emit_status(&app, "connected", "Connected", "");
                }
                delay = poll_delay(&playback);
                if playback.source == PlayerKind::Spotify && !playback.is_playing {
                    stopped_since.get_or_insert_with(Instant::now);
                } else {
                    stopped_since = None;
                }
                apply_playback(&app, playback).await;
            }
            Err(PlayerError::NeedsAuth) => {
                let state = app.state::<AppState>();
                *state.session.player.write().await = None;
                *state.session.polling.write().await = false;
                let message = match client.kind() {
                    PlayerKind::Ytmdesktop => "ytmdesktop access revoked; reconnect to pair again",
                    PlayerKind::Ytmdesktop2 => {
                        "ytmdesktop2 access revoked; reconnect to pair again"
                    }
                    PlayerKind::Spotify => "Spotify sign-in expired",
                };
                emit_status(&app, "needs-auth", message, "");
                break;
            }
            Err(PlayerError::RateLimited { retry_after }) => {
                delay = Duration::from_secs(retry_after.max(2));
                // A refresh now would only be refused again.
                interruptible = false;
                faulted = true;
                emit_status(&app, "waiting", "Rate limited; waiting before retry", "");
            }
            Err(error) => {
                faulted = true;
                emit_status(&app, "waiting", error.to_string(), "");
            }
        }

        let state = app.state::<AppState>();
        tokio::select! {
            _ = tokio::time::sleep(delay) => {}
            _ = state.session.wake.notified(), if interruptible => {
                // Pressing refresh or a transport button counts as the reader
                // being here, so the hour before going dormant starts over.
                stopped_since = None;
                tokio::time::sleep(AFTER_COMMAND_DELAY).await;
            }
        }
    }
}

/// Minimized or hidden: nothing on screen would show a new sample.
fn window_hidden(app: &AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true)
    })
}

/// How long to wait before the next sample. Spotify is asked as rarely as the
/// display allows, but always right after the current song should have ended,
/// so the lyrics change with the song rather than up to an interval later.
fn poll_delay(playback: &Playback) -> Duration {
    if playback.source != PlayerKind::Spotify {
        return LOCAL_POLL_INTERVAL;
    }
    if !playback.has_track || !playback.is_playing {
        return SPOTIFY_STOPPED_INTERVAL;
    }
    let remaining = playback
        .progress_ms
        .map(|progress| (playback.duration_ms - progress).max(0))
        .map(|remaining| Duration::from_millis(remaining as u64) + TRACK_END_SLACK);
    match remaining {
        Some(remaining) => remaining.clamp(LOCAL_POLL_INTERVAL, SPOTIFY_PLAYING_INTERVAL),
        None => SPOTIFY_PLAYING_INTERVAL,
    }
}

/// A key that survives restarts, so the database can be read back next session.
///
/// The source is part of the key. It has to be: a song without a track id is
/// keyed by title and length, a shape any source can reach, and without a
/// prefix two sources would read each other's cached lyrics.
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

/// What the lyric sources are asked for. A player may hand over a joint credit
/// as one name, which a source may list whole or apart, so both are wanted; the
/// interface keeps showing the credit as the player gave it.
fn lyric_query(playback: &Playback) -> TrackQuery {
    TrackQuery {
        track: playback.name.clone(),
        artists: playback
            .artists
            .iter()
            .flat_map(|name| matching::split_artists(name))
            .collect(),
        album: playback.album.clone(),
        duration_ms: playback.duration_ms,
        // ytmdesktop2's track id is a YouTube video id, which Musixmatch would
        // take for a Spotify one.
        spotify_id: (playback.source == PlayerKind::Spotify && !playback.track_id.is_empty())
            .then(|| playback.track_id.clone()),
        video_ids: playback.video_ids.clone(),
    }
}

/// An automatic answer is only valid for the order that produced it; a pinned
/// one is the pinned source's.
fn lyric_cache_key(requested: &str, order: &[String]) -> String {
    match requested {
        "" => format!("auto:{}", order.join(",")),
        _ => requested.to_string(),
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
            track_key: key.clone(),
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
    let _update = state.session.lyrics_update.lock().await;
    let key = track_key(playback);
    if state.session.generation.load(Ordering::SeqCst) != generation
        || *state.session.current_track.read().await != key
    {
        return;
    }
    let request = state.session.lookup_request.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(selection) = state.db.manual_match(&key).filter(|selection| {
        selection.candidate.source != "youtube_music" || playback.source.plays_youtube_music()
    }) {
        emit_lyrics(app, generation, &key, "", selection.lyrics, true);
        return;
    }
    let requested = state
        .db
        .preferred_source(&key)
        .filter(|id| id != "youtube_music" || playback.source.plays_youtube_music())
        .unwrap_or_else(|| db::AUTO.to_string());

    let order = state.settings.read().await.lyric_order(playback.source);
    // An automatic answer is only valid for the order that produced it.
    let cache_key = lyric_cache_key(&requested, &order);
    if let Some(cached) = state.db.lyrics(&key, &cache_key) {
        emit_lyrics(app, generation, &key, &requested, cached, false);
        return;
    }

    let query = lyric_query(playback);
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
        let _update = state.session.lyrics_update.lock().await;
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
        emit_lyrics(&handle, generation, &key, &requested, result, false);
    });
}

fn emit_lyrics(
    app: &AppHandle,
    generation: u64,
    track_id: &str,
    requested: &str,
    result: LyricsResult,
    manual: bool,
) {
    let _ = app.emit(
        "lyrics",
        LyricsEvent {
            generation,
            track_id: track_id.to_string(),
            source: result.source.clone(),
            matched_title: result.matched_title,
            synced: !result.cues.is_empty(),
            cues: result.cues,
            text: result.text,
            partial: !result.errors.is_empty(),
            requested: requested.to_string(),
            manual,
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
    let (key, selection, generation, request) = {
        let _update = state.session.lyrics_update.lock().await;
        let key = state.session.current_track.read().await.clone();
        let generation = state.session.generation.load(Ordering::SeqCst);
        let request = state.session.lookup_request.fetch_add(1, Ordering::SeqCst) + 1;
        let player = state.settings.read().await.player;
        let selection = state.db.manual_match(&key).filter(|selection| {
            selection.candidate.source != "youtube_music" || player.plays_youtube_music()
        });
        if selection.is_none() {
            state.db.forget(&key);
        }
        (key, selection, generation, request)
    };
    if let Some(selection) = selection {
        let lyrics = providers::fetch_candidate(&state.http, &selection.candidate)
            .await
            .map_err(|error| format!("Could not refresh the selected lyrics: {error}"))?;
        let _update = state.session.lyrics_update.lock().await;
        let current = state.session.current_track.read().await;
        validate_source_track(&current, &key)?;
        if state.session.generation.load(Ordering::SeqCst) != generation
            || state.session.lookup_request.load(Ordering::SeqCst) != request
        {
            return Err("The lyric selection changed. Try refreshing again.".into());
        }
        let refreshed = db::ManualMatch {
            candidate: selection.candidate,
            lyrics,
        };
        state.db.save_manual_match(&key, &refreshed)?;
        emit_lyrics(&app, generation, &key, "", refreshed.lyrics, true);
        return Ok(());
    }
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
    let update = state.session.lyrics_update.lock().await;
    let key = state.session.current_track.read().await.clone();
    validate_source_track(&key, &track_id)?;
    let source = source.filter(|id| !id.is_empty());
    if let Some(id) = &source {
        if !settings::available_providers(state.settings.read().await.player)
            .iter()
            .any(|(known, _)| known == id)
        {
            return Err(format!("Unknown lyrics source: {id}"));
        }
    }
    state.db.set_preferred_source(&key, source.as_deref())?;
    state.session.lookup_request.fetch_add(1, Ordering::SeqCst);
    state.session.preview_request.fetch_add(1, Ordering::SeqCst);
    *state.session.lyric_preview.write().await = None;
    drop(update);
    refresh_current(&app).await;
    Ok(())
}

async fn validate_search_source(state: &AppState, source: &str) -> Result<(), String> {
    if !["lrclib", "netease", "qqmusic", "youtube_music"].contains(&source) {
        return Err("This source does not support manual lyric search.".into());
    }
    let settings = state.settings.read().await;
    if !settings
        .lyric_order(settings.player)
        .iter()
        .any(|id| id == source)
    {
        return Err("Enable this lyrics source in Settings first.".into());
    }
    Ok(())
}

#[tauri::command]
async fn search_lyrics(
    track_id: String,
    query: String,
    source: String,
    state: State<'_, AppState>,
) -> Result<Vec<LyricCandidate>, String> {
    validate_source_track(&state.session.current_track.read().await, &track_id)?;
    validate_search_source(&state, &source).await?;
    let generation = state.session.generation.load(Ordering::SeqCst);
    state.session.preview_request.fetch_add(1, Ordering::SeqCst);
    *state.session.lyric_preview.write().await = None;
    let candidates = providers::search_candidates(&state.http, &query, &source)
        .await
        .map_err(|error| format!("Lyrics search failed: {error}"))?;
    validate_source_track(&state.session.current_track.read().await, &track_id)?;
    if state.session.generation.load(Ordering::SeqCst) != generation {
        return Err("The playing song changed. Search again.".into());
    }
    Ok(candidates)
}

#[tauri::command]
async fn preview_lyric_candidate(
    track_id: String,
    candidate: LyricCandidate,
    state: State<'_, AppState>,
) -> Result<LyricsResult, String> {
    validate_source_track(&state.session.current_track.read().await, &track_id)?;
    validate_search_source(&state, &candidate.source).await?;
    let generation = state.session.generation.load(Ordering::SeqCst);
    let request = state.session.preview_request.fetch_add(1, Ordering::SeqCst) + 1;
    *state.session.lyric_preview.write().await = None;
    let lyrics = providers::fetch_candidate(&state.http, &candidate)
        .await
        .map_err(|error| format!("Lyric preview failed: {error}"))?;
    let current = state.session.current_track.read().await;
    validate_source_track(&current, &track_id)?;
    let mut preview = state.session.lyric_preview.write().await;
    if state.session.generation.load(Ordering::SeqCst) != generation
        || state.session.preview_request.load(Ordering::SeqCst) != request
    {
        return Err("This preview is no longer current. Select the result again.".into());
    }
    if lyrics.is_empty() {
        return Err("This result has no lyrics. Try another candidate.".into());
    }
    *preview = Some(LyricPreview {
        track_key: track_id,
        generation,
        candidate,
        lyrics: lyrics.clone(),
    });
    Ok(lyrics)
}

#[tauri::command]
async fn apply_lyric_match(
    app: AppHandle,
    track_id: String,
    candidate: LyricCandidate,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_search_source(&state, &candidate.source).await?;
    let _update = state.session.lyrics_update.lock().await;
    let current = state.session.current_track.read().await;
    validate_source_track(&current, &track_id)?;
    let generation = state.session.generation.load(Ordering::SeqCst);
    let mut preview = state.session.lyric_preview.write().await;
    let previewed = preview
        .as_ref()
        .filter(|preview| {
            preview.track_key == track_id
                && preview.generation == generation
                && preview.candidate == candidate
        })
        .ok_or_else(|| "Preview this result before saving the match.".to_string())?;
    let selection = db::ManualMatch {
        candidate,
        lyrics: previewed.lyrics.clone(),
    };
    state.db.save_manual_match(&track_id, &selection)?;
    state.session.lookup_request.fetch_add(1, Ordering::SeqCst);
    state.session.preview_request.fetch_add(1, Ordering::SeqCst);
    *preview = None;
    emit_lyrics(&app, generation, &track_id, "", selection.lyrics, true);
    Ok(())
}

#[tauri::command]
async fn clear_lyric_match(
    app: AppHandle,
    track_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    set_track_source(app, track_id, None, state).await
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
    let result = action(client).await.map_err(|error| error.to_string());
    if result.is_ok() {
        state.session.wake.notify_one();
    }
    result
}

/// Ask the source now rather than at the next sample. Also wakes a loop that
/// stopped asking after an hour of silence.
#[tauri::command]
fn refresh_playback(state: State<'_, AppState>) {
    state.session.wake.notify_one();
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
async fn toggle_mute(state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.toggle_mute().await }).await
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

#[tauri::command]
async fn set_shuffle(on: bool, state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.set_shuffle(on).await }).await
}

#[tauri::command]
async fn set_repeat(repeat: Repeat, state: State<'_, AppState>) -> Result<(), String> {
    with_client(&state, |client| async move { client.set_repeat(repeat).await }).await
}

/// Prefer the queue's current song; a previous playback poll can be stale.
#[tauri::command]
async fn get_queue(state: State<'_, AppState>) -> Result<Queue, String> {
    let client = state
        .session
        .player
        .read()
        .await
        .clone()
        .ok_or_else(|| "Not connected to a player".to_string())?;
    let mut queue = client.queue().await.map_err(|error| error.to_string())?;
    let playback = state.session.current_playback.read().await;
    fill_missing_queue_song(&mut queue, playback.as_ref(), client.kind());
    Ok(queue)
}

fn fill_missing_queue_song(queue: &mut Queue, playback: Option<&Playback>, source: PlayerKind) {
    if queue.now.is_none() {
        if let Some(playing) = playback.filter(|sample| sample.has_track && sample.source == source)
        {
            queue.now = Some(QueueItem {
                title: playing.name.clone(),
                artists: playing.artists.clone(),
                duration_ms: playing.duration_ms,
                art: playing.album_art.clone(),
                uri: String::new(),
            });
        }
    }
}

/// Play a queued song. `position` is where the window listed it.
#[tauri::command]
async fn jump_queue(uri: String, position: usize, state: State<'_, AppState>) -> Result<(), String> {
    let _queue_action = state.session.queue_action.lock().await;
    with_client(&state, |client| async move { client.jump(&uri, position).await }).await
}

#[tauri::command]
async fn random_queue_track(state: State<'_, AppState>) -> Result<(), String> {
    jump_random_queue(&state.session, |count| rand::random_range(0..count)).await
}

async fn jump_random_queue(
    session: &Session,
    choose: impl FnOnce(usize) -> usize,
) -> Result<(), String> {
    let _queue_action = session.queue_action.lock().await;
    let client = session
        .player
        .read()
        .await
        .clone()
        .ok_or_else(|| "Not connected to a player".to_string())?;
    let queue = client.queue().await.map_err(|error| error.to_string())?;
    let (position, item) = choose_queue_track(&queue, choose)?;
    // Keep the active connection stable while its queue is being advanced.
    let active = session.player.read().await;
    if !active
        .as_ref()
        .is_some_and(|open| open.serial == client.serial)
    {
        return Err("The player changed while choosing a queued song. Try again.".into());
    }
    client
        .jump(&item.uri, position)
        .await
        .map_err(|error| error.to_string())?;
    session.wake.notify_one();
    Ok(())
}

fn choose_queue_track(
    queue: &Queue,
    choose: impl FnOnce(usize) -> usize,
) -> Result<(usize, &QueueItem), String> {
    if !queue.can_jump {
        return Err("This player cannot play a queued song.".into());
    }
    let playable: Vec<_> = queue
        .upcoming
        .iter()
        .enumerate()
        .filter(|(_, item)| !item.uri.trim().is_empty())
        .collect();
    if playable.is_empty() {
        return Err("There are no playable upcoming songs in the queue.".into());
    }
    playable
        .get(choose(playable.len()))
        .copied()
        .ok_or_else(|| "Could not choose a queued song.".into())
}

/// Stream the speakers' band levels to the tile floor until `stop_wave`.
#[tauri::command]
fn start_wave(levels: Channel<Vec<u8>>, state: State<'_, AppState>) {
    state.visualizer.start(levels);
}

#[tauri::command]
fn stop_wave(state: State<'_, AppState>) {
    state.visualizer.stop();
}

#[tauri::command]
async fn set_volume(volume_percent: u8, state: State<'_, AppState>) -> Result<(), String> {
    if volume_percent > 100 {
        return Err("Volume must be between 0 and 100.".into());
    }
    let device_id = {
        let playback = state.session.current_playback.read().await;
        let Some(playback) = playback.as_ref().filter(|sample| sample.can_set_volume) else {
            return Err("This player or device does not support volume control.".into());
        };
        playback.device_id.clone()
    };
    with_client(&state, |client| async move {
        client.set_volume(volume_percent, device_id).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_queue_candidates_keep_original_positions_and_exclude_unplayable_rows() {
        let mut queue = Queue {
            now: Some(QueueItem {
                uri: "current".into(),
                ..Default::default()
            }),
            upcoming: vec![
                QueueItem::default(),
                QueueItem {
                    uri: "first".into(),
                    ..Default::default()
                },
                QueueItem {
                    uri: " ".into(),
                    ..Default::default()
                },
                QueueItem {
                    uri: "second".into(),
                    ..Default::default()
                },
            ],
            can_jump: true,
        };
        for (choice, expected_position, expected_uri) in [(0, 1, "first"), (1, 3, "second")] {
            let (position, item) = choose_queue_track(&queue, |count| {
                assert_eq!(count, 2);
                choice
            })
            .unwrap();
            assert_eq!(position, expected_position);
            assert_eq!(item.uri, expected_uri);
        }
        queue.can_jump = false;
        assert!(choose_queue_track(&queue, |_| panic!("unsupported player")).is_err());
        queue.can_jump = true;
        queue.upcoming.clear();
        assert!(choose_queue_track(&queue, |_| panic!("empty queue")).is_err());
    }

    #[test]
    fn release_acknowledgement_waits_for_settings_and_preserves_latest_edits() {
        ytmdesktop::tests::run(async {
            let current = RwLock::new(Settings::default());
            let update = tokio::sync::Mutex::new(());
            let saving = update.lock().await;
            let pending = acknowledge_release(&current, &update);
            tokio::pin!(pending);
            assert!(
                tokio::time::timeout(Duration::from_millis(10), &mut pending)
                    .await
                    .is_err()
            );
            {
                let mut settings = current.write().await;
                settings.shake_action = Some("playPause".into());
                settings.theme.accent = "#123456".into();
            }
            drop(saving);
            let saved = pending.await.unwrap();
            assert_eq!(saved.shake_action.as_deref(), Some("playPause"));
            assert_eq!(saved.theme.accent, "#123456");
            assert_eq!(saved.last_seen_version, env!("CARGO_PKG_VERSION"));
            assert_eq!(settings::load(), saved);

            current.write().await.last_seen_version = "previous".into();
            let before = current.read().await.clone();
            std::fs::create_dir(settings::data_path("settings.json.tmp").unwrap()).unwrap();
            assert!(acknowledge_release(&current, &update).await.is_err());
            assert_eq!(
                *current.read().await,
                before,
                "failed persistence must not mark the release seen"
            );
        });
    }

    #[test]
    fn the_lyric_lookup_wants_a_joint_credit_whole_and_apart() {
        // YouTube Music in Chinese: one credit, shown as it is.
        let credit = Playback {
            name: "Title".into(),
            artists: vec!["The Chainsmokers\u{548c}Coldplay".into()],
            duration_ms: 247_641,
            ..Playback::default()
        };
        assert_eq!(
            lyric_query(&credit).artists,
            [
                "The Chainsmokers\u{548c}Coldplay",
                "The Chainsmokers",
                "Coldplay"
            ]
        );
        // Spotify names each artist already.
        let listed = Playback {
            artists: vec!["First".into(), "Second".into()],
            track_id: "spotify-id".into(),
            ..credit
        };
        let query = lyric_query(&listed);
        assert_eq!(query.artists, ["First", "Second"]);
        assert_eq!(query.spotify_id.as_deref(), Some("spotify-id"));
    }

    #[test]
    fn both_desktop_apps_use_exact_youtube_videos_and_separate_lyric_caches() {
        let mut playing = Playback {
            name: "Title".into(),
            artists: vec!["Artist".into()],
            track_id: "dQw4w9WgXcQ".into(),
            video_ids: vec!["dQw4w9WgXcQ".into(), "lYBUbBu4W08".into()],
            has_track: true,
            source: PlayerKind::Ytmdesktop2,
            ..Playback::default()
        };
        for (source, prefix) in [
            (PlayerKind::Ytmdesktop, "ytmd"),
            (PlayerKind::Ytmdesktop2, "ytmd2"),
        ] {
            playing.source = source;
            let query = lyric_query(&playing);
            assert_eq!(query.spotify_id, None);
            assert_eq!(query.video_ids, ["dQw4w9WgXcQ", "lYBUbBu4W08"]);
            assert_eq!(track_key(&playing), format!("{prefix}:dQw4w9WgXcQ"));
            assert!(Settings::default()
                .lyric_order(source)
                .contains(&"youtube_music".into()));
        }
        // The interface never sees the ids; they are a backend matter.
        let event = serde_json::to_value(&playing).unwrap();
        assert!(event.get("videoIds").is_none() && event.get("video_ids").is_none());
    }

    #[test]
    fn an_automatic_answer_is_cached_per_order_and_a_pinned_one_per_source() {
        let order = vec!["youtube_music".into(), "lrclib".into()];
        assert_eq!(lyric_cache_key("", &["lrclib".into()]), "auto:lrclib");
        assert_eq!(lyric_cache_key("", &order), "auto:youtube_music,lrclib");
        assert_eq!(lyric_cache_key("youtube_music", &order), "youtube_music");
        assert_eq!(lyric_cache_key("lrclib", &order), "lrclib");
        assert_ne!(
            lyric_cache_key("", &order),
            lyric_cache_key("", &["youtube_music".into()])
        );
    }

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
            video_ids: Vec::new(),
            duration_ms: 180_000,
            progress_ms: Some(1000),
            is_playing: true,
            has_track: true,
            can_skip_next: true,
            can_skip_previous: false,
            can_seek: true,
            device_name: Some("Device".into()),
            device_id: Some("device-1".into()),
            volume_percent: Some(50),
            muted: None,
            can_set_volume: true,
            can_jump_queue: true,
            shuffle: Some(false),
            repeat: Some(Repeat::Context),
            can_shuffle: true,
            can_repeat_context: true,
            can_repeat_track: true,
            queue_revision: None,
            source: PlayerKind::Spotify,
        }
    }

    #[test]
    fn spotify_is_polled_by_state_and_catches_the_end_of_a_song() {
        let mut sample = playback();
        assert_eq!(poll_delay(&sample), SPOTIFY_PLAYING_INTERVAL);

        sample.progress_ms = Some(sample.duration_ms - 2000);
        assert_eq!(poll_delay(&sample), Duration::from_millis(2500));
        sample.progress_ms = Some(sample.duration_ms);
        assert_eq!(poll_delay(&sample), LOCAL_POLL_INTERVAL);
        sample.progress_ms = None;
        assert_eq!(poll_delay(&sample), SPOTIFY_PLAYING_INTERVAL);

        sample.is_playing = false;
        assert_eq!(poll_delay(&sample), SPOTIFY_STOPPED_INTERVAL);
        sample.has_track = false;
        assert_eq!(poll_delay(&sample), SPOTIFY_STOPPED_INTERVAL);

        sample.source = PlayerKind::Ytmdesktop2;
        assert_eq!(poll_delay(&sample), LOCAL_POLL_INTERVAL);
        sample.source = PlayerKind::Ytmdesktop;
        assert_eq!(poll_delay(&sample), LOCAL_POLL_INTERVAL);
    }

    #[test]
    fn late_connections_are_rejected_when_their_source_or_identity_changes() {
        let original = Settings::default();
        let mut current = original.clone();
        current.player = PlayerKind::Ytmdesktop;
        assert!(!same_player_connection(&current, &original));
        current.player = PlayerKind::Ytmdesktop2;
        assert!(!same_player_connection(&current, &original));

        current = original.clone();
        current.client_id = "another-client".into();
        assert!(!same_player_connection(&current, &original));

        for player in [PlayerKind::Ytmdesktop, PlayerKind::Ytmdesktop2] {
            let requested = Settings {
                player,
                ..original.clone()
            };
            let mut current = requested.clone();
            current.client_id = "irrelevant-to-local-player".into();
            assert!(same_player_connection(&current, &requested));
            current.ytmd_port = requested.ytmd_port + 1;
            assert_eq!(
                same_player_connection(&current, &requested),
                player == PlayerKind::Ytmdesktop
            );
        }
    }

    #[test]
    fn queue_snapshot_wins_over_an_older_playback_poll() {
        let current = QueueItem {
            title: "New song".into(),
            uri: "queue:8".into(),
            ..QueueItem::default()
        };
        let mut queue = Queue {
            now: Some(current.clone()),
            ..Queue::default()
        };
        let mut older = playback();
        older.source = PlayerKind::Ytmdesktop;
        fill_missing_queue_song(&mut queue, Some(&older), PlayerKind::Ytmdesktop);
        assert_eq!(queue.now, Some(current));

        queue.now = None;
        fill_missing_queue_song(&mut queue, Some(&older), PlayerKind::Ytmdesktop2);
        assert!(queue.now.is_none());
        fill_missing_queue_song(&mut queue, Some(&older), PlayerKind::Ytmdesktop);
        assert_eq!(queue.now.as_ref().unwrap().title, older.name);
        assert!(queue.now.as_ref().unwrap().uri.is_empty());
        queue.now = None;
        older.has_track = false;
        fill_missing_queue_song(&mut queue, Some(&older), PlayerKind::Ytmdesktop);
        assert!(queue.now.is_none());
    }

    /// The interface reads these names literally. A flattened struct does not
    /// inherit the wrapper's `rename_all`, so this pins every key the frontend
    /// depends on: a mismatch here silently blanks the track, disables the
    /// transport and stops the highlight, while lyrics keep working.
    #[test]
    fn playback_event_keys_match_what_the_interface_reads() {
        let event = PlaybackEvent {
            playback: playback(),
            track_key: "spotify:id".into(),
            generation: 7,
        };
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().unwrap();

        for key in [
            "trackId",
            "trackKey",
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
            "deviceId",
            "volumePercent",
            "muted",
            "canSetVolume",
            "canJumpQueue",
            "shuffle",
            "repeat",
            "canShuffle",
            "canRepeatContext",
            "canRepeatTrack",
            "queueRevision",
            "generation",
        ] {
            assert!(object.contains_key(key), "missing key: {key}");
        }
        // Nothing may reach the interface under its Rust spelling.
        for key in [
            "track_id",
            "track_key",
            "has_track",
            "duration_ms",
            "is_playing",
            "can_seek",
            "volume_percent",
            "can_set_volume",
            "can_jump_queue",
            "queue_revision",
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
            matched_title: "Alternate title".into(),
            synced: true,
            cues: vec![Cue {
                time_ms: 1000,
                text: "LINE_A".into(),
                ..Default::default()
            }],
            text: "LINE_A".into(),
            partial: false,
            requested: "netease".into(),
            manual: false,
        };
        let json = serde_json::to_value(&event).unwrap();
        let object = json.as_object().unwrap();

        for key in [
            "generation",
            "trackId",
            "source",
            "matchedTitle",
            "synced",
            "cues",
            "text",
            "partial",
            "requested",
            "manual",
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
        for key in ["clientId", "ytmdPort", "sources", "theme", "followLyrics"] {
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
        let mut ytmd = spotify.clone();
        ytmd.source = PlayerKind::Ytmdesktop;
        assert_eq!(track_key(&ytmd), "ytmd:Title|180000");
        assert_ne!(track_key(&spotify), track_key(&ytmd));
        let companion_key = track_key(&ytmd);
        ytmd.source = PlayerKind::Ytmdesktop2;
        assert_eq!(track_key(&ytmd), "ytmd2:Title|180000");
        assert_ne!(track_key(&spotify), track_key(&ytmd));
        assert_ne!(companion_key, track_key(&ytmd));
    }

    /// Read-only: needs ytmdesktop2 running with its API on the default port
    /// and a song loaded. Nothing is played, paused or changed.
    #[tokio::test]
    #[ignore = "local ytmdesktop2 with a song loaded"]
    async fn live_ytmdesktop2_lyrics_follow_the_playing_video() {
        let client = Ytmdesktop::connect(ytmdesktop::DEFAULT_PORT, |code| {
            panic!("pairing needed (code {code}); turn off authorization for this test")
        })
        .await
        .unwrap();
        let playing = client.playback().await.unwrap();
        println!(
            "{:?} | {:?} | {:?} | {} ms at {:?} playing={} volume={:?} art={:?} ids={:?}",
            playing.name,
            playing.artists,
            playing.album,
            playing.duration_ms,
            playing.progress_ms,
            playing.is_playing,
            playing.volume_percent,
            playing.album_art,
            playing.video_ids,
        );
        assert!(playing.has_track, "load a song in ytmdesktop2 first");
        assert_eq!(track_key(&playing), format!("ytmd2:{}", playing.track_id));
        tokio::time::sleep(LOCAL_POLL_INTERVAL).await;
        let next = client.playback().await.unwrap();
        println!(
            "next sample: playing={} at {:?}",
            next.is_playing, next.progress_ms
        );

        let started = Instant::now();
        let lyrics = providers::fetch_lyrics(
            &providers::client().unwrap(),
            &musixmatch::Session::new(),
            &lyric_query(&playing),
            &settings::Settings::default().lyric_order(PlayerKind::Ytmdesktop2),
        )
        .await;
        println!(
            "{} in {:?}: {} cues, {} chars plain, errors {:?}",
            lyrics.source,
            started.elapsed(),
            lyrics.cues.len(),
            lyrics.text.len(),
            lyrics.errors
        );
        assert!(!lyrics.cues.is_empty() || !lyrics.text.is_empty());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state != ShortcutState::Pressed {
                        return;
                    }
                    if let Some(settings) = app.get_webview_window("settings") {
                        if settings.is_focused().unwrap_or(false) {
                            let _ = settings.emit("shortcut:capture", shortcuts::canonical(*shortcut));
                            return;
                        }
                    }
                    let state = app.state::<AppState>();
                    let action = state
                        .shortcuts
                        .read()
                        .unwrap()
                        .get(&shortcut.id())
                        .map(|(_, action)| action.clone());
                    if let (Some(action), Some(main)) = (action, app.get_webview_window("main")) {
                        let _ = main.emit("shortcut", action);
                    }
                })
                .build(),
        )
        .setup(|app| {
            // Conflicts are recoverable in Settings and never prevent startup.
            let state = app.state::<AppState>();
            let mut bindings = state
                .settings
                .try_read()
                .expect("settings are uncontended at startup")
                .shortcuts
                .clone();
            match shortcuts::validate(&mut bindings) {
                Ok(desired) => {
                    state
                        .settings
                        .try_write()
                        .expect("settings are uncontended at startup")
                        .shortcuts = bindings;
                    let mut active = shortcuts::Active::new();
                    let mut warnings = Vec::new();
                    for (id, (key, action)) in desired {
                        match app.global_shortcut().register(key) {
                            Ok(()) => {
                                active.insert(id, (key, action));
                            }
                            Err(error) => warnings.push(format!("Cannot register {key}: {error}")),
                        }
                    }
                    *state.shortcuts.write().unwrap() = active;
                    *state.shortcut_warning.write().unwrap() = warnings.join("; ");
                }
                Err(error) => *state.shortcut_warning.write().unwrap() = error,
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Coming back to the front resumes a loop paused while minimized,
            // hidden, or dormant, and brings the display up to date.
            if let WindowEvent::Focused(true) = event {
                window.state::<AppState>().session.wake.notify_one();
            }
        })
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            connect,
            get_config,
            check_for_updates,
            open_latest_release,
            save_settings,
            mark_whats_new_seen,
            clear_lyrics_cache,
            set_track_source,
            reload_lyrics,
            search_lyrics,
            preview_lyric_candidate,
            apply_lyric_match,
            clear_lyric_match,
            refresh_playback,
            play,
            pause,
            next_track,
            previous_track,
            set_volume,
            toggle_mute,
            seek,
            set_shuffle,
            set_repeat,
            get_queue,
            jump_queue,
            random_queue_track,
            start_wave,
            stop_wave
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
