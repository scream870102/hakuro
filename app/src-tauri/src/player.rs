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

use crate::smtc::Smtc;
use crate::spotify::Spotify;
use crate::ytmdesktop::Ytmdesktop;

/// Which source the reader picked in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    #[default]
    Spotify,
    /// Whatever the system media session reports, which is how a browser or the
    /// desktop app exposes YouTube Music.
    Ytmusic,
    /// YouTube Music in the ytmdesktop2 app, read through its local API, which
    /// names the exact video rather than only its title.
    Ytmdesktop2,
}

impl PlayerKind {
    /// Prefixes the database key, so the two sources cannot read each other's
    /// cached lyrics. They have to differ: YouTube Music has no track id, so its
    /// key falls back to title and length, which Spotify also does when it has
    /// no id of its own.
    pub fn prefix(self) -> &'static str {
        match self {
            PlayerKind::Spotify => "sp",
            PlayerKind::Ytmusic => "ytm",
            PlayerKind::Ytmdesktop2 => "ytmd2",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PlayerKind::Spotify => "Spotify",
            PlayerKind::Ytmusic => "YouTube Music",
            PlayerKind::Ytmdesktop2 => "ytmdesktop2",
        }
    }

    /// Only Spotify needs a Client ID; the system media session needs nothing,
    /// and ytmdesktop2 pairs by approval instead.
    pub fn needs_client_id(self) -> bool {
        matches!(self, PlayerKind::Spotify)
    }

    /// Whether the song is playing on YouTube Music, whose own lyrics are then
    /// the closest match there is.
    pub fn plays_youtube_music(self) -> bool {
        matches!(self, PlayerKind::Ytmusic | PlayerKind::Ytmdesktop2)
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
    pub can_set_volume: bool,
    /// Which backend produced this sample. Part of the database key.
    pub source: PlayerKind,
}

/// What can go wrong, in terms every backend shares.
///
/// Spotify raises all of these; the system media session raises only the last
/// two, because it has no sign-in to expire and no rate limit to hit;
/// ytmdesktop2 raises all but the rate limit.
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
    Ytmusic(Arc<Smtc>),
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

    pub fn ytmusic(client: Arc<Smtc>) -> Self {
        Self::wrap(Backend::Ytmusic(client))
    }

    pub fn ytmdesktop2(client: Arc<Ytmdesktop>) -> Self {
        Self::wrap(Backend::Ytmdesktop2(client))
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
            Backend::Ytmusic(_) => PlayerKind::Ytmusic,
            Backend::Ytmdesktop2(_) => PlayerKind::Ytmdesktop2,
        }
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.playback().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.playback().await,
            Backend::Ytmdesktop2(client) => client.playback().await,
        }
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.play().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.play().await,
            Backend::Ytmdesktop2(client) => client.play().await,
        }
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.pause().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.pause().await,
            Backend::Ytmdesktop2(client) => client.pause().await,
        }
    }

    pub async fn next(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.next().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.next().await,
            Backend::Ytmdesktop2(client) => client.next().await,
        }
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.previous().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.previous().await,
            Backend::Ytmdesktop2(client) => client.previous().await,
        }
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.seek(position_ms).await.map_err(Into::into),
            Backend::Ytmusic(client) => client.seek(position_ms).await,
            Backend::Ytmdesktop2(client) => client.seek(position_ms).await,
        }
    }

    pub async fn set_volume(
        &self,
        volume_percent: u8,
        device_id: Option<String>,
    ) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.set_volume(volume_percent, device_id.as_deref()).await.map_err(Into::into),
            Backend::Ytmusic(_) => Err(PlayerError::Refused {
                message: "Change volume in YouTube Music; its media session does not expose volume control.".into(),
            }),
            Backend::Ytmdesktop2(client) => client.set_volume(volume_percent).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_source_gets_its_own_cache_prefix() {
        let prefixes = [
            PlayerKind::Spotify.prefix(),
            PlayerKind::Ytmusic.prefix(),
            PlayerKind::Ytmdesktop2.prefix(),
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
        assert!(!PlayerKind::Ytmusic.needs_client_id());
        assert!(!PlayerKind::Ytmdesktop2.needs_client_id());
    }

    #[test]
    fn both_youtube_music_players_offer_its_own_lyrics() {
        assert!(PlayerKind::Ytmusic.plays_youtube_music());
        assert!(PlayerKind::Ytmdesktop2.plays_youtube_music());
        assert!(!PlayerKind::Spotify.plays_youtube_music());
    }

    #[test]
    fn the_stored_name_of_each_source_survives_a_round_trip() {
        for kind in [
            PlayerKind::Spotify,
            PlayerKind::Ytmusic,
            PlayerKind::Ytmdesktop2,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let back: PlayerKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, back, "settings.json must reload the chosen source");
        }
        assert_eq!(
            serde_json::to_string(&PlayerKind::Ytmusic).unwrap(),
            "\"ytmusic\""
        );
        assert_eq!(
            serde_json::to_string(&PlayerKind::Ytmdesktop2).unwrap(),
            "\"ytmdesktop2\""
        );
    }
}
