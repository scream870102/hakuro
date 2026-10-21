//! ytmdesktop/ytmdesktop Companion API v1 (verified against v2.0.12).
//! This is a different application/protocol from Venipa/ytmdesktop2.
//! https://github.com/ytmdesktop/ytmdesktop/tree/v2.0.12/src/main/integrations/companion-server
//!
//! REST state is limited to one request per five seconds. Bootstrap once, then
//! consume Socket.IO's websocket-only state updates; commands allow two/second.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::player::{Playback, PlayerError, PlayerKind, Queue, QueueItem, Repeat};
use crate::token_store;

pub const DEFAULT_PORT: u16 = 9863;
const TIMEOUT: Duration = Duration::from_secs(5);
const STATE_INTERVAL: Duration = Duration::from_millis(5100);
const COMMAND_INTERVAL: Duration = Duration::from_millis(550);
const NAMESPACE: &str = "/api/v1/realtime";

struct Api {
    http: reqwest::Client,
    base: String,
    token: Option<String>,
}

impl Api {
    async fn send(&self, request: reqwest::RequestBuilder) -> Result<Value, PlayerError> {
        let request = if let Some(token) = &self.token {
            // Companion takes the token itself, not the Bearer scheme.
            request.header(reqwest::header::AUTHORIZATION, token)
        } else {
            request
        };
        let response = request.send().await.map_err(|_| disconnected())?;
        let status = response.status();
        let retry_after = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok());
        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(PlayerError::NeedsAuth);
        }
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(PlayerError::RateLimited {
                retry_after: retry_after.unwrap_or(5),
            });
        }
        if status == reqwest::StatusCode::NO_CONTENT {
            return Ok(Value::Null);
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| PlayerError::Network("ytmdesktop returned an invalid response.".into()))?;
        if !status.is_success() {
            let message = if body["code"] == "AUTHORIZATION_DISABLED" {
                "Open ytmdesktop Settings → Integrations, enable Companion server and Enable companion authorization, then reconnect.".into()
            } else {
                format!(
                    "ytmdesktop: {}",
                    body["message"].as_str().unwrap_or(status.as_str())
                )
            };
            return Err(PlayerError::Refused { message });
        }
        Ok(body)
    }

    async fn get(&self, path: &str) -> Result<Value, PlayerError> {
        self.send(self.http.get(format!("{}{path}", self.base)))
            .await
    }

    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.http.post(format!("{}/api/v1{path}", self.base))
    }
}

struct Snapshot {
    state: Value,
    received: Instant,
    fault: Option<String>,
    revoked: bool,
}

impl Snapshot {
    fn update(&mut self, state: Value) -> Result<(), PlayerError> {
        if !state["player"].is_object()
            || !state
                .get("video")
                .is_some_and(|v| v.is_null() || v.is_object())
        {
            return Err(PlayerError::Network(
                "ytmdesktop sent an invalid player state.".into(),
            ));
        }
        self.state = state;
        self.received = Instant::now();
        self.fault = None;
        self.revoked = false;
        Ok(())
    }

    fn check(&self) -> Result<(), PlayerError> {
        if self.revoked {
            return Err(PlayerError::NeedsAuth);
        }
        if let Some(message) = &self.fault {
            return Err(PlayerError::Network(message.clone()));
        }
        Ok(())
    }
}

pub struct Companion {
    api: Arc<Api>,
    snapshot: Arc<Mutex<Snapshot>>,
    commands: tokio::sync::Mutex<Option<Instant>>,
    realtime: Option<tokio::task::JoinHandle<()>>,
    warning: String,
}

impl Drop for Companion {
    fn drop(&mut self) {
        if let Some(task) = self.realtime.take() {
            task.abort();
        }
    }
}

impl Companion {
    pub async fn connect(show_code: impl FnOnce(&str)) -> Result<Self, PlayerError> {
        let mut client =
            Self::connect_to(format!("http://127.0.0.1:{DEFAULT_PORT}"), show_code).await?;
        client.realtime = Some(tokio::spawn(realtime_loop(
            client.api.clone(),
            client.snapshot.clone(),
        )));
        Ok(client)
    }

    async fn connect_to(base: String, show_code: impl FnOnce(&str)) -> Result<Self, PlayerError> {
        let mut api = Api {
            http: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(TIMEOUT)
                .build()
                .map_err(|error| PlayerError::Config(error.to_string()))?,
            base,
            token: None,
        };
        let metadata = api.get("/metadata").await?;
        if !metadata["apiVersions"]
            .as_array()
            .is_some_and(|versions| versions.iter().any(|v| v == "v1"))
        {
            return Err(PlayerError::Config(
                "Port 9863 does not expose ytmdesktop Companion API v1.".into(),
            ));
        }
        let mut warning = String::new();
        let mut initial = None;
        if let Some(token) = token_store::load_companion_token() {
            api.token = Some(token);
            match api.get("/api/v1/state").await {
                Ok(state) => initial = Some(state),
                Err(PlayerError::NeedsAuth) => {
                    token_store::clear_companion_token();
                    api.token = None;
                }
                Err(error) => return Err(error),
            }
        }
        if api.token.is_none() {
            let issued = api
                .send(api.post("/auth/requestcode").json(&json!({
                    "appId": "hakuro", "appName": "Hakuro", "appVersion": env!("CARGO_PKG_VERSION")
                })))
                .await?;
            let code = issued["code"]
                .as_str()
                .filter(|code| code.len() == 4 && code.bytes().all(|b| b.is_ascii_digit()))
                .ok_or_else(|| PlayerError::Refused {
                    message: "ytmdesktop did not issue a valid pairing code.".into(),
                })?;
            show_code(code);
            let approved = api
                .send(
                    api.post("/auth/request")
                        .timeout(Duration::from_secs(40))
                        .json(&json!({"appId": "hakuro", "code": code})),
                )
                .await?;
            let token = approved["token"]
                .as_str()
                .filter(|t| !t.is_empty())
                .ok_or_else(|| PlayerError::Refused {
                    message: "ytmdesktop approved pairing but sent no token.".into(),
                })?;
            if let Err(error) = token_store::save_companion_token(token) {
                warning = format!(
                    "The ytmdesktop pairing could not be saved ({error}); pair again next launch."
                );
            }
            api.token = Some(token.to_string());
        }
        let initial = match initial {
            Some(state) => state,
            None => api.get("/api/v1/state").await?,
        };
        let mut snapshot = Snapshot {
            state: Value::Null,
            received: Instant::now(),
            fault: None,
            revoked: false,
        };
        snapshot.update(initial)?;
        Ok(Self {
            api: Arc::new(api),
            snapshot: Arc::new(Mutex::new(snapshot)),
            commands: tokio::sync::Mutex::new(None),
            realtime: None,
            warning,
        })
    }

    pub fn cache_warning(&self) -> &str {
        &self.warning
    }

    pub async fn playback(&self) -> Result<Playback, PlayerError> {
        let snapshot = self.snapshot.lock().unwrap();
        snapshot.check()?;
        Ok(sample(&snapshot.state, snapshot.received.elapsed()))
    }

    pub async fn queue(&self) -> Result<Queue, PlayerError> {
        let snapshot = self.snapshot.lock().unwrap();
        snapshot.check()?;
        Ok(parse_queue(&snapshot.state))
    }

    async fn command(&self, command: &str, data: Option<Value>) -> Result<(), PlayerError> {
        let mut body = json!({"command": command});
        if let Some(data) = data {
            body["data"] = data;
        }
        self.command_body(body, None).await
    }

    async fn command_body(
        &self,
        mut body: Value,
        queued_uri: Option<&str>,
    ) -> Result<(), PlayerError> {
        let mut last = self.commands.lock().await;
        if let Some(sent) = *last {
            tokio::time::sleep(COMMAND_INTERVAL.saturating_sub(sent.elapsed())).await;
        }
        {
            let snapshot = self.snapshot.lock().unwrap();
            snapshot.check()?;
            if let Some(uri) = queued_uri {
                // Validate after waiting for the command slot: the queue may
                // change while another window sends a command.
                let index = queue_items(&snapshot.state["player"]["queue"])
                    .iter()
                    .enumerate()
                    .find(|(index, item)| !uri.is_empty() && queue_uri(*index, item) == uri)
                    .map(|(index, _)| index)
                    .ok_or_else(|| {
                        refused("The queue changed. Refresh it and choose the song again.")
                    })?;
                body["data"] = json!(index);
            }
        }
        *last = Some(Instant::now());
        self.api
            .send(self.api.post("/command").json(&body))
            .await
            .map(|_| ())
    }

    pub async fn play(&self) -> Result<(), PlayerError> {
        self.command("play", None).await
    }
    pub async fn pause(&self) -> Result<(), PlayerError> {
        self.command("pause", None).await
    }
    pub async fn next(&self) -> Result<(), PlayerError> {
        self.command("next", None).await
    }
    pub async fn previous(&self) -> Result<(), PlayerError> {
        self.command("previous", None).await
    }

    pub async fn seek(&self, position_ms: i64) -> Result<(), PlayerError> {
        let playing = self.playback().await?;
        if !playing.can_seek {
            return Err(refused("Seeking is unavailable for this track."));
        }
        self.command(
            "seekTo",
            Some(json!(
                position_ms.clamp(0, playing.duration_ms) as f64 / 1000.0
            )),
        )
        .await
    }

    pub async fn set_volume(&self, percent: u8) -> Result<(), PlayerError> {
        self.command("setVolume", Some(json!(percent.min(100))))
            .await?;
        let muted = self.snapshot.lock().unwrap().state["player"]["muted"] == true;
        if percent > 0 && muted {
            self.command("unmute", None).await?;
        }
        Ok(())
    }

    pub async fn set_muted(&self, muted: bool) -> Result<(), PlayerError> {
        self.command(if muted { "mute" } else { "unmute" }, None)
            .await
    }

    pub async fn set_shuffle(&self, on: bool) -> Result<(), PlayerError> {
        if !on {
            return Err(refused(
                "ytmdesktop shuffles the queue; it has no shuffle off switch.",
            ));
        }
        self.command("shuffle", None).await
    }

    pub async fn set_repeat(&self, repeat: Repeat) -> Result<(), PlayerError> {
        self.command(
            "repeatMode",
            Some(json!(match repeat {
                Repeat::Off => 0,
                Repeat::Context => 1,
                Repeat::Track => 2,
            })),
        )
        .await
    }

    pub async fn jump(&self, uri: &str, _position: usize) -> Result<(), PlayerError> {
        // An opaque absolute index and video id preserve duplicate songs and
        // automix entries. Reject a stale row rather than play a different song.
        self.command_body(json!({"command": "playQueueIndex"}), Some(uri))
            .await
    }
}

fn refused(message: &str) -> PlayerError {
    PlayerError::Refused {
        message: message.into(),
    }
}
fn disconnected() -> PlayerError {
    PlayerError::Network("Cannot reach ytmdesktop. Open it and enable Settings → Integrations → Companion server (port 9863).".into())
}

async fn realtime_loop(api: Arc<Api>, snapshot: Arc<Mutex<Snapshot>>) {
    let mut last_state = Instant::now();
    loop {
        let result = receive_updates(&api, &snapshot, &mut last_state).await;
        let error = result.err().unwrap_or_else(disconnected);
        {
            let mut state = snapshot.lock().unwrap();
            state.revoked = matches!(error, PlayerError::NeedsAuth);
            state.fault = Some(error.to_string());
        }
        if matches!(error, PlayerError::NeedsAuth) {
            break;
        }
        // One connection at a time; REST bootstrap is independently throttled.
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn receive_updates(
    api: &Api,
    snapshot: &Mutex<Snapshot>,
    last_state: &mut Instant,
) -> Result<(), PlayerError> {
    let url = format!(
        "{}/socket.io/?EIO=4&transport=websocket",
        api.base.replacen("http://", "ws://", 1)
    );
    let (mut socket, _) = tokio::time::timeout(TIMEOUT, tokio_tungstenite::connect_async(url))
        .await
        .map_err(|_| disconnected())?
        .map_err(|_| disconnected())?;
    let mut heartbeat = TIMEOUT;
    let mut opened = false;
    let mut authorized = false;
    let mut catch_up = false;
    loop {
        let message = tokio::select! {
            message = tokio::time::timeout(heartbeat, socket.next()) => {
                message.map_err(|_| disconnected())?.ok_or_else(disconnected)?.map_err(|_| disconnected())?
            }
            _ = tokio::time::sleep(STATE_INTERVAL.saturating_sub(last_state.elapsed())), if catch_up => {
                *last_state = Instant::now();
                let state = api.get("/api/v1/state").await?;
                snapshot.lock().unwrap().update(state)?;
                catch_up = false;
                continue;
            }
        };
        let text = match message {
            Message::Text(text) => text,
            Message::Ping(bytes) => {
                socket
                    .send(Message::Pong(bytes))
                    .await
                    .map_err(|_| disconnected())?;
                continue;
            }
            Message::Close(_) => return Err(disconnected()),
            _ => continue,
        };
        if text == "2" {
            socket
                .send(Message::Text("3".into()))
                .await
                .map_err(|_| disconnected())?;
        } else if let Some(open) = text.strip_prefix('0').filter(|_| !opened) {
            let open: Value = serde_json::from_str(open).map_err(|_| disconnected())?;
            let interval = open["pingInterval"].as_u64().ok_or_else(disconnected)?;
            let timeout = open["pingTimeout"].as_u64().ok_or_else(disconnected)?;
            heartbeat =
                Duration::from_millis(interval.saturating_add(timeout).clamp(1000, 120_000));
            let connect = format!("40{NAMESPACE},{}", json!({"token": api.token}));
            socket
                .send(Message::Text(connect.into()))
                .await
                .map_err(|_| disconnected())?;
            opened = true;
        } else if text.starts_with(&format!("44{NAMESPACE},")) {
            return Err(PlayerError::NeedsAuth);
        } else if text.starts_with(&format!("40{NAMESPACE},")) && opened && !authorized {
            authorized = true;
            // The server sends no initial state on subscription. Even the first
            // socket must catch a paused change between REST and subscription.
            // Keep receiving meanwhile; any full state event closes that gap.
            catch_up = true;
        } else if let Some(event) = text
            .strip_prefix(&format!("42{NAMESPACE},"))
            .filter(|_| authorized)
        {
            let event: Value = serde_json::from_str(event).map_err(|_| disconnected())?;
            if event[0] == "state-update" {
                snapshot.lock().unwrap().update(event[1].clone())?;
                catch_up = false;
            }
        } else if text == "1" || text.starts_with(&format!("41{NAMESPACE}")) {
            return Err(disconnected());
        }
    }
}

fn thumbnail(value: &Value) -> Option<String> {
    value
        .as_array()?
        .iter()
        .filter(|t| {
            t["url"]
                .as_str()
                .is_some_and(|url| url.starts_with("https://"))
        })
        .max_by_key(|t| t["width"].as_u64().unwrap_or(0))?["url"]
        .as_str()
        .map(str::to_string)
}

fn artists(value: &Value) -> Vec<String> {
    let artist = value.as_str().unwrap_or_default().trim();
    let artist = artist.strip_suffix(" - Topic").unwrap_or(artist);
    (!artist.is_empty())
        .then(|| artist.to_string())
        .into_iter()
        .collect()
}

fn queue_items(queue: &Value) -> Vec<&Value> {
    queue["items"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(queue["automixItems"].as_array().into_iter().flatten())
        .collect()
}

fn selected_index(queue: &Value) -> Option<usize> {
    let items = queue_items(queue);
    queue["selectedItemIndex"]
        .as_u64()
        .and_then(|index| usize::try_from(index).ok())
        .filter(|index| *index < items.len())
        .or_else(|| items.iter().position(|item| item["selected"] == true))
}

fn queue_uri(index: usize, item: &Value) -> String {
    let id = item["videoId"].as_str().unwrap_or_default();
    if crate::youtube_music::valid_video_id(id) {
        format!("ytmd:{index}:{id}")
    } else {
        String::new()
    }
}

fn duration_ms(text: &str) -> i64 {
    let pieces: Vec<_> = text.split(':').collect();
    if !(2..=3).contains(&pieces.len()) {
        return 0;
    }
    let mut seconds = 0_i64;
    for (index, piece) in pieces.iter().enumerate() {
        let Ok(value) = piece.trim().parse::<i64>() else {
            return 0;
        };
        if value < 0 || (index > 0 && value >= 60) {
            return 0;
        }
        let Some(next) = seconds.checked_mul(60).and_then(|s| s.checked_add(value)) else {
            return 0;
        };
        seconds = next;
    }
    seconds.saturating_mul(1000)
}

fn queue_item(index: usize, item: &Value) -> Option<QueueItem> {
    let title = item["title"].as_str()?.trim();
    if title.is_empty() {
        return None;
    }
    Some(QueueItem {
        title: title.into(),
        artists: artists(&item["author"]),
        duration_ms: duration_ms(item["duration"].as_str().unwrap_or_default()),
        art: thumbnail(&item["thumbnails"]),
        uri: queue_uri(index, item),
    })
}

fn parse_queue(state: &Value) -> Queue {
    if state["player"]["adPlaying"] == true {
        return Queue::default();
    }
    let queue = &state["player"]["queue"];
    let items = queue_items(queue);
    let selected = selected_index(queue);
    Queue {
        now: selected.and_then(|index| queue_item(index, items[index])),
        upcoming: items
            .iter()
            .enumerate()
            .skip(selected.map_or(0, |index| index + 1))
            .filter_map(|(index, item)| queue_item(index, item))
            .collect(),
        can_jump: queue.is_object(),
    }
}

fn sample(state: &Value, elapsed: Duration) -> Playback {
    let player = &state["player"];
    let queue = &player["queue"];
    let mut hash = DefaultHasher::new();
    queue.to_string().hash(&mut hash);
    let mut playing = Playback {
        source: PlayerKind::Ytmdesktop,
        device_name: Some("ytmdesktop".into()),
        muted: player["muted"].as_bool(),
        queue_revision: Some(format!("{:x}", hash.finish())),
        ..Default::default()
    };
    let video = &state["video"];
    let id = video["id"].as_str().unwrap_or_default();
    let title = video["title"].as_str().unwrap_or_default().trim();
    if !crate::youtube_music::valid_video_id(id) || title.is_empty() || player["adPlaying"] == true
    {
        return playing;
    }
    playing.track_id = id.into();
    playing.name = title.into();
    playing.artists = artists(&video["author"]);
    playing.album = video["album"].as_str().unwrap_or_default().trim().into();
    playing.album_art = thumbnail(&video["thumbnails"]);
    playing.video_ids.push(id.into());
    if let Some(selected) =
        selected_index(queue).and_then(|index| queue_items(queue).get(index).copied())
    {
        // Only this entry's counterparts are alternate recordings of this song.
        let counterparts = selected["counterparts"].as_array().into_iter().flatten();
        let ids: Vec<_> = std::iter::once(selected)
            .chain(counterparts)
            .filter_map(|item| item["videoId"].as_str())
            .collect();
        if ids.contains(&id) {
            for other in ids {
                if crate::youtube_music::valid_video_id(other)
                    && !playing.video_ids.iter().any(|known| known == other)
                {
                    playing.video_ids.push(other.into());
                }
            }
        }
    }
    playing.duration_ms =
        (video["durationSeconds"].as_f64().unwrap_or(0.0).max(0.0) * 1000.0).round() as i64;
    playing.is_playing = player["trackState"] == 1;
    playing.progress_ms = player["videoProgress"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|seconds| {
            let position = (seconds.max(0.0) * 1000.0).round() as i64;
            let position = position.saturating_add(if playing.is_playing {
                elapsed.as_millis().min(i64::MAX as u128) as i64
            } else {
                0
            });
            if playing.duration_ms > 0 {
                position.min(playing.duration_ms)
            } else {
                position
            }
        });
    playing.has_track = true;
    playing.can_jump_queue = queue.is_object();
    playing.can_skip_next = true;
    playing.can_skip_previous = true;
    playing.can_seek = playing.duration_ms > 0 && video["isLive"] != true;
    playing.volume_percent = player["volume"]
        .as_f64()
        .filter(|v| v.is_finite())
        .map(|volume| {
            if player["muted"] == true {
                0
            } else {
                volume.round().clamp(0.0, 100.0) as u8
            }
        });
    playing.can_set_volume = playing.volume_percent.is_some();
    playing.can_shuffle = queue.is_object();
    playing.repeat = match queue["repeatMode"].as_i64() {
        Some(0) => Some(Repeat::Off),
        Some(1) => Some(Repeat::Context),
        Some(2) => Some(Repeat::Track),
        _ => None,
    };
    playing.can_repeat_context = playing.repeat.is_some();
    playing.can_repeat_track = playing.repeat.is_some();
    playing
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ytmdesktop::tests::{fake, run, Seen};

    fn item(id: &str, title: &str) -> Value {
        json!({"videoId": id, "title": title, "author": "Artist", "duration": "3:33",
            "selected": false, "counterparts": null,
            "thumbnails": [{"url":"https://example.com/cover.jpg","width":480,"height":480}]})
    }

    fn state() -> Value {
        let mut now = item("lYBUbBu4W08", "Now");
        now["selected"] = json!(true);
        now["counterparts"] = json!([item("dQw4w9WgXcQ", "Music video")]);
        json!({
            "player": {"trackState":1,"videoProgress":42.5,"volume":37,"muted":false,"adPlaying":false,
                "queue":{"items":[item("aaaaaaaaaaa","Before"),now,item("bbbbbbbbbbb","Next"),{},item("bbbbbbbbbbb","Duplicate")],
                    "automixItems":[item("ccccccccccc","Automix")],"selectedItemIndex":1,"repeatMode":1}},
            "video":{"id":"dQw4w9WgXcQ","title":"Now","author":"Artist - Topic","album":"Album",
                "durationSeconds":213,"isLive":false,"metadataFilled":true,"likeStatus":1,
                "thumbnails":[{"url":"https://example.com/small.jpg","width":120},
                    {"url":"https://example.com/large.jpg","width":480}]}
        })
    }

    fn route(request: &Seen) -> (u16, String) {
        match request.path.as_str() {
            "/metadata" => (200, json!({"apiVersions":["v1"]}).to_string()),
            "/api/v1/auth/requestcode" => (200, json!({"code":"0123"}).to_string()),
            "/api/v1/auth/request" => (200, json!({"token":"companion-token"}).to_string()),
            "/api/v1/state" => (200, state().to_string()),
            "/api/v1/command" => (204, String::new()),
            _ => (404, "{}".into()),
        }
    }

    #[test]
    fn maps_real_state_units_modes_art_and_only_matching_counterparts() {
        let mut value = state();
        let playing = sample(&value, Duration::from_millis(500));
        assert_eq!(playing.source, PlayerKind::Ytmdesktop);
        assert_eq!(playing.video_ids, ["dQw4w9WgXcQ", "lYBUbBu4W08"]);
        assert_eq!(playing.artists, ["Artist"]);
        assert_eq!(playing.album, "Album");
        assert_eq!(
            playing.album_art.as_deref(),
            Some("https://example.com/large.jpg")
        );
        assert_eq!(playing.duration_ms, 213_000);
        assert_eq!(playing.progress_ms, Some(43_000));
        assert!(playing.is_playing && playing.can_seek && playing.can_set_volume);
        assert_eq!(playing.volume_percent, Some(37));
        assert_eq!(playing.muted, Some(false));
        assert!(playing.can_jump_queue);
        assert_eq!(playing.repeat, Some(Repeat::Context));
        assert!(
            playing.can_shuffle && playing.shuffle.is_none(),
            "one-shot action, no invented toggle state"
        );
        value["player"]["trackState"] = json!(0);
        value["player"]["muted"] = json!(true);
        let paused = sample(&value, Duration::from_secs(100));
        assert!(!paused.is_playing);
        assert_eq!(paused.progress_ms, Some(42_500));
        assert_eq!(paused.volume_percent, Some(0));
        assert_eq!(paused.muted, Some(true));
        value["player"]["trackState"] = json!(2);
        value["video"]["isLive"] = json!(true);
        value["player"]["queue"]["repeatMode"] = json!(-1);
        value["video"]["id"] = json!("zzzzzzzzzzz");
        let buffering = sample(&value, Duration::from_secs(1));
        assert!(!buffering.is_playing && !buffering.can_seek && !buffering.can_repeat_track);
        assert_eq!(
            buffering.video_ids,
            ["zzzzzzzzzzz"],
            "a stale queue entry is not an album counterpart"
        );
        value["player"]["adPlaying"] = json!(true);
        assert!(!sample(&value, Duration::ZERO).has_track);
        assert!(!sample(&value, Duration::ZERO).can_jump_queue);
        assert_eq!(parse_queue(&value), Queue::default());
    }

    #[test]
    fn queue_keeps_absolute_indexes_duplicates_and_automix_and_revisions_ignore_progress() {
        let mut value = state();
        let queue = parse_queue(&value);
        assert_eq!(queue.now.unwrap().title, "Now");
        assert!(queue.can_jump);
        assert_eq!(
            queue
                .upcoming
                .iter()
                .map(|i| i.uri.as_str())
                .collect::<Vec<_>>(),
            [
                "ytmd:2:bbbbbbbbbbb",
                "ytmd:4:bbbbbbbbbbb",
                "ytmd:5:ccccccccccc"
            ]
        );
        assert_eq!(queue.upcoming[0].duration_ms, 213_000);
        assert_eq!(queue.upcoming[0].artists, ["Artist"]);
        let before = sample(&value, Duration::ZERO).queue_revision;
        value["player"]["videoProgress"] = json!(99);
        assert_eq!(sample(&value, Duration::ZERO).queue_revision, before);
        value["player"]["queue"]["items"][2] = item("ddddddddddd", "Replaced");
        assert_ne!(sample(&value, Duration::ZERO).queue_revision, before);
        assert_eq!(duration_ms("1:02:03"), 3_723_000);
        for invalid in ["LIVE", "-1:03", "1:60", "999999999999999999999:00"] {
            assert_eq!(duration_ms(invalid), 0);
        }
    }

    #[test]
    fn pairs_caches_and_uses_raw_authorization_without_touching_ytmdesktop2() {
        run(async {
            token_store::save_ytmd_token("existing-ytmdesktop2").unwrap();
            let (base, seen) = fake(route);
            let client = Companion::connect_to(base.clone(), |code| assert_eq!(code, "0123"))
                .await
                .unwrap();
            for _ in 0..5 {
                client.playback().await.unwrap();
                client.queue().await.unwrap();
            }
            client.play().await.unwrap();
            let cached =
                Companion::connect_to(base, |_| panic!("cached token should avoid pairing"))
                    .await
                    .unwrap();
            assert!(cached.playback().await.unwrap().has_track);
            assert_eq!(
                token_store::load_ytmd_token().as_deref(),
                Some("existing-ytmdesktop2")
            );
            assert_eq!(
                token_store::load_companion_token().as_deref(),
                Some("companion-token")
            );
            let seen = seen.lock().unwrap();
            assert_eq!(
                seen.iter().filter(|r| r.path == "/api/v1/state").count(),
                2,
                "polls and queue reads use the websocket snapshot"
            );
            let paired = seen
                .iter()
                .find(|r| r.path.ends_with("requestcode"))
                .unwrap();
            assert_eq!(paired.method, "POST");
            assert_eq!(paired.body["appId"], "hakuro");
            let command = seen.iter().find(|r| r.path.ends_with("command")).unwrap();
            assert_eq!(command.authorization.as_deref(), Some("companion-token"));
            assert_eq!(command.body, json!({"command":"play"}));
        });
    }

    #[test]
    fn stale_tokens_pair_again_but_disabled_authorization_and_rate_limits_are_reported() {
        run(async {
            token_store::save_companion_token("revoked").unwrap();
            let (base, _) = fake(|r| {
                if r.path == "/api/v1/state" && r.authorization.as_deref() == Some("revoked") {
                    return (401, "{}".into());
                }
                route(r)
            });
            Companion::connect_to(base, |_| {}).await.unwrap();
            assert_eq!(
                token_store::load_companion_token().as_deref(),
                Some("companion-token")
            );
            token_store::clear_companion_token();
            let (base, _) = fake(|r| {
                if r.path.ends_with("requestcode") {
                    return (403, json!({"code":"AUTHORIZATION_DISABLED"}).to_string());
                }
                route(r)
            });
            let error = Companion::connect_to(base, |_| panic!())
                .await
                .err()
                .unwrap();
            assert!(error.to_string().contains("Enable companion authorization"));
            let (base, _) = fake(|r| {
                if r.path.ends_with("command") {
                    return (429, "{}".into());
                }
                route(r)
            });
            let client = Companion::connect_to(base, |_| {}).await.unwrap();
            assert!(matches!(
                client.play().await,
                Err(PlayerError::RateLimited { .. })
            ));
        });
    }

    #[test]
    fn commands_use_verified_units_and_respect_two_per_second() {
        run(async {
            let times = Arc::new(Mutex::new(Vec::new()));
            let captured = times.clone();
            let (base, seen) = fake(move |r| {
                if r.path.ends_with("command") {
                    captured.lock().unwrap().push(Instant::now());
                }
                route(r)
            });
            let client = Companion::connect_to(base, |_| {}).await.unwrap();
            client.seek(42_500).await.unwrap();
            client.set_repeat(Repeat::Track).await.unwrap();
            client.set_shuffle(true).await.unwrap();
            client.jump("ytmd:4:bbbbbbbbbbb", 1).await.unwrap();
            client.set_volume(255).await.unwrap();
            assert!(client.set_shuffle(false).await.is_err());
            assert!(client.jump("", 0).await.is_err());
            let bodies: Vec<_> = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|r| r.path.ends_with("command"))
                .map(|r| r.body.clone())
                .collect();
            assert_eq!(
                bodies,
                [
                    json!({"command":"seekTo","data":42.5}),
                    json!({"command":"repeatMode","data":2}),
                    json!({"command":"shuffle"}),
                    json!({"command":"playQueueIndex","data":4}),
                    json!({"command":"setVolume","data":100})
                ]
            );
            assert!(times
                .lock()
                .unwrap()
                .windows(2)
                .all(|pair| pair[1].duration_since(pair[0]) >= Duration::from_millis(500)));
        });
    }

    #[test]
    fn native_mute_preserves_volume_and_falls_back_only_without_a_reported_state() {
        run(async {
            let (base, seen) = fake(route);
            let client = Arc::new(Companion::connect_to(base, |_| {}).await.unwrap());
            let player = crate::player::Player::ytmdesktop(client.clone());
            player.toggle_mute().await.unwrap();
            client.snapshot.lock().unwrap().state["player"]["muted"] = json!(true);
            player.toggle_mute().await.unwrap();
            client.snapshot.lock().unwrap().state["player"]
                .as_object_mut()
                .unwrap()
                .remove("muted");
            player.toggle_mute().await.unwrap();
            let commands: Vec<_> = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|request| request.path.ends_with("command"))
                .map(|request| request.body.clone())
                .collect();
            assert_eq!(
                commands,
                [
                    json!({"command":"mute"}),
                    json!({"command":"unmute"}),
                    json!({"command":"setVolume","data":0})
                ]
            );
        });
    }

    #[test]
    fn random_queue_jumps_are_serialized_and_reject_a_switched_source() {
        run(async {
            let order = Arc::new(Mutex::new(Vec::new()));
            let captured = order.clone();
            let (base, seen) = fake(move |request| {
                if request.body["command"] == "playQueueIndex" {
                    captured
                        .lock()
                        .unwrap()
                        .push(format!("jump:{}", request.body["data"]));
                }
                route(request)
            });
            let player = crate::player::Player::ytmdesktop(Arc::new(
                Companion::connect_to(base, |_| {}).await.unwrap(),
            ));
            let session = crate::Session::default();
            *session.player.write().await = Some(player);
            let first = crate::jump_random_queue(&session, |count| {
                order.lock().unwrap().push("choose:first".into());
                assert_eq!(count, 3);
                0
            });
            let second = crate::jump_random_queue(&session, |count| {
                order.lock().unwrap().push("choose:last".into());
                count - 1
            });
            let (first, second) = tokio::join!(first, second);
            first.unwrap();
            second.unwrap();
            assert_eq!(
                *order.lock().unwrap(),
                ["choose:first", "jump:2", "choose:last", "jump:5"]
            );
            assert!(crate::jump_random_queue(&session, |_| {
                *session.player.try_write().unwrap() = None;
                0
            })
            .await
            .unwrap_err()
            .contains("player changed"));
            assert_eq!(
                seen.lock()
                    .unwrap()
                    .iter()
                    .filter(|request| request.body["command"] == "playQueueIndex")
                    .count(),
                2
            );
        });
    }

    #[test]
    fn a_queue_changed_while_waiting_for_a_command_slot_is_not_played() {
        run(async {
            let (base, seen) = fake(route);
            let client = Companion::connect_to(base, |_| {}).await.unwrap();
            *client.commands.lock().await = Some(Instant::now());
            let change = async {
                tokio::time::sleep(Duration::from_millis(40)).await;
                client.snapshot.lock().unwrap().state["player"]["queue"]["items"][2] =
                    item("ddddddddddd", "Changed");
            };
            let (result, ()) = tokio::join!(client.jump("ytmd:2:bbbbbbbbbbb", 0), change);
            assert!(result.unwrap_err().to_string().contains("queue changed"));
            assert!(!seen
                .lock()
                .unwrap()
                .iter()
                .any(|r| r.path.ends_with("command")));
        });
    }

    #[test]
    fn initial_subscription_catches_a_paused_change_without_exceeding_rest_limit() {
        run(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let mut changed = state();
            changed["player"]["trackState"] = json!(0);
            changed["video"]["title"] = json!("Changed while subscribing");
            let answer = changed.clone();
            let started = Instant::now();
            let server = tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                socket
                    .send(Message::Text(
                        "0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}".into(),
                    ))
                    .await
                    .unwrap();
                socket.next().await.unwrap().unwrap();
                socket
                    .send(Message::Text(
                        "40/api/v1/realtime,{\"sid\":\"namespace\"}".into(),
                    ))
                    .await
                    .unwrap();
                // No state-update: the paused change happened before subscription.
                let (mut http, _) = listener.accept().await.unwrap();
                assert!(
                    started.elapsed() >= Duration::from_millis(90),
                    "must wait for REST's rate window"
                );
                let mut buffer = [0; 4096];
                let read = http.read(&mut buffer).await.unwrap();
                let request = String::from_utf8_lossy(&buffer[..read]);
                assert!(request.starts_with("GET /api/v1/state "));
                assert!(request
                    .to_ascii_lowercase()
                    .contains("authorization: secret"));
                let body = answer.to_string();
                http.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                socket.send(Message::Text("1".into())).await.unwrap();
            });
            let api = Api {
                http: reqwest::Client::builder().no_proxy().build().unwrap(),
                base: format!("http://{address}"),
                token: Some("secret".into()),
            };
            let snapshot = Mutex::new(Snapshot {
                state: state(),
                received: Instant::now(),
                fault: None,
                revoked: false,
            });
            // Simulate the end of the initial REST request's five-second window.
            let mut last_state = started - STATE_INTERVAL + Duration::from_millis(100);
            let error = tokio::time::timeout(
                Duration::from_secs(3),
                receive_updates(&api, &snapshot, &mut last_state),
            )
            .await
            .unwrap()
            .unwrap_err();
            assert!(matches!(error, PlayerError::Network(_)));
            server.await.unwrap();
            assert_eq!(snapshot.lock().unwrap().state, changed);
        });
    }

    #[test]
    fn websocket_authenticates_receives_state_answers_heartbeats_and_detects_revocation() {
        run(async {
            for revoked in [false, true] {
                let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
                let address = listener.local_addr().unwrap();
                let server = tokio::spawn(async move {
                    let (stream, _) = listener.accept().await.unwrap();
                    let mut socket = tokio_tungstenite::accept_hdr_async(
                        stream,
                        |request: &tokio_tungstenite::tungstenite::handshake::server::Request,
                         response| {
                            assert_eq!(
                                request.uri().to_string(),
                                "/socket.io/?EIO=4&transport=websocket"
                            );
                            Ok(response)
                        },
                    )
                    .await
                    .unwrap();
                    socket
                        .send(Message::Text(
                            "0{\"sid\":\"engine\",\"pingInterval\":25000,\"pingTimeout\":20000}"
                                .into(),
                        ))
                        .await
                        .unwrap();
                    let auth = socket.next().await.unwrap().unwrap().into_text().unwrap();
                    assert_eq!(auth, "40/api/v1/realtime,{\"token\":\"secret\"}");
                    if revoked {
                        socket.send(Message::Text("44/api/v1/realtime,{\"message\":\"Authentication not provided or invalid\"}".into())).await.unwrap();
                    } else {
                        socket
                            .send(Message::Text(
                                "40/api/v1/realtime,{\"sid\":\"namespace\"}".into(),
                            ))
                            .await
                            .unwrap();
                        socket
                            .send(Message::Text(
                                format!("42/api/v1/realtime,{}", json!(["state-update", state()]))
                                    .into(),
                            ))
                            .await
                            .unwrap();
                        socket.send(Message::Text("2".into())).await.unwrap();
                        assert_eq!(
                            socket.next().await.unwrap().unwrap().into_text().unwrap(),
                            "3"
                        );
                        socket.close(None).await.unwrap();
                    }
                });
                let api = Api {
                    http: reqwest::Client::new(),
                    base: format!("http://{address}"),
                    token: Some("secret".into()),
                };
                let snapshot = Mutex::new(Snapshot {
                    state: Value::Null,
                    received: Instant::now(),
                    fault: Some("offline".into()),
                    revoked: false,
                });
                let error = receive_updates(&api, &snapshot, &mut Instant::now())
                    .await
                    .unwrap_err();
                server.await.unwrap();
                if revoked {
                    assert!(matches!(error, PlayerError::NeedsAuth));
                } else {
                    assert!(matches!(error, PlayerError::Network(_)));
                    let snapshot = snapshot.lock().unwrap();
                    assert!(snapshot.fault.is_none());
                    assert_eq!(snapshot.state, state());
                }
            }
        });
    }
}
