//! The one playback source the app follows, and the vocabulary both backends
//! speak.
//!
//! A reader uses Spotify or YouTube Music, never both at once, so this is a
//! choice rather than a merge: one backend is connected, polled and controlled,
//! and switching tears the old one down. That is why this is an enum and not a
//! trait object — two backends, one alive, and no need for `dyn` gymnastics
//! around async methods.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::smtc::Smtc;
use crate::spotify::Spotify;

/// Which source the reader picked in Settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlayerKind {
    #[default]
    Spotify,
    /// Whatever the system media session reports, which is how a browser or the
    /// desktop app exposes YouTube Music.
    Ytmusic,
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
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PlayerKind::Spotify => "Spotify",
            PlayerKind::Ytmusic => "YouTube Music",
        }
    }

    /// Only Spotify needs a Client ID; the system media session needs nothing.
    pub fn needs_client_id(self) -> bool {
        matches!(self, PlayerKind::Spotify)
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
    pub duration_ms: i64,
    pub progress_ms: Option<i64>,
    pub is_playing: bool,
    pub has_track: bool,
    /// The source's own view of which transport actions are currently allowed.
    pub can_skip_next: bool,
    pub can_skip_previous: bool,
    pub can_seek: bool,
    pub device_name: Option<String>,
    /// Which backend produced this sample. Part of the database key.
    pub source: PlayerKind,
}

/// What can go wrong, in terms both backends share.
///
/// Spotify raises all of these; the system media session raises only the last
/// two, because it has no sign-in to expire and no rate limit to hit.
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

    fn wrap(backend: Backend) -> Self {
        Self {
            serial: NEXT_SERIAL.fetch_add(1, Ordering::SeqCst),
            backend: Arc::new(backend),
        }
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.playback().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.playback().await,
        }
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.play().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.play().await,
        }
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.pause().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.pause().await,
        }
    }

    pub async fn next(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.next().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.next().await,
        }
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.previous().await.map_err(Into::into),
            Backend::Ytmusic(client) => client.previous().await,
        }
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        match self.backend.as_ref() {
            Backend::Spotify(client) => client.seek(position_ms).await.map_err(Into::into),
            Backend::Ytmusic(client) => client.seek(position_ms).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_sources_get_different_cache_prefixes() {
        assert_ne!(
            PlayerKind::Spotify.prefix(),
            PlayerKind::Ytmusic.prefix(),
            "a shared prefix would let one source read the other's cached lyrics"
        );
    }

    #[test]
    fn only_spotify_asks_for_a_client_id() {
        assert!(PlayerKind::Spotify.needs_client_id());
        assert!(!PlayerKind::Ytmusic.needs_client_id());
    }

    #[test]
    fn the_stored_name_of_each_source_survives_a_round_trip() {
        for kind in [PlayerKind::Spotify, PlayerKind::Ytmusic] {
            let json = serde_json::to_string(&kind).unwrap();
            let back: PlayerKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, back, "settings.json must reload the chosen source");
        }
        assert_eq!(
            serde_json::to_string(&PlayerKind::Ytmusic).unwrap(),
            "\"ytmusic\""
        );
    }
}
