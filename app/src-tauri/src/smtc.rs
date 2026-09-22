//! YouTube Music by way of the Windows system media session (SMTC).
//!
//! YouTube Music has no "what is playing" API, so the app reads what Windows
//! already knows: whatever the browser or the desktop app publishes through
//! `Windows.Media.Control`. That needs no sign-in, no Client ID and no second
//! program, and it reports title, artist, album, length, position and the
//! transport buttons the player is willing to accept.
//!
//! Two facts from measuring this against a browser on 2026-09-22 shape the code
//! below:
//!
//! * A browser writes `Position` once and never refreshes it while playing, so
//!   the position now is that anchor plus the time since Windows last touched
//!   it. Pausing, resuming, seeking and changing track all refresh the anchor
//!   within 300 ms, so the estimate recalibrates on every interaction.
//! * At a track change the album arrives about half a second after the title,
//!   so a lookup fired the instant the title changes searches without it.
//!
//! WinRT wants an apartment per thread and the poll runs on whichever Tokio
//! worker is free, so every call is funnelled to one owned thread that
//! initializes once.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use tokio::sync::{mpsc, oneshot};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::player::{Playback, PlayerError, PlayerKind};

/// WinRT counts in 100 ns units.
const TICKS_PER_MS: i64 = 10_000;
/// WinRT `DateTime` counts from 1601-01-01 UTC, Unix time from 1970.
const SECONDS_1601_TO_1970: i64 = 11_644_473_600;
/// Long enough for the album to land after a track change, short enough that
/// the lyrics do not visibly lag the song. Measured at about 500 ms.
const SETTLE: Duration = Duration::from_millis(600);
/// Artwork larger than this is not album art; refuse it rather than inline
/// megabytes into an event.
const MAX_ART_BYTES: u64 = 4 * 1024 * 1024;

/// Separators that reliably mean "several artists". An ampersand is deliberately
/// absent: it appears inside single names often enough to split the wrong ones.
const ARTIST_SEPARATORS: [char; 3] = [',', '\u{3001}', '\u{ff0c}'];

fn now_ticks() -> i64 {
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    (unix.as_secs() as i64 + SECONDS_1601_TO_1970) * 10_000_000 + (unix.subsec_nanos() as i64 / 100)
}

/// Split a single SMTC artist string into the names a lyrics source can match.
///
/// Both the whole string and its parts are wanted: `matching::matches` needs one
/// name to overlap, and a source may list "A, B" as one name or as two.
pub fn split_artists(value: &str) -> Vec<String> {
    let value = value.trim();
    if value.is_empty() {
        return Vec::new();
    }
    let mut names = vec![value.to_string()];
    for part in value.split(ARTIST_SEPARATORS) {
        let part = part.trim();
        if !part.is_empty() && !names.iter().any(|known| known == part) {
            names.push(part.to_string());
        }
    }
    names
}

/// Where the position is now, given an anchor Windows may not have refreshed.
///
/// Only a playing track moves on its own; a paused one sits exactly where the
/// anchor says, because pausing refreshes it.
pub fn position_now(
    anchor_ms: i64,
    anchor_age_ms: i64,
    start_ms: i64,
    duration_ms: i64,
    playing: bool,
) -> i64 {
    let elapsed = if playing { anchor_age_ms.max(0) } else { 0 };
    let position = anchor_ms - start_ms + elapsed;
    if duration_ms > 0 {
        position.clamp(0, duration_ms)
    } else {
        position.max(0)
    }
}

/// A Spotify session in the list is not what a reader who picked YouTube Music
/// is watching, so it is skipped.
fn is_spotify(id: &str) -> bool {
    id.to_ascii_lowercase().contains("spotify")
}

fn app_id(session: &Session) -> String {
    session
        .SourceAppUserModelId()
        .map(|id| id.to_string())
        .unwrap_or_default()
}

/// The session to follow: the one Windows calls current, unless that is Spotify.
///
/// A browser publishes every tab under a single application id, so media playing
/// in another tab can be picked up here. Left as is for now.
fn pick_session(manager: &Manager) -> Option<Session> {
    if let Ok(current) = manager.GetCurrentSession() {
        if !is_spotify(&app_id(&current)) {
            return Some(current);
        }
    }
    let sessions = manager.GetSessions().ok()?;
    sessions.into_iter().find(|s| !is_spotify(&app_id(s)))
}

fn read_art(reference: &IRandomAccessStreamReference) -> Option<String> {
    let stream = reference.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?;
    if size == 0 || size > MAX_ART_BYTES {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    let loaded = reader.LoadAsync(size as u32).ok()?.join().ok()?;
    let mut bytes = vec![0u8; loaded as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = stream
        .ContentType()
        .map(|value| value.to_string())
        .ok()
        .filter(|value| value.starts_with("image/"))
        .unwrap_or_else(|| "image/jpeg".to_string());
    let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Some(format!("data:{mime};base64,{encoded}"))
}

/// What one look at the session yields, before it becomes a `Playback`.
struct Sample {
    title: String,
    artist: String,
    album: String,
    art: Option<String>,
    status: Status,
    anchor_ms: i64,
    anchor_age_ms: i64,
    start_ms: i64,
    end_ms: i64,
    can_next: bool,
    can_previous: bool,
    can_seek: bool,
    app: String,
}

fn read_sample(session: &Session) -> Option<Sample> {
    let props = session
        .TryGetMediaPropertiesAsync()
        .and_then(|op| op.join())
        .ok()?;
    let timeline = session.GetTimelineProperties().ok()?;
    let info = session.GetPlaybackInfo().ok()?;
    let controls = info.Controls().ok();
    let ms = |value: windows::Foundation::TimeSpan| value.Duration / TICKS_PER_MS;
    let anchor_updated = timeline
        .LastUpdatedTime()
        .map(|value| value.UniversalTime)
        .unwrap_or_default();
    Some(Sample {
        title: props.Title().map(|v| v.to_string()).unwrap_or_default(),
        artist: props.Artist().map(|v| v.to_string()).unwrap_or_default(),
        album: props.AlbumTitle().map(|v| v.to_string()).unwrap_or_default(),
        art: props.Thumbnail().ok().as_ref().and_then(read_art),
        status: info.PlaybackStatus().unwrap_or(Status::Closed),
        anchor_ms: timeline.Position().map(ms).unwrap_or_default(),
        anchor_age_ms: (now_ticks() - anchor_updated) / TICKS_PER_MS,
        start_ms: timeline.StartTime().map(ms).unwrap_or_default(),
        end_ms: timeline.EndTime().map(ms).unwrap_or_default(),
        can_next: controls
            .as_ref()
            .and_then(|c| c.IsNextEnabled().ok())
            .unwrap_or(false),
        can_previous: controls
            .as_ref()
            .and_then(|c| c.IsPreviousEnabled().ok())
            .unwrap_or(false),
        can_seek: controls
            .as_ref()
            .and_then(|c| c.IsPlaybackPositionEnabled().ok())
            .unwrap_or(false),
        app: app_id(session),
    })
}

/// Remembers the song last reported, so a track change can be waited out once.
#[derive(Default)]
struct Watch {
    title: String,
}

impl Watch {
    fn sample(&mut self, manager: &Manager) -> Playback {
        let nothing = Playback {
            source: PlayerKind::Ytmusic,
            ..Default::default()
        };
        let Some(session) = pick_session(manager) else {
            self.title.clear();
            return nothing;
        };
        let Some(mut sample) = read_sample(&session) else {
            self.title.clear();
            return nothing;
        };

        // The album lands about half a second after the title, so a song seen
        // for the first time is read twice — and the second read is kept only
        // if it is still the same song, in case the reader skipped again while
        // this waited.
        if !sample.title.is_empty() && sample.title != self.title {
            std::thread::sleep(SETTLE);
            if let Some(settled) = read_sample(&session) {
                if settled.title == sample.title {
                    sample = settled;
                }
            }
        }
        self.title = sample.title.clone();

        let duration_ms = (sample.end_ms - sample.start_ms).max(0);
        let playing = sample.status == Status::Playing;
        let has_track =
            !sample.title.is_empty() && !matches!(sample.status, Status::Closed | Status::Stopped);
        if !has_track {
            return nothing;
        }
        let progress = position_now(
            sample.anchor_ms,
            sample.anchor_age_ms,
            sample.start_ms,
            duration_ms,
            playing,
        );
        Playback {
            // The system media session has no stable track id, so the database
            // key falls back to title and length.
            track_id: String::new(),
            name: sample.title,
            artists: split_artists(&sample.artist),
            album: sample.album,
            album_art: sample.art,
            duration_ms,
            progress_ms: Some(progress),
            is_playing: playing,
            has_track: true,
            can_skip_next: sample.can_next,
            can_skip_previous: sample.can_previous,
            can_seek: sample.can_seek,
            device_name: (!sample.app.is_empty()).then_some(sample.app),
            source: PlayerKind::Ytmusic,
        }
    }
}

enum Control {
    Play,
    Pause,
    Next,
    Previous,
    Seek(i64),
}

impl Control {
    fn apply(self, manager: &Manager) -> Result<(), PlayerError> {
        let session = pick_session(manager).ok_or_else(|| PlayerError::Refused {
            message: "Nothing is playing.".into(),
        })?;
        let accepted = match self {
            Control::Play => session.TryPlayAsync().and_then(|op| op.join()),
            Control::Pause => session.TryPauseAsync().and_then(|op| op.join()),
            Control::Next => session.TrySkipNextAsync().and_then(|op| op.join()),
            Control::Previous => session.TrySkipPreviousAsync().and_then(|op| op.join()),
            Control::Seek(position_ms) => {
                // The requested position is absolute on the session's timeline,
                // which does not have to begin at zero.
                let start_ms = session
                    .GetTimelineProperties()
                    .and_then(|t| t.StartTime())
                    .map(|v| v.Duration / TICKS_PER_MS)
                    .unwrap_or_default();
                session
                    .TryChangePlaybackPositionAsync((position_ms + start_ms) * TICKS_PER_MS)
                    .and_then(|op| op.join())
            }
        };
        match accepted {
            Ok(true) => Ok(()),
            // The player answered and said no — usually the action is not one it
            // offers, which the transport buttons already reflect.
            Ok(false) => Err(PlayerError::Refused {
                message: "The player did not accept that.".into(),
            }),
            Err(_) => Err(PlayerError::Network(
                "The system media session is not answering.".into(),
            )),
        }
    }
}

enum Request {
    Playback(oneshot::Sender<Playback>),
    Control(Control, oneshot::Sender<Result<(), PlayerError>>),
}

/// A handle to the thread that owns the WinRT apartment.
pub struct Smtc {
    requests: mpsc::UnboundedSender<Request>,
}

impl Smtc {
    pub async fn connect() -> Result<Self, PlayerError> {
        let (requests, incoming) = mpsc::unbounded_channel();
        let (ready, started) = oneshot::channel();
        std::thread::Builder::new()
            .name("smtc".into())
            .spawn(move || run(incoming, ready))
            .map_err(|_| PlayerError::Config("Cannot start the media session reader.".into()))?;
        match started.await {
            Ok(Ok(())) => Ok(Self { requests }),
            Ok(Err(message)) => Err(PlayerError::Config(message)),
            Err(_) => Err(PlayerError::Config(
                "The media session reader stopped before it started.".into(),
            )),
        }
    }

    fn gone() -> PlayerError {
        PlayerError::Network("The media session reader stopped.".into())
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        let (reply, answer) = oneshot::channel();
        self.requests
            .send(Request::Playback(reply))
            .map_err(|_| Self::gone())?;
        answer.await.map_err(|_| Self::gone())
    }

    async fn control(&self, control: Control) -> Result<(), PlayerError> {
        let (reply, answer) = oneshot::channel();
        self.requests
            .send(Request::Control(control, reply))
            .map_err(|_| Self::gone())?;
        answer.await.map_err(|_| Self::gone())?
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        self.control(Control::Play).await
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        self.control(Control::Pause).await
    }

    pub async fn next(&self) -> Result<(), PlayerError> {
        self.control(Control::Next).await
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        self.control(Control::Previous).await
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        self.control(Control::Seek(position_ms)).await
    }
}

/// The owned thread: one apartment, one manager, requests until the handle drops.
fn run(mut incoming: mpsc::UnboundedReceiver<Request>, ready: oneshot::Sender<Result<(), String>>) {
    // Already-initialized is a success here; this thread only ever wants the
    // multi-threaded apartment.
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
    let manager = match Manager::RequestAsync().and_then(|op| op.join()) {
        Ok(manager) => {
            let _ = ready.send(Ok(()));
            manager
        }
        Err(_) => {
            let _ = ready.send(Err(
                "Windows did not hand over the media session list.".into()
            ));
            return;
        }
    };

    let mut watch = Watch::default();
    while let Some(request) = incoming.blocking_recv() {
        match request {
            Request::Playback(reply) => {
                let _ = reply.send(watch.sample(&manager));
            }
            Request::Control(control, reply) => {
                let _ = reply.send(control.apply(&manager));
            }
        }
    }
    // No `RoUninitialize`: the thread ends with the connection, and the manager
    // above is still in scope until it does.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_playing_track_advances_from_an_anchor_windows_never_refreshes() {
        // A browser sets the position once and leaves it there, so four seconds
        // later the song is four seconds further along.
        assert_eq!(position_now(10_000, 4_000, 0, 200_000, true), 14_000);
    }

    #[test]
    fn a_paused_track_sits_where_the_anchor_says() {
        // Pausing refreshes the anchor, so no time is added on top of it.
        assert_eq!(position_now(12_788, 4_000, 0, 200_000, false), 12_788);
    }

    #[test]
    fn the_position_never_runs_past_the_end_of_the_song() {
        assert_eq!(position_now(190_000, 60_000, 0, 200_000, true), 200_000);
    }

    #[test]
    fn a_timeline_that_does_not_start_at_zero_still_reports_from_the_start() {
        assert_eq!(position_now(35_000, 0, 30_000, 100_000, false), 5_000);
    }

    #[test]
    fn an_unknown_length_does_not_clamp_the_position_to_nothing() {
        assert_eq!(position_now(9_000, 1_000, 0, 0, true), 10_000);
    }

    #[test]
    fn one_artist_stays_one_name() {
        assert_eq!(split_artists("Jess Lee"), vec!["Jess Lee".to_string()]);
    }

    #[test]
    fn several_artists_are_offered_whole_and_in_parts() {
        // A lyrics source may store either form, and only one has to match.
        assert_eq!(
            split_artists("Aimer, Jess Lee"),
            vec![
                "Aimer, Jess Lee".to_string(),
                "Aimer".to_string(),
                "Jess Lee".to_string()
            ]
        );
    }

    #[test]
    fn an_ampersand_is_left_alone_because_names_contain_it() {
        assert_eq!(
            split_artists("Simon & Garfunkel"),
            vec!["Simon & Garfunkel".to_string()]
        );
    }

    #[test]
    fn no_artist_yields_no_names() {
        assert!(split_artists("   ").is_empty());
    }

    #[test]
    fn a_spotify_session_is_recognised_whatever_its_casing() {
        assert!(is_spotify("Spotify.exe"));
        assert!(is_spotify("SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify"));
        assert!(!is_spotify("Vivaldi"));
        assert!(!is_spotify(""));
    }
}
