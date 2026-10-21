//! The one playback source the app follows, and the vocabulary every backend
//! speaks.
//!
//! A reader uses one player at a time, so this is a choice rather than a
//! merge: one backend is connected, polled and controlled, and switching tears
//! the old one down. That is why this is an enum and not a trait object — a
//! few backends, one alive, and no need for `dyn` gymnastics around async
//! methods.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::companion::Companion;
use crate::spotify::Spotify;
use crate::ytmdesktop::Ytmdesktop;

/// Which source the reader picked in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    #[default]
    Spotify,
    /// YouTube Music Desktop's Companion API, independent of ytmdesktop2.
    Ytmdesktop,
    /// YouTube Music in the ytmdesktop2 app, read through its local API, which
    /// names the exact video rather than only its title. "ytmusic" was the
    /// system media session, which is gone; a settings file that still names
    /// it follows YouTube Music here instead of failing to load at all.
    #[serde(alias = "ytmusic")]
    Ytmdesktop2,
}

impl PlayerKind {
    /// Prefixes the database key, so the sources cannot read each other's
    /// cached lyrics. Spotify falls back to title and length when it has no id
    /// of its own, which another source's key could otherwise equal. "ytm"
    /// belonged to the retired system media session; it stays unused, so its
    /// old rows are never read as a live source's.
    pub fn prefix(self) -> &'static str {
        match self {
            PlayerKind::Spotify => "sp",
            PlayerKind::Ytmdesktop => "ytmd",
            PlayerKind::Ytmdesktop2 => "ytmd2",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PlayerKind::Spotify => "Spotify",
            PlayerKind::Ytmdesktop => "ytmdesktop",
            PlayerKind::Ytmdesktop2 => "ytmdesktop2",
        }
    }

    /// Only Spotify needs a Client ID; the desktop apps pair by approval.
    pub fn needs_client_id(self) -> bool {
        matches!(self, PlayerKind::Spotify)
    }

    /// Whether the song is playing on YouTube Music, whose own lyrics are then
    /// the closest match there is.
    pub fn plays_youtube_music(self) -> bool {
        matches!(self, PlayerKind::Ytmdesktop | PlayerKind::Ytmdesktop2)
    }
}

/// Spotify's three repeat states, named as its API names them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Off,
    /// The album or playlist starts over.
    Context,
    /// The one song plays again.
    Track,
}

impl Repeat {
    pub fn as_str(self) -> &'static str {
        match self {
            Repeat::Off => "off",
            Repeat::Context => "context",
            Repeat::Track => "track",
        }
    }
}

/// What the interface needs to know about the current playback.
///
/// The interface reads these as camelCase. This rename must live here rather
/// than on the wrapping event: `#[serde(rename_all)]` does not reach through a
/// `#[serde(flatten)]`, so without it every field below reaches the interface
/// under a name it does not read.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Playback {
    pub track_id: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub album_art: Option<String>,
    /// YouTube video ids of this exact recording, the playing one first. Only a
    /// player that knows them fills this in; the interface never reads it.
    #[serde(skip)]
    pub video_ids: Vec<String>,
    pub duration_ms: i64,
    pub progress_ms: Option<i64>,
    pub is_playing: bool,
    pub has_track: bool,
    /// The source's own view of which transport actions are currently allowed.
    pub can_skip_next: bool,
    pub can_skip_previous: bool,
    pub can_seek: bool,
    pub device_name: Option<String>,
    pub device_id: Option<String>,
    pub volume_percent: Option<u8>,
    /// Native mute state when the source reports one, independent of volume.
    pub muted: Option<bool>,
    pub can_set_volume: bool,
    pub can_jump_queue: bool,
    /// Shuffle and repeat as the player reports them, or `None` when it cannot
    /// say: ytmdesktop2 only toggles them blind, so the interface hides both
    /// rather than show a state it would have to guess.
    pub shuffle: Option<bool>,
    pub repeat: Option<Repeat>,
    pub can_shuffle: bool,
    pub can_repeat_context: bool,
    pub can_repeat_track: bool,
    /// Changes when a realtime backend reports a different queue.
    pub queue_revision: Option<String>,
    /// Which backend produced this sample. Part of the database key.
    pub source: PlayerKind,
}

/// One song in the queue window.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub title: String,
    pub artists: Vec<String>,
    /// Zero when the player does not say.
    pub duration_ms: i64,
    pub art: Option<String>,
    /// What `jump` takes to reach this song, or empty when it cannot.
    pub uri: String,
}

/// The playing song and what follows it, as far as the player will tell.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub now: Option<QueueItem>,
    pub upcoming: Vec<QueueItem>,
    /// Whether a row can be played from the window.
    pub can_jump: bool,
}

/// What can go wrong, in terms every backend shares.
///
/// Spotify raises all of these; ytmdesktop2 raises all but the rate limit.
#[derive(Debug, thiserror::Error)]
pub enum PlayerError {
    /// The cached session is gone or rejected: the reader has to authorize again.
    #[error("Authorization is required")]
    NeedsAuth,
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    Network(String),
    /// The source said no, in its own wording — including Spotify's Premium
    /// refusal, whose exact text is not documented, so it is passed through as
    /// received rather than matched against a string this app would guess.
    #[error("{message}")]
    Refused { message: String },
    #[error("Rate limited")]
    RateLimited { retry_after: u64 },
}

/// Distinguishes one connection from the next, so an answer that arrives after
/// the reader switched sources can be recognised and dropped. A pointer
/// comparison cannot do this job once the client is wrapped in an enum.
static NEXT_SERIAL: AtomicU64 = AtomicU64::new(1);

enum Backend {
    Spotify(Arc<Spotify>),
    Ytmdesktop(Arc<Companion>),
    Ytmdesktop2(Arc<Ytmdesktop>),
}

#[derive(Clone)]
pub struct Player {
    /// Unique per connection, never reused.
    pub serial: u64,
    backend: Arc<Backend>,
}

impl Player {
    pub fn spotify(client: Arc<Spotify>) -> Self {
        Self::wrap(Backend::Spotify(client))
    }

    pub fn ytmdesktop2(client: Arc<Ytmdesktop>) -> Self {
        Self::wrap(Backend::Ytmdesktop2(client))
    }

    pub fn ytmdesktop(client: Arc<Companion>) -> Self {
        Self::wrap(Backend::Ytmdesktop(client))
    }

    fn wrap(backend: Backend) -> Self {
        Self {
            serial: NEXT_SERIAL.fetch_add(1, Ordering::SeqCst),
            backend: Arc::new(backend),
        }
    }

    pub fn kind(&self) -> PlayerKind {
        match self.backend.as_ref() {
            Backend::Spotify(_) => PlayerKind::Spotify,
            Backend::Ytmdesktop(_) => PlayerKind::Ytmdesktop,
            Backend::Ytmdesktop2(_) => PlayerKind::Ytmdesktop2,
        }
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.playback().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.playback().await,
            Backend::Ytmdesktop2(client) => client.playback().await,
        }
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.play().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.play().await,
            Backend::Ytmdesktop2(client) => client.play().await,
        }
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.pause().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.pause().await,
            Backend::Ytmdesktop2(client) => client.pause().await,
        }
    }

    pub async fn next(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.next().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.next().await,
            Backend::Ytmdesktop2(client) => client.next().await,
        }
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.previous().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.previous().await,
            Backend::Ytmdesktop2(client) => client.previous().await,
        }
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.seek(position_ms).await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.seek(position_ms).await,
            Backend::Ytmdesktop2(client) => client.seek(position_ms).await,
        }
    }

    pub async fn set_volume(
        &self,
        volume_percent: u8,
        device_id: Option<String>,
    ) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client
                .set_volume(volume_percent, device_id.as_deref())
                .await
                .map_err(Into::into),
            Backend::Ytmdesktop(client) => client.set_volume(volume_percent).await,
            Backend::Ytmdesktop2(client) => client.set_volume(volume_percent).await,
        }
    }

    pub async fn queue(&self) -> Result<Queue, PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.queue().await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.queue().await,
            Backend::Ytmdesktop2(client) => client.queue().await,
        }
    }

    pub async fn toggle_mute(&self) -> Result<(), PlayerError> {
        let playing = self.playback().await?;
        if let (Backend::Ytmdesktop(client), Some(muted)) = (self.backend.as_ref(), playing.muted) {
            return client.set_muted(!muted).await;
        }
        let volume = mute_fallback_volume(&playing)?;
        self.set_volume(volume, playing.device_id).await
    }

    /// Play a song further down the queue, named by its `QueueItem::uri` and
    /// the place the queue window showed it.
    pub async fn jump(&self, uri: &str, position: usize) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.jump(uri, position).await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.jump(uri, position).await,
            Backend::Ytmdesktop2(_) => Err(unsupported("Playing a queued song")),
        }
    }

    pub async fn set_shuffle(&self, on: bool) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.set_shuffle(on).await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.set_shuffle(on).await,
            Backend::Ytmdesktop2(_) => Err(unsupported("Shuffle")),
        }
    }

    pub async fn set_repeat(&self, repeat: Repeat) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.set_repeat(repeat).await.map_err(Into::into),
            Backend::Ytmdesktop(client) => client.set_repeat(repeat).await,
            Backend::Ytmdesktop2(_) => Err(unsupported("Repeat")),
        }
    }
}

fn mute_fallback_volume(playing: &Playback) -> Result<u8, PlayerError> {
    match playing.volume_percent.filter(|_| playing.can_set_volume) {
        Some(0) => Ok(100),
        Some(_) => Ok(0),
        None => Err(PlayerError::Refused {
            message: "This player or device does not support mute or volume control.".into(),
        }),
    }
}

/// ytmdesktop2's API cannot report shuffle or repeat, nor play a queued song,
/// so the interface hides those controls; this answers a caller that asks anyway.
fn unsupported(what: &str) -> PlayerError {
    PlayerError::Refused {
        message: format!("{what} is not available with ytmdesktop2."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_fallback_uses_zero_and_full_volume_only_when_supported() {
        let mut playing = Playback {
            can_set_volume: true,
            volume_percent: Some(37),
            ..Default::default()
        };
        assert_eq!(mute_fallback_volume(&playing).unwrap(), 0);
        playing.volume_percent = Some(0);
        assert_eq!(mute_fallback_volume(&playing).unwrap(), 100);
        playing.volume_percent = None;
        assert!(mute_fallback_volume(&playing).is_err());
        playing.volume_percent = Some(37);
        playing.can_set_volume = false;
        assert!(mute_fallback_volume(&playing).is_err());
    }

    #[test]
    fn every_source_gets_its_own_cache_prefix() {
        let prefixes = [
            PlayerKind::Spotify.prefix(),
            PlayerKind::Ytmdesktop.prefix(),
            PlayerKind::Ytmdesktop2.prefix(),
            // The retired system media session's rows are still in old databases.
            "ytm",
        ];
        for (index, prefix) in prefixes.iter().enumerate() {
            assert!(
                !prefixes[index + 1..].contains(prefix),
                "a shared prefix would let one source read another's cached lyrics"
            );
        }
    }

    #[test]
    fn only_spotify_asks_for_a_client_id() {
        assert!(PlayerKind::Spotify.needs_client_id());
        assert!(!PlayerKind::Ytmdesktop.needs_client_id());
        assert!(!PlayerKind::Ytmdesktop2.needs_client_id());
    }

    #[test]
    fn both_youtube_music_players_offer_native_lyrics() {
        assert!(PlayerKind::Ytmdesktop.plays_youtube_music());
        assert!(PlayerKind::Ytmdesktop2.plays_youtube_music());
        assert!(!PlayerKind::Spotify.plays_youtube_music());
    }

    #[test]
    fn the_stored_name_of_each_source_survives_a_round_trip() {
        for kind in [
            PlayerKind::Spotify,
            PlayerKind::Ytmdesktop,
            PlayerKind::Ytmdesktop2,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let back: PlayerKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, back, "settings.json must reload the chosen source");
        }
        assert_eq!(
            serde_json::to_string(&PlayerKind::Ytmdesktop).unwrap(),
            "\"ytmdesktop\""
        );
        assert_eq!(
            serde_json::to_string(&PlayerKind::Ytmdesktop2).unwrap(),
            "\"ytmdesktop2\""
        );
    }

    #[test]
    fn the_retired_media_session_choice_loads_as_ytmdesktop2() {
        let kind: PlayerKind = serde_json::from_str("\"ytmusic\"").unwrap();
        assert_eq!(kind, PlayerKind::Ytmdesktop2);
    }

    #[test]
    fn repeat_states_use_spotifys_own_names() {
        for (repeat, name) in [
            (Repeat::Off, "off"),
            (Repeat::Context, "context"),
            (Repeat::Track, "track"),
        ] {
            assert_eq!(repeat.as_str(), name);
            assert_eq!(
                serde_json::to_string(&repeat).unwrap(),
                format!("\"{name}\"")
            );
        }
    }
}
