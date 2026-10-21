//! YouTube Music by way of ytmdesktop2's local API.
//!
//! A system media session only carries what the player shows — a title and a
//! credit, both in the reader's language — so lyrics for it would have to be
//! found by searching. ytmdesktop2 (github.com/Venipa/ytmdesktop2) plays YouTube Music in
//! its own window and serves what its player knows on 127.0.0.1, including the
//! exact video id, and that id is what YouTube Music's own lyrics are fetched by.
//!
//! The protocol was read from ytmdesktop2 v1.8.3's source as well as its docs,
//! because the two disagree on one point: `/track/seek` takes milliseconds
//! (`api-controls.cmds.ts`), not the seconds `routes.mdx` states.
//!
//! * `GET /` is always public and says whether a token is required.
//! * `GET /track` and `GET /track/state` answer `null` when nothing is loaded;
//!   progress and duration are seconds.
//! * `POST /track/volume` without a volume answers the current one unchanged.
//! * `GET /nav/queue` lists the whole queue, played songs included, as
//!   `{index, videoId?, title?}`: no artist, length or picture, and no marker
//!   for the playing one. It is read from the page, so it hangs while nothing
//!   is loaded. Nothing in the API plays a queued song, and shuffle and repeat
//!   can only be toggled blind, so those are left alone.
//! * Pairing: `POST /auth/requestcode` gives a code that ytmdesktop2 lists under
//!   Settings → API & Integrations → Authentication; `POST /auth/request` then
//!   waits until the reader approves (ytmdesktop2 gives up after 30 s) and
//!   answers the token. Codes expire after 60 s.
//!
//! It also pushes the same state over a WebSocket. Polling at the local
//! interval keeps one loop for every player and needs no WebSocket client.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::player::{Playback, PlayerError, PlayerKind, Queue, QueueItem};
use crate::token_store;

pub const DEFAULT_PORT: u16 = 13091;
/// The ports ytmdesktop2's own Settings accepts.
pub const PORTS: std::ops::RangeInclusive<u16> = 9999..=39999;

/// How ytmdesktop2 lists this app among its paired clients. Its rules: the id
/// is 2–32 lowercase letters or digits, the version semver.
const APP_ID: &str = "hakuro";
const APP_NAME: &str = "Hakuro";

const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
/// Commands are answered by ytmdesktop2's YouTube Music page, and measured on
/// 2026-10-20 they hang, never answering, while that page has nothing loaded.
/// The volume is read every sample, so it gets a short leash.
const VOLUME_TIMEOUT: Duration = Duration::from_secs(1);
/// Longer than ytmdesktop2's own 30 s, so its answer, not ours, ends the wait.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(40);

/// YouTube names an artist's auto-generated channel "<artist> - Topic".
const TOPIC_SUFFIX: &str = " - Topic";

pub struct Ytmdesktop {
    http: reqwest::Client,
    base: String,
    port: u16,
    /// `None` when ytmdesktop2 does not ask for one.
    token: Option<String>,
    /// Set when a fresh token could not be stored, so pairing will be asked for
    /// again after a restart.
    warning: String,
    /// The previous sample's song and position, to tell playing from paused
    /// when ytmdesktop2's own flag lags.
    last: Mutex<Option<Position>>,
}

/// Where a song was, whether ytmdesktop2 called it playing, and when that was
/// read.
#[derive(Clone)]
struct Position {
    id: String,
    progress_ms: i64,
    flagged_playing: bool,
    at: Instant,
}

/// Measured 2026-10-20: after ytmdesktop2 is sent to another song, it reports
/// `playing: false` for a quarter of a minute or more while the position runs
/// on. Two samples in a row flagged paused whose position moved at about the
/// speed of the clock are taken as playing; a seek jumps too far, a pause not
/// at all. A flag that just turned to paused is always believed: the song ran
/// until the moment it was paused, which would otherwise read as moving.
fn moving(previous: Option<&Position>, now: &Position) -> bool {
    let Some(previous) = previous.filter(|previous| {
        previous.id == now.id && !previous.flagged_playing && !now.flagged_playing
    }) else {
        return false;
    };
    let elapsed = now.at.saturating_duration_since(previous.at).as_millis() as i64;
    let advanced = now.progress_ms - previous.progress_ms;
    // Beyond a few intervals the window was hidden or the samples failed, and
    // the old position says nothing about now.
    (500..=5_000).contains(&elapsed) && advanced * 2 >= elapsed && advanced <= elapsed * 2
}

impl Ytmdesktop {
    /// Find ytmdesktop2's API on `port` and get past its authorization, pairing
    /// if needed. `show_code` gets the code the reader will see in ytmdesktop2
    /// while it waits for their approval.
    pub async fn connect(port: u16, show_code: impl FnOnce(&str)) -> Result<Self, PlayerError> {
        Self::connect_to(format!("http://127.0.0.1:{port}"), port, show_code).await
    }

    async fn connect_to(
        base: String,
        port: u16,
        show_code: impl FnOnce(&str),
    ) -> Result<Self, PlayerError> {
        let http = reqwest::Client::builder()
            // A system proxy has no business seeing a loopback request.
            .no_proxy()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|error| PlayerError::Config(error.to_string()))?;
        let mut client = Self {
            http,
            base,
            port,
            token: None,
            warning: String::new(),
            last: Mutex::new(None),
        };

        let root = client
            .http
            .get(&client.base)
            .send()
            .await
            .map_err(|error| client.unreachable(&error))?;
        let root: Value = root.json().await.unwrap_or(Value::Null);
        // Something else may own the port; only ytmdesktop2 names itself so.
        if !root["name"]
            .as_str()
            .is_some_and(|name| name.to_ascii_lowercase().contains("ytmdesktop2"))
        {
            return Err(PlayerError::Config(format!(
                "Port {port} does not answer as ytmdesktop2's API. Check the port in ytmdesktop2's Settings → API & Integrations."
            )));
        }
        if root["authRequired"].as_bool() != Some(true) {
            return Ok(client);
        }

        if let Some(stored) = token_store::load_ytmd_token() {
            client.token = Some(stored);
            // Authorization is checked before anything else, so any answer
            // other than 401 means the token was accepted.
            match client
                .send(client.http.get(client.url("/track/state")))
                .await
            {
                Err(PlayerError::NeedsAuth) => {
                    token_store::clear_ytmd_token();
                    client.token = None;
                }
                Err(error @ PlayerError::Network(_)) => return Err(error),
                _ => return Ok(client),
            }
        }

        let issued = client.post("/auth/requestcode").json(&json!({
            "appId": APP_ID,
            "appName": APP_NAME,
            "appVersion": env!("CARGO_PKG_VERSION"),
        }));
        let issued = client.send(issued).await?;
        let code = issued["code"]
            .as_str()
            .filter(|code| !code.is_empty())
            .ok_or_else(|| PlayerError::Refused {
                message: "ytmdesktop2 did not issue a pairing code.".into(),
            })?
            .to_string();
        show_code(&code);

        let approval = client
            .post("/auth/request")
            .timeout(APPROVAL_TIMEOUT)
            .json(&json!({ "appId": APP_ID, "code": code }));
        let approved = client.send(approval).await?;
        let token = approved["token"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or_else(|| PlayerError::Refused {
                message: "ytmdesktop2 approved the pairing but sent no token.".into(),
            })?
            .to_string();
        if let Err(error) = token_store::save_ytmd_token(&token) {
            client.warning =
                format!("The ytmdesktop2 pairing could not be saved ({error}); it will be asked for again next launch.");
        }
        client.token = Some(token);
        Ok(client)
    }

    /// Why the pairing will not survive a restart, or empty.
    pub fn cache_warning(&self) -> &str {
        &self.warning
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.post(self.url(path))
    }

    /// Its API itself answers at once, so a connection that opens and then
    /// times out is a command stuck in its page; anything else is the app
    /// closed or its API off.
    fn unreachable(&self, error: &reqwest::Error) -> PlayerError {
        if error.is_timeout() && !error.is_connect() {
            return PlayerError::Network(
                "ytmdesktop2 did not answer. Let YouTube Music finish loading in it, then try again."
                    .into(),
            );
        }
        PlayerError::Network(format!(
            "Cannot reach ytmdesktop2 on port {}. Open it and turn on Settings → API & Integrations → API.",
            self.port
        ))
    }

    /// Send with the token, and turn ytmdesktop2's answer into JSON or into the
    /// error both sides understand.
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, PlayerError> {
        let request = match &self.token {
            Some(token) => request.bearer_auth(token),
            None => request,
        };
        let response = request
            .send()
            .await
            .map_err(|error| self.unreachable(&error))?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(PlayerError::NeedsAuth);
        }
        if !status.is_success() {
            // Its errors are `{"error": "..."}`; a crash inside it is not.
            let message = body["error"]
                .as_str()
                .map(|error| format!("ytmdesktop2: {error}"))
                .unwrap_or_else(|| format!("ytmdesktop2 answered {status}."));
            return Err(PlayerError::Refused { message });
        }
        Ok(body)
    }

    async fn get(&self, path: &str) -> Result<Value, PlayerError> {
        self.send(self.http.get(self.url(path))).await
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        // Both are answered from ytmdesktop2's own memory, never from its page.
        let (state, track) = tokio::join!(self.get("/track/state"), self.get("/track"));
        // A page that is still loading answers 500; that is a wait, not a
        // refusal, so it keeps the poll going like any other network trouble.
        let (state, track) = match (state, track) {
            (Ok(state), Ok(track)) => (state, track),
            (Err(PlayerError::NeedsAuth), _) | (_, Err(PlayerError::NeedsAuth)) => {
                return Err(PlayerError::NeedsAuth)
            }
            (Err(PlayerError::Refused { message }), _)
            | (_, Err(PlayerError::Refused { message })) => {
                return Err(PlayerError::Network(message))
            }
            (Err(error), _) | (_, Err(error)) => return Err(error),
        };
        let mut playback = sample(&state, &track, None);
        let position = playback.progress_ms.map(|progress_ms| Position {
            id: playback.track_id.clone(),
            progress_ms,
            flagged_playing: playback.is_playing,
            at: Instant::now(),
        });
        {
            let mut last = self.last.lock().unwrap();
            if let Some(position) = &position {
                playback.is_playing |= moving(last.as_ref(), position);
            }
            *last = position;
        }
        if !playback.has_track {
            // Asking the page now would only hang.
            return Ok(playback);
        }
        // Volume is extra: a sample without it is still a sample.
        let volume = self
            .send(
                self.post("/track/volume")
                    .timeout(VOLUME_TIMEOUT)
                    .json(&json!({})),
            )
            .await
            .ok()
            .and_then(|answer| answer["volume"].as_f64())
            .filter(|volume| volume.is_finite())
            .map(|volume| volume.round().clamp(0.0, 100.0) as u8);
        Ok(Playback {
            volume_percent: volume,
            can_set_volume: volume.is_some(),
            ..playback
        })
    }

    /// The songs after the playing one, by title only. Read-only: ytmdesktop2
    /// has no way to play one of them.
    pub async fn queue(&self) -> Result<Queue, PlayerError> {
        // From ytmdesktop2's own memory; the queue is asked of the page, which
        // would only hang if nothing is loaded.
        let track = self.get("/track").await?;
        let playing = sample(&Value::Null, &track, None);
        if !playing.has_track {
            return Ok(Queue::default());
        }
        let answer = self.get("/nav/queue").await?;
        Ok(parse_queue(&answer, &playing.video_ids))
    }

    async fn command(&self, path: &str, body: Value) -> Result<(), PlayerError> {
        self.send(self.post(path).json(&body)).await.map(|_| ())
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        self.command("/track/play", json!({})).await
    }

    pub async fn pause(&self) -> Result<(), PlayerError> {
        self.command("/track/pause", json!({})).await
    }

    pub async fn next(&self) -> Result<(), PlayerError> {
        self.command("/track/next", json!({})).await
    }

    pub async fn previous(&self) -> Result<(), PlayerError> {
        self.command("/track/prev", json!({})).await
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        self.command(
            "/track/seek",
            json!({ "time": position_ms.max(0), "type": "seek" }),
        )
        .await
    }

    pub async fn set_volume(&self, volume_percent: u8) -> Result<(), PlayerError> {
        self.command(
            "/track/volume",
            json!({ "volume": volume_percent.min(100) }),
        )
        .await
    }
}

fn seconds_to_ms(value: &Value) -> Option<i64> {
    let seconds = match value {
        Value::String(text) => text.trim().parse::<f64>().ok()?,
        other => other.as_f64()?,
    };
    (seconds.is_finite() && seconds > 0.0).then(|| (seconds * 1000.0).round() as i64)
}

fn valid_id(id: &str) -> bool {
    crate::youtube_music::valid_video_id(id)
}

/// One sample from ytmdesktop2's track and state answers.
fn sample(state: &Value, track: &Value, volume: Option<u8>) -> Playback {
    let nothing = Playback {
        source: PlayerKind::Ytmdesktop2,
        ..Default::default()
    };
    let video = &track["video"];
    let id = video["videoId"].as_str().unwrap_or_default();
    let title = video["title"]
        .as_str()
        .or_else(|| track["context"]["title"].as_str())
        .unwrap_or_default()
        .trim();
    if !valid_id(id) || title.is_empty() {
        return nothing;
    }
    // The two answers are read at once but kept apart inside ytmdesktop2, so
    // across a track change they may briefly describe different songs. The
    // track wins; the state's position is only trusted for its own song.
    let current = state["id"].as_str() == Some(id);

    let artist = video["author"].as_str().unwrap_or_default().trim();
    let artist = artist.strip_suffix(TOPIC_SUFFIX).unwrap_or(artist);
    let art = track["meta"]["thumbnail"]
        .as_str()
        .map(str::to_string)
        .or_else(|| {
            video["thumbnail"]["thumbnails"]
                .as_array()?
                .iter()
                .max_by_key(|thumbnail| thumbnail["height"].as_u64().unwrap_or(0))?["url"]
                .as_str()
                .map(str::to_string)
        })
        .filter(|url| url.starts_with("https://"));
    let duration_ms = current
        .then(|| seconds_to_ms(&state["duration"]))
        .flatten()
        .or_else(|| seconds_to_ms(&track["meta"]["duration"]))
        .or_else(|| seconds_to_ms(&video["lengthSeconds"]))
        .unwrap_or(0);
    let progress_ms = current.then(|| {
        let seconds = state["progress"].as_f64().unwrap_or(0.0).max(0.0);
        let progress = (seconds * 1000.0).round() as i64;
        if duration_ms > 0 {
            progress.min(duration_ms)
        } else {
            progress
        }
    });

    let mut video_ids = vec![id.to_string()];
    // A music video's album counterpart carries the timed lyrics the video
    // itself usually lacks.
    if let Some(counterpart) = track["meta"]["counterpartVideoId"]
        .as_str()
        .filter(|other| valid_id(other) && *other != id)
    {
        video_ids.push(counterpart.to_string());
    }

    Playback {
        track_id: id.to_string(),
        name: title.to_string(),
        artists: (!artist.is_empty())
            .then(|| artist.to_string())
            .into_iter()
            .collect(),
        album: track["music"]["album"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_string(),
        album_art: art,
        video_ids,
        duration_ms,
        progress_ms,
        is_playing: current && state["playing"].as_bool().unwrap_or(false),
        has_track: true,
        can_skip_next: true,
        can_skip_previous: true,
        can_seek: duration_ms > 0,
        device_name: Some("ytmdesktop2".into()),
        device_id: None,
        volume_percent: volume,
        can_set_volume: volume.is_some(),
        shuffle: None,
        repeat: None,
        can_shuffle: false,
        can_repeat_context: false,
        can_repeat_track: false,
        muted: None,
        can_jump_queue: false,
        queue_revision: None,
        source: PlayerKind::Ytmdesktop2,
    }
}

/// The songs after the playing one, which is found by its video id or its
/// album counterpart's. When it cannot be found, the whole queue is shown
/// rather than a guess at where it stands.
fn parse_queue(answer: &Value, playing: &[String]) -> Queue {
    let items: Vec<(&str, &str)> = answer["items"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|item| {
                    (
                        item["videoId"].as_str().unwrap_or_default(),
                        item["title"].as_str().unwrap_or_default().trim(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let current = items
        .iter()
        .position(|(id, _)| !id.is_empty() && playing.iter().any(|known| known == id));
    let after = current.map_or(0, |index| index + 1);
    Queue {
        now: None,
        upcoming: items[after..]
            .iter()
            .filter(|(_, title)| !title.is_empty())
            .map(|(_, title)| QueueItem {
                title: title.to_string(),
                ..Default::default()
            })
            .collect(),
        can_jump: false,
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    use crate::settings::tests::with_temp_data_dir;

    #[derive(Debug, Clone)]
    pub(crate) struct Seen {
        pub(crate) method: String,
        pub(crate) path: String,
        pub(crate) authorization: Option<String>,
        pub(crate) body: Value,
    }

    type Route = dyn Fn(&Seen) -> (u16, String) + Send + Sync;

    /// A stand-in for ytmdesktop2 on a free loopback port, answering by route and
    /// recording every request it was sent.
    pub(crate) fn fake(
        route: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<Seen>>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        let route: Arc<Route> = Arc::new(route);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let route = route.clone();
                let log = log.clone();
                std::thread::spawn(move || {
                    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                    let mut raw = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let header_end = loop {
                        let Ok(read) = stream.read(&mut chunk) else {
                            return;
                        };
                        if read == 0 {
                            return;
                        }
                        raw.extend_from_slice(&chunk[..read]);
                        if let Some(end) = raw.windows(4).position(|window| window == b"\r\n\r\n") {
                            break end + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
                    let header = |name: &str| {
                        head.lines().find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case(name)
                                .then(|| value.trim().to_string())
                        })
                    };
                    let length: usize = header("content-length")
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(0);
                    while raw.len() < header_end + length {
                        let Ok(read) = stream.read(&mut chunk) else {
                            return;
                        };
                        if read == 0 {
                            break;
                        }
                        raw.extend_from_slice(&chunk[..read]);
                    }
                    let mut words = head.split_whitespace();
                    let request = Seen {
                        method: words.next().unwrap_or_default().to_string(),
                        path: words.next().unwrap_or_default().to_string(),
                        authorization: header("authorization"),
                        body: serde_json::from_slice(&raw[header_end..]).unwrap_or(Value::Null),
                    };
                    let (status, body) = route(&request);
                    log.lock().unwrap().push(request);
                    let _ = write!(
                        stream,
                        "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                });
            }
        });
        (base, seen)
    }

    pub(crate) fn run<T>(body: impl std::future::Future<Output = T>) -> T {
        with_temp_data_dir(|_| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(body)
        })
    }

    fn root(auth_required: bool) -> String {
        json!({"name": "YTMDesktop2 Api", "authRequired": auth_required}).to_string()
    }

    /// The `GET /track` example from ytmdesktop2's docs, plus a counterpart.
    fn track() -> Value {
        json!({
            "id": "dQw4w9WgXcQ",
            "video": {
                "videoId": "dQw4w9WgXcQ",
                "title": "Never Gonna Give You Up",
                "lengthSeconds": "213",
                "author": "Rick Astley - Topic",
                "thumbnail": {"thumbnails": [
                    {"url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/default.jpg", "width": 120, "height": 90},
                    {"url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "width": 480, "height": 360}
                ]}
            },
            "meta": {"duration": 213, "counterpartVideoId": "lYBUbBu4W08"},
            "music": {"album": "Whenever You Need Somebody"}
        })
    }

    fn state() -> Value {
        json!({"id": "dQw4w9WgXcQ", "playing": true, "progress": 42.5, "duration": 213})
    }

    fn open_player(seen_body: Value) -> impl Fn(&Seen) -> (u16, String) + Send + Sync {
        move |request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            "/track" => (200, track().to_string()),
            "/track/state" => (200, state().to_string()),
            "/track/volume" => (200, json!({"volume": 37}).to_string()),
            _ => (200, seen_body.to_string()),
        }
    }

    #[test]
    fn a_sample_carries_the_exact_video_and_its_album_counterpart() {
        let playback = sample(&state(), &track(), Some(37));
        assert_eq!(playback.track_id, "dQw4w9WgXcQ");
        assert_eq!(playback.video_ids, ["dQw4w9WgXcQ", "lYBUbBu4W08"]);
        assert_eq!(playback.name, "Never Gonna Give You Up");
        assert_eq!(
            playback.artists,
            ["Rick Astley"],
            "the Topic channel suffix is not part of the name"
        );
        assert_eq!(playback.album, "Whenever You Need Somebody");
        assert_eq!(playback.duration_ms, 213_000);
        assert_eq!(playback.progress_ms, Some(42_500));
        assert!(playback.is_playing && playback.has_track && playback.can_seek);
        assert_eq!(playback.volume_percent, Some(37));
        assert!(playback.can_set_volume);
        assert_eq!(playback.source, PlayerKind::Ytmdesktop2);
        assert_eq!(
            playback.album_art.as_deref(),
            Some("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"),
            "the largest thumbnail when ytmdesktop2 has not picked one"
        );
    }

    #[test]
    fn the_queue_starts_after_the_playing_song_or_its_counterpart() {
        let answer = json!({"items": [
            {"index": 0, "videoId": "aaaaaaaaaaa", "title": "Played"},
            {"index": 1, "videoId": "lYBUbBu4W08", "title": "Playing"},
            {"index": 2, "videoId": "bbbbbbbbbbb", "title": " Next "},
            {"index": 3},
            {"index": 4, "videoId": "ccccccccccc", "title": "Later"}
        ], "count": 5, "storeHooked": true});
        let playing = ["dQw4w9WgXcQ".to_string(), "lYBUbBu4W08".to_string()];
        let queue = parse_queue(&answer, &playing);
        let titles: Vec<_> = queue.upcoming.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(titles, ["Next", "Later"], "a sparse entry is left out");
        assert!(!queue.can_jump);
        assert!(queue.upcoming.iter().all(|item| item.uri.is_empty()));

        let lost = parse_queue(&answer, &["zzzzzzzzzzz".to_string()]);
        assert_eq!(lost.upcoming.len(), 4, "not found: the whole queue");
        assert_eq!(parse_queue(&json!({"items": [], "storeHooked": false}), &playing), Queue::default());
    }

    #[test]
    fn a_queue_is_asked_of_the_page_only_while_a_song_is_loaded() {
        let (base, seen) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            "/track" => (200, track().to_string()),
            "/nav/queue" => (
                200,
                json!({"items": [
                    {"index": 0, "videoId": "dQw4w9WgXcQ", "title": "Never Gonna Give You Up"},
                    {"index": 1, "videoId": "bbbbbbbbbbb", "title": "Next"}
                ]})
                .to_string(),
            ),
            _ => (404, "{}".into()),
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| panic!("open API"))
                .await
                .unwrap();
            let queue = client.queue().await.unwrap();
            assert_eq!(queue.upcoming.len(), 1);
            assert_eq!(queue.upcoming[0].title, "Next");
        });
        assert!(seen.lock().unwrap().iter().any(|r| r.path == "/nav/queue" && r.method == "GET"));

        let (base, seen) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            "/track" => (200, "null".into()),
            _ => (500, "{}".into()),
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| panic!("open API"))
                .await
                .unwrap();
            assert_eq!(client.queue().await.unwrap(), Queue::default());
        });
        assert!(!seen.lock().unwrap().iter().any(|r| r.path == "/nav/queue"));
    }

    #[test]
    fn a_position_running_with_the_clock_is_playing_whatever_the_flag_says() {
        let start = Instant::now();
        let at = |id: &str, progress_ms: i64, after_ms: u64| Position {
            id: id.into(),
            progress_ms,
            flagged_playing: false,
            at: start + Duration::from_millis(after_ms),
        };
        let before = at("dQw4w9WgXcQ", 2_200, 0);
        // As measured: 2.2 s, then 5.2 s three seconds later, flagged paused.
        assert!(moving(Some(&before), &at("dQw4w9WgXcQ", 5_200, 3_000)));
        assert!(
            !moving(None, &at("dQw4w9WgXcQ", 5_200, 3_000)),
            "one sample proves nothing"
        );
        assert!(
            !moving(Some(&before), &at("dQw4w9WgXcQ", 2_200, 1_500)),
            "paused"
        );
        assert!(
            !moving(Some(&before), &at("dQw4w9WgXcQ", 60_000, 1_500)),
            "a seek forward"
        );
        assert!(
            !moving(Some(&before), &at("dQw4w9WgXcQ", 1_000, 1_500)),
            "a seek back"
        );
        assert!(
            !moving(Some(&before), &at("lYBUbBu4W08", 3_700, 1_500)),
            "another song"
        );
        assert!(
            !moving(Some(&before), &at("dQw4w9WgXcQ", 2_300, 100)),
            "too soon to tell"
        );
        assert!(
            !moving(Some(&before), &at("dQw4w9WgXcQ", 32_200, 30_000)),
            "a window hidden for half a minute says nothing about now"
        );

        // Paused 1 s into a 1.5 s interval: the song ran for most of it, but a
        // flag that just turned to paused is believed.
        let playing = Position {
            flagged_playing: true,
            ..at("dQw4w9WgXcQ", 10_000, 0)
        };
        assert!(!moving(Some(&playing), &at("dQw4w9WgXcQ", 11_000, 1_500)));
        // And a song flagged playing needs no help.
        let still = Position {
            flagged_playing: true,
            ..at("dQw4w9WgXcQ", 11_500, 1_500)
        };
        assert!(!moving(Some(&playing), &still));
    }

    #[test]
    fn nothing_loaded_is_no_track_and_a_stale_state_is_not_trusted() {
        assert!(!sample(&Value::Null, &Value::Null, None).has_track);

        // Mid-change: the state still describes the previous song.
        let previous =
            json!({"id": "aaaaaaaaaaa", "playing": true, "progress": 200.0, "duration": 250});
        let playback = sample(&previous, &track(), None);
        assert!(playback.has_track);
        assert_eq!(playback.progress_ms, None);
        assert!(!playback.is_playing);
        assert_eq!(
            playback.duration_ms, 213_000,
            "the track's own length, not the old song's"
        );
        assert!(!playback.can_set_volume, "no volume read, no dial");
    }

    #[test]
    fn an_open_api_is_polled_and_controlled_without_a_token() {
        let (base, seen) = fake(open_player(json!({"isPlaying": true, "time": 0})));
        run(async {
            let client =
                Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| panic!("no pairing on an open API"))
                    .await
                    .unwrap();
            let playback = client.playback().await.unwrap();
            assert_eq!(playback.track_id, "dQw4w9WgXcQ");
            assert_eq!(playback.volume_percent, Some(37));

            client.seek(90_000).await.unwrap();
            client.set_volume(55).await.unwrap();
            client.previous().await.unwrap();
        });
        let seen = seen.lock().unwrap();
        assert!(seen.iter().all(|request| request.authorization.is_none()));
        let volume_read = seen.iter().find(|r| r.path == "/track/volume").unwrap();
        assert_eq!(
            volume_read.body,
            json!({}),
            "a poll must read the volume, never set it"
        );
        let seek = seen.iter().find(|r| r.path == "/track/seek").unwrap();
        assert_eq!(seek.method, "POST");
        assert_eq!(
            seek.body,
            json!({"time": 90_000, "type": "seek"}),
            "milliseconds, absolute"
        );
        assert!(seen
            .iter()
            .any(|r| r.path == "/track/volume" && r.body == json!({"volume": 55})));
        assert!(seen
            .iter()
            .any(|r| r.path == "/track/prev" && r.method == "POST"));
    }

    #[test]
    fn mute_without_native_support_reads_current_volume_and_toggles_zero_full() {
        let volume = Arc::new(std::sync::atomic::AtomicU8::new(37));
        let current = volume.clone();
        let fallback = open_player(json!({"isPlaying": true, "time": 0}));
        let (base, seen) = fake(move |request| {
            if request.path == "/track/volume" {
                if let Some(value) = request.body["volume"].as_u64() {
                    current.store(value as u8, std::sync::atomic::Ordering::SeqCst);
                }
                (200, json!({"volume": current.load(std::sync::atomic::Ordering::SeqCst)}).to_string())
            } else {
                fallback(request)
            }
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| panic!("open API")).await.unwrap();
            let player = crate::player::Player::ytmdesktop2(Arc::new(client));
            let sample = player.playback().await.unwrap();
            assert!(sample.muted.is_none() && !sample.can_jump_queue);
            player.toggle_mute().await.unwrap();
            assert_eq!(volume.load(std::sync::atomic::Ordering::SeqCst), 0);
            player.toggle_mute().await.unwrap();
            assert_eq!(volume.load(std::sync::atomic::Ordering::SeqCst), 100);
        });
        let changes: Vec<_> = seen.lock().unwrap().iter()
            .filter(|request| request.path == "/track/volume" && request.body["volume"].is_number())
            .map(|request| request.body["volume"].clone()).collect();
        assert_eq!(changes, [json!(0), json!(100)]);
    }

    #[test]
    fn pairing_shows_the_code_then_keeps_the_approved_token() {
        let (base, seen) = fake(|request: &Seen| {
            match (request.path.as_str(), request.authorization.as_deref()) {
                ("/", _) => (200, root(true)),
                ("/auth/requestcode", _) => (200, json!({"code": "AB12"}).to_string()),
                ("/auth/request", _) => (200, json!({"token": "issued-token"}).to_string()),
                (_, Some("Bearer issued-token")) => (200, "null".into()),
                _ => (401, json!({"error": "unauthorized"}).to_string()),
            }
        });
        let shown = run(async {
            let mut shown = String::new();
            let client =
                Ytmdesktop::connect_to(base.clone(), DEFAULT_PORT, |code| shown = code.to_string())
                    .await
                    .unwrap();
            assert!(client.cache_warning().is_empty());
            assert!(!client.playback().await.unwrap().has_track);

            // The next launch reuses the stored token instead of pairing again.
            Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| panic!("paired twice"))
                .await
                .unwrap();
            shown
        });
        assert_eq!(shown, "AB12");
        let seen = seen.lock().unwrap();
        let request_code = seen.iter().find(|r| r.path == "/auth/requestcode").unwrap();
        assert_eq!(request_code.body["appId"], "hakuro");
        assert_eq!(request_code.body["appVersion"], env!("CARGO_PKG_VERSION"));
        let approval = seen.iter().find(|r| r.path == "/auth/request").unwrap();
        assert_eq!(approval.body, json!({"appId": "hakuro", "code": "AB12"}));
        assert_eq!(
            seen.iter()
                .filter(|r| r.path == "/auth/requestcode")
                .count(),
            1
        );
        assert!(
            !seen.iter().any(|r| r.path == "/track/volume"),
            "with nothing loaded the page is not asked, since it would hang"
        );
    }

    #[test]
    fn a_stuck_page_neither_stalls_the_sample_nor_hides_the_song() {
        // As measured: ytmdesktop2's memory answers, its page never does.
        let (base, _) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            "/track" => (200, track().to_string()),
            "/track/state" => (200, state().to_string()),
            _ => {
                std::thread::sleep(Duration::from_secs(8));
                (200, "{}".into())
            }
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| {})
                .await
                .unwrap();
            let started = std::time::Instant::now();
            let playback = client.playback().await.unwrap();
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "{:?}",
                started.elapsed()
            );
            assert!(playback.has_track);
            assert_eq!(playback.volume_percent, None);
            assert!(!playback.can_set_volume);

            let stuck = client.play().await.err().unwrap();
            assert!(stuck.to_string().contains("finish loading"), "{stuck}");
        });
    }

    #[test]
    fn a_revoked_token_is_dropped_and_pairing_starts_over() {
        let (base, _) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(true)),
            "/auth/requestcode" => (200, json!({"code": "CD34"}).to_string()),
            "/auth/request" => (
                400,
                json!({"error": "Authorization timed out — user did not approve in time"})
                    .to_string(),
            ),
            _ => (401, json!({"error": "unauthorized"}).to_string()),
        });
        run(async {
            token_store::save_ytmd_token("revoked-token").unwrap();
            let mut shown = String::new();
            let error = Ytmdesktop::connect_to(base, DEFAULT_PORT, |code| shown = code.to_string())
                .await
                .err()
                .unwrap();
            assert_eq!(shown, "CD34");
            assert_eq!(
                error.to_string(),
                "ytmdesktop2: Authorization timed out — user did not approve in time"
            );
            assert!(
                token_store::load_ytmd_token().is_none(),
                "a rejected token is forgotten"
            );
        });
    }

    #[test]
    fn a_token_rejected_while_playing_asks_for_authorization() {
        let (base, _) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            _ => (401, json!({"error": "unauthorized"}).to_string()),
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| {})
                .await
                .unwrap();
            assert!(matches!(
                client.playback().await,
                Err(PlayerError::NeedsAuth)
            ));
            assert!(matches!(client.play().await, Err(PlayerError::NeedsAuth)));
        });
    }

    #[test]
    fn a_page_still_loading_is_a_wait_and_a_failed_command_says_why() {
        let (base, _) = fake(|request: &Seen| match request.path.as_str() {
            "/" => (200, root(false)),
            "/track/next" => (
                500,
                json!({"error": "failed to do requested operation (api/track/next)"}).to_string(),
            ),
            _ => (500, "Internal Server Error".into()),
        });
        run(async {
            let client = Ytmdesktop::connect_to(base, DEFAULT_PORT, |_| {})
                .await
                .unwrap();
            assert!(matches!(
                client.playback().await,
                Err(PlayerError::Network(_))
            ));
            assert_eq!(
                client.next().await.err().unwrap().to_string(),
                "ytmdesktop2: failed to do requested operation (api/track/next)"
            );
        });
    }

    #[test]
    fn nothing_listening_or_another_service_says_how_to_fix_it() {
        // Bind and drop: the port is free, so nothing answers it.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let (other, _) = fake(|_: &Seen| (200, json!({"name": "something else"}).to_string()));
        run(async {
            let closed = Ytmdesktop::connect(port, |_| {}).await.err().unwrap();
            assert!(matches!(closed, PlayerError::Network(_)));
            assert!(
                closed.to_string().contains("API & Integrations"),
                "{closed}"
            );

            let wrong = Ytmdesktop::connect_to(other, 13091, |_| {})
                .await
                .err()
                .unwrap();
            assert!(matches!(wrong, PlayerError::Config(_)));
            assert!(
                wrong.to_string().starts_with("Port 13091 does not answer"),
                "{wrong}"
            );
        });
    }

    /// Needs ytmdesktop2 on the default port, playing a song longer than a
    /// minute. Pauses, plays, seeks and changes the volume, then puts the
    /// position and volume back.
    #[test]
    #[ignore = "drives the local ytmdesktop2"]
    fn live_controls_reach_ytmdesktop2_and_are_undone() {
        run(async {
            let client =
                Ytmdesktop::connect(DEFAULT_PORT, |code| panic!("pairing needed ({code})"))
                    .await
                    .unwrap();
            let settle = || tokio::time::sleep(Duration::from_millis(1200));
            let before = client.playback().await.unwrap();
            assert!(before.has_track && before.is_playing, "play a song first");
            let volume = before
                .volume_percent
                .expect("volume readable while playing");
            let position = before.progress_ms.unwrap();

            client.pause().await.unwrap();
            settle().await;
            assert!(!client.playback().await.unwrap().is_playing, "pause");
            client.play().await.unwrap();
            settle().await;
            assert!(client.playback().await.unwrap().is_playing, "play");

            client.seek(30_000).await.unwrap();
            settle().await;
            let sought = client.playback().await.unwrap().progress_ms.unwrap();
            println!("seek to 30000 ms → {sought} ms");
            assert!(
                (30_000..34_000).contains(&sought),
                "seek is absolute milliseconds"
            );

            let quieter = volume.saturating_sub(10).max(1);
            client.set_volume(quieter).await.unwrap();
            settle().await;
            let changed = client.playback().await.unwrap().volume_percent;
            println!("volume {volume} → {changed:?}");

            client.set_volume(volume).await.unwrap();
            client.seek(position + 5_000).await.unwrap();
            settle().await;
            let after = client.playback().await.unwrap();
            println!(
                "restored volume {:?}, position {:?}",
                after.volume_percent, after.progress_ms
            );
            assert_eq!(changed, Some(quieter));
            assert_eq!(after.volume_percent, Some(volume));
        });
    }
}
