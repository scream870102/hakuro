//! Bounded public lyric lookups; no credentials and no audio downloads.
//!
//! Schemas carried over from the Python implementation, which verified them against
//! https://lrclib.net/docs and open-source client implementations. NetEase and QQ
//! Music are unofficial public endpoints and can change or block access at any time,
//! so a failing provider must never break the chain.

use std::time::Duration;

use serde_json::Value;

use crate::lrc::{merge_translation, parse_lrc, parse_qrc, parse_yrc, strip_tags, unescape, Cue};
use crate::matching::{matches, normalize};

const USER_AGENT: &str = "Hakuro/4.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_RESPONSE_BYTES: usize = 2_000_000;
/// An overloaded server is asked again this many times, if the wait it names is
/// no longer than this. LRCLIB answers 503 with `retry-after: 1` under load.
const BUSY_RETRIES: usize = 2;
const MAX_BUSY_WAIT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct LyricsResult {
    pub text: String,
    pub source: String,
    /// Provider's returned title, or the successful query title when omitted.
    #[serde(default)]
    pub matched_title: String,
    pub cues: Vec<Cue>,
    #[serde(default)]
    pub errors: Vec<String>,
}

impl LyricsResult {
    pub fn empty(source: &str) -> Self {
        Self {
            text: String::new(),
            source: source.to_string(),
            matched_title: String::new(),
            cues: Vec::new(),
            errors: Vec::new(),
        }
    }

    /// Build a result from a raw LRC or plain-text payload.
    pub fn from_raw(raw: &str, source: &str) -> Self {
        let decoded = unescape(raw);
        let mut cues = parse_lrc(&decoded);
        // A "timeline" where every line is blank is not a timeline.
        if !cues.iter().any(|cue| !cue.text.is_empty()) {
            cues.clear();
        }
        let text = if cues.is_empty() {
            strip_tags(&decoded)
        } else {
            cues.iter()
                .map(|cue| cue.text.as_str())
                .collect::<Vec<_>>()
                .join("\n")
        };
        Self {
            text,
            source: source.to_string(),
            matched_title: String::new(),
            cues,
            errors: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.cues.is_empty()
    }

    pub fn with_title(mut self, title: &str) -> Self {
        if !self.is_empty() {
            self.matched_title = title.to_string();
        }
        self
    }
}

/// What the player knows about the track being looked up.
#[derive(Debug, Clone)]
pub struct TrackQuery {
    pub track: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: i64,
    /// The strongest matching key Musixmatch accepts; the other providers ignore it.
    pub spotify_id: Option<String>,
}

/// An explicit manual choice. Only a native provider id is accepted, never a URL.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LyricCandidate {
    pub source: String,
    pub id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: i64,
}

pub fn validate_candidate(candidate: &LyricCandidate) -> Result<(), ProviderError> {
    let valid_id = !candidate.id.is_empty()
        && candidate.id.len() <= 32
        && match candidate.source.as_str() {
            "lrclib" | "netease" => candidate.id.bytes().all(|c| c.is_ascii_digit()),
            "qqmusic" => candidate.id.bytes().all(|c| c.is_ascii_alphanumeric()),
            "youtube_music" => crate::youtube_music::valid_video_id(&candidate.id),
            _ => false,
        };
    if !valid_id
        || candidate.title.trim().is_empty()
        || candidate.title.len() > 1024
        || candidate.album.len() > 1024
        || candidate.artists.len() > 32
        || candidate.artists.iter().any(|artist| artist.len() > 512)
        || !(0..=86_400_000).contains(&candidate.duration_ms)
    {
        return Err(ProviderError::BadPayload);
    }
    Ok(())
}

impl TrackQuery {
    fn primary_artist(&self) -> &str {
        self.artists.first().map(String::as_str).unwrap_or("")
    }

    /// "Title Artist" — the free-text form the Chinese search endpoints expect.
    fn search_phrase(&self) -> String {
        match self.artists.first() {
            Some(artist) => format!("{} {}", self.track, artist),
            None => self.track.clone(),
        }
    }

    /// Verified recording alias, not a translation guess. The Japanese and
    /// Chinese Spotify releases use different ids. NetEase 3334395674 has the
    /// Chinese title, HOYO-MiX credit and the same 258640 ms duration.
    fn alternate_query(&self) -> Option<Self> {
        // ponytail: one verified recording; extend this table only with verified
        // identities, until a reliable cross-catalogue alias service is available.
        if self.spotify_id.as_deref() != Some("0XEwwNeNDbk5KaBJcg0389")
            || !matches(
                "エリーの休日",
                &["HOYO-MiX".into()],
                258_640,
                &self.track,
                &self.artists,
                Some(self.duration_ms),
            )
        {
            return None;
        }
        let mut alternate = self.clone();
        alternate.track = "丽都假日".into();
        // This shared credit is searchable in both catalogues; Sān-Z is listed
        // as 三Z-STUDIO on NetEase. Keep every artist for identity validation.
        let index = alternate
            .artists
            .iter()
            .position(|a| normalize(a) == normalize("HOYO-MiX"))?;
        alternate.artists.swap(0, index);
        Some(alternate)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("Http")]
    Http,
    /// The server said it is overloaded, and still was after the retries.
    #[error("Busy")]
    Busy,
    #[error("Timeout")]
    Timeout,
    #[error("TooLarge")]
    TooLarge,
    #[error("BadJson")]
    BadJson,
    #[error("Rejected")]
    Rejected,
    #[error("BadPayload")]
    BadPayload,
}

/// Error text shown to the user is a bare kind: provider responses and URLs can
/// carry lyrics and metadata, and must not leak into the interface.
impl From<reqwest::Error> for ProviderError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            ProviderError::Timeout
        } else if error.is_decode() {
            ProviderError::BadJson
        } else {
            ProviderError::Http
        }
    }
}

type ProviderResult = Result<LyricsResult, ProviderError>;

pub fn client() -> Result<reqwest::Client, reqwest::Error> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(REQUEST_TIMEOUT)
        .build()
}

/// GET or form-POST a bounded JSON response.
async fn request_json(
    client: &reqwest::Client,
    url: &str,
    params: &[(&str, String)],
    referer: Option<&str>,
    post: bool,
) -> Result<Value, ProviderError> {
    let mut retries = 0;
    let (mut response, status) = loop {
        let mut builder = if post {
            client.post(url).form(params)
        } else {
            client.get(url).query(params)
        }
        .header("Accept", "application/json");
        if let Some(referer) = referer {
            builder = builder.header("Referer", referer);
        }

        let response = builder.send().await?;
        let status = response.status();
        if !is_busy(status) {
            break (response, status);
        }
        match busy_wait(&response) {
            Some(wait) if retries < BUSY_RETRIES => {
                retries += 1;
                tokio::time::sleep(wait).await;
            }
            _ => return Err(ProviderError::Busy),
        }
    };
    if response
        .content_length()
        .is_some_and(|size| size > MAX_RESPONSE_BYTES as u64)
    {
        return Err(ProviderError::TooLarge);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if body.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    if !status.is_success() {
        return Err(ProviderError::Http);
    }
    // utf-8-sig: these endpoints occasionally prefix a BOM.
    let text = String::from_utf8_lossy(&body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|_| ProviderError::BadJson)
}

fn is_busy(status: reqwest::StatusCode) -> bool {
    status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        || status == reqwest::StatusCode::TOO_MANY_REQUESTS
}

/// How long a busy server asks to be left alone: `retry-after` in seconds, a
/// second when it names none, nothing when it asks for longer than is worth it.
fn busy_wait(response: &reqwest::Response) -> Option<Duration> {
    let wait = match response.headers().get(reqwest::header::RETRY_AFTER) {
        Some(value) => Duration::from_secs(value.to_str().ok()?.trim().parse().ok()?),
        None => Duration::from_secs(1),
    };
    (wait <= MAX_BUSY_WAIT).then_some(wait)
}

fn str_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn names(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|entry| str_field(entry, "name")).collect())
        .unwrap_or_default()
}

// -------------------------------------------------------- Candidate search

const MAX_CANDIDATES: usize = 20;
const MAX_AUTOMATIC_FETCHES: usize = 4;

fn candidate_from_json(source: &str, value: &Value) -> Option<LyricCandidate> {
    let (id, title, artists, album, duration_ms) = match source {
        "lrclib" => (
            value.get("id")?.as_i64()?.to_string(),
            str_field(value, "trackName"),
            vec![str_field(value, "artistName")],
            str_field(value, "albumName"),
            (value.get("duration").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0) as i64,
        ),
        "netease" => (
            value.get("id")?.as_i64()?.to_string(),
            str_field(value, "name"),
            names(value, "artists"),
            str_field(value.get("album").unwrap_or(&Value::Null), "name"),
            value.get("duration").and_then(Value::as_i64).unwrap_or(0),
        ),
        "qqmusic" => (
            str_field(value, "songmid"),
            str_field(value, "songname"),
            names(value, "singer"),
            str_field(value, "albumname"),
            (value.get("interval").and_then(Value::as_f64).unwrap_or(0.0) * 1000.0) as i64,
        ),
        _ => return None,
    };
    let candidate = LyricCandidate {
        source: source.into(),
        id,
        title,
        artists,
        album,
        duration_ms,
    };
    validate_candidate(&candidate).ok()?;
    Some(candidate)
}

/// One bounded page. The caller picks a source and can deliberately use an alias.
pub async fn search_candidates(
    client: &reqwest::Client,
    query: &str,
    source: &str,
) -> Result<Vec<LyricCandidate>, ProviderError> {
    let query = query.trim();
    if query.is_empty() || query.len() > 512 {
        return Err(ProviderError::BadPayload);
    }
    let data = match source {
        "youtube_music" => return crate::youtube_music::search(client, query).await,
        "lrclib" => {
            request_json(
                client,
                "https://lrclib.net/api/search",
                &[("q", query.to_string())],
                None,
                false,
            )
            .await?
        }
        "netease" => {
            request_json(
                client,
                "https://music.163.com/api/search/get/",
                &[
                    ("s", query.to_string()),
                    ("limit", MAX_CANDIDATES.to_string()),
                    ("type", "1".into()),
                    ("offset", "0".into()),
                ],
                Some("https://music.163.com/"),
                true,
            )
            .await?
        }
        "qqmusic" => {
            request_json(
                client,
                "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
                &[
                    ("w", query.to_string()),
                    ("n", MAX_CANDIDATES.to_string()),
                    ("p", "1".into()),
                    ("format", "json".into()),
                    ("cr", "1".into()),
                ],
                Some("https://y.qq.com/"),
                false,
            )
            .await?
        }
        _ => return Err(ProviderError::BadPayload),
    };
    candidates_from_response(source, &data)
}

fn candidates_from_response(
    source: &str,
    data: &Value,
) -> Result<Vec<LyricCandidate>, ProviderError> {
    let list = match source {
        "lrclib" => data.as_array(),
        "netease" if data.get("code").and_then(Value::as_i64) == Some(200) => {
            data.pointer("/result/songs").and_then(Value::as_array)
        }
        "qqmusic" if data.get("code").and_then(Value::as_i64) == Some(0) => {
            data.pointer("/data/song/list").and_then(Value::as_array)
        }
        _ => return Err(ProviderError::Rejected),
    };
    let mut candidates = Vec::new();
    for value in list.into_iter().flatten().take(MAX_CANDIDATES) {
        if let Some(candidate) = candidate_from_json(source, value) {
            if !candidates
                .iter()
                .any(|item: &LyricCandidate| item.id == candidate.id)
            {
                candidates.push(candidate);
            }
        }
    }
    Ok(candidates)
}

fn lrclib_result(data: &Value) -> LyricsResult {
    let synced = str_field(data, "syncedLyrics");
    let mut result = LyricsResult::from_raw(&synced, "LRCLIB");
    if result.cues.is_empty() {
        let plain = str_field(data, "plainLyrics");
        if !plain.is_empty() {
            result = LyricsResult::from_raw(&plain, "LRCLIB");
        }
    }
    result.with_title(&str_field(data, "trackName"))
}

fn netease_result(data: &Value) -> LyricsResult {
    let mut result = LyricsResult::from_raw(
        data.pointer("/lrc/lyric")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "NetEase",
    );
    let mut words = parse_yrc(
        data.pointer("/yrc/lyric")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    // Translation timelines can differ between old LRC and YRC. Exact timestamp
    // alignment in merge_translation prevents a missing line shifting all others.
    for field in ["tlyric", "ytlrc"] {
        if let Some(raw) = data
            .get(field)
            .and_then(|value| value.get("lyric"))
            .and_then(Value::as_str)
        {
            merge_translation(&mut result.cues, raw);
            merge_translation(&mut words, raw);
        }
    }
    add_word_cues(&mut result, words);
    result
}

/// Keep line-only text when a rich payload is partial or contains malformed rows.
fn add_word_cues(result: &mut LyricsResult, words: Vec<Cue>) {
    if words.is_empty() {
        return;
    }
    if result.cues.is_empty() {
        result.cues = words;
    } else {
        let mut used = vec![false; words.len()];
        let mut assigned = vec![false; result.cues.len()];
        // Reserve every exact timestamp before a nearby repeated sentence can
        // consume its rich row. The second pass still permits provider offsets.
        for tolerance in [0, 2000] {
            for (line_index, cue) in result.cues.iter_mut().enumerate() {
                if assigned[line_index] {
                    continue;
                }
                let title = normalize(&cue.text);
                let matched = words
                    .iter()
                    .enumerate()
                    .filter(|(index, rich)| {
                        !used[*index]
                            && (rich.time_ms - cue.time_ms).abs() <= tolerance
                            && !title.is_empty()
                            && normalize(&rich.text) == title
                    })
                    .min_by_key(|(_, rich)| (rich.time_ms - cue.time_ms).abs());
                if let Some((index, rich)) = matched {
                    used[index] = true;
                    assigned[line_index] = true;
                    cue.time_ms = rich.time_ms;
                    cue.words.clone_from(&rich.words);
                    if rich.translation.is_some() {
                        cue.translation.clone_from(&rich.translation);
                    }
                }
            }
        }
        result.cues.sort_by_key(|cue| cue.time_ms);
    }
    result.text = result
        .cues
        .iter()
        .map(|cue| cue.text.as_str())
        .collect::<Vec<_>>()
        .join("\n");
}

fn decode_qq_field(data: &Value, field: &str) -> String {
    let raw = str_field(data, field);
    if raw.starts_with('[') || raw.starts_with('<') {
        return raw;
    }
    base64_decode(&raw)
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn qqmusic_result(data: &Value) -> LyricsResult {
    let raw = decode_qq_field(data, "lyric");
    let mut result = LyricsResult::from_raw(&raw, "QQ Music");
    // The public endpoint generally returns LRC. Preserve decoded QRC if supplied;
    // encrypted proprietary QRC requires a separate decoder and is not text.
    let mut words = parse_qrc(&raw);
    if words.is_empty() {
        words = parse_qrc(&decode_qq_field(data, "qrc"));
    }
    let translation = decode_qq_field(data, "trans");
    merge_translation(&mut result.cues, &translation);
    merge_translation(&mut words, &translation);
    add_word_cues(&mut result, words);
    result
}

/// Fetch only an explicit, validated provider id; manual choices need not match
/// the playing track's metadata (that is the reason the manual picker exists).
pub async fn fetch_candidate(
    client: &reqwest::Client,
    candidate: &LyricCandidate,
) -> ProviderResult {
    validate_candidate(candidate)?;
    let result = match candidate.source.as_str() {
        "youtube_music" => crate::youtube_music::lyrics(client, candidate).await?,
        "lrclib" => {
            let data = request_json(
                client,
                &format!("https://lrclib.net/api/get/{}", candidate.id),
                &[],
                None,
                false,
            )
            .await?;
            lrclib_result(&data)
        }
        "netease" => {
            // The newer endpoint carries yrc/ytlrc. One legacy retry keeps existing
            // line-only coverage when a region or provider rejects the new route.
            let newer = request_json(
                client,
                "https://music.163.com/api/song/lyric/v1",
                &[
                    ("id", candidate.id.clone()),
                    ("cp", "false".into()),
                    ("tv", "0".into()),
                    ("lv", "0".into()),
                    ("rv", "0".into()),
                    ("kv", "0".into()),
                    ("yv", "0".into()),
                    ("ytv", "0".into()),
                    ("yrv", "0".into()),
                ],
                Some("https://music.163.com/"),
                true,
            )
            .await;
            let newer = newer.and_then(|data| {
                if data.get("code").and_then(Value::as_i64) != Some(200) {
                    return Err(ProviderError::Rejected);
                }
                Ok(netease_result(&data))
            });
            match newer {
                Ok(result) if !result.is_empty() => result,
                _ => {
                    let data = request_json(
                        client,
                        "https://music.163.com/api/song/lyric",
                        &[
                            ("id", candidate.id.clone()),
                            ("lv", "-1".into()),
                            ("tv", "-1".into()),
                        ],
                        Some("https://music.163.com/"),
                        false,
                    )
                    .await?;
                    if data.get("code").and_then(Value::as_i64) != Some(200) {
                        return Err(ProviderError::Rejected);
                    }
                    netease_result(&data)
                }
            }
        }
        "qqmusic" => {
            let data = request_json(
                client,
                "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
                &[
                    ("songmid", candidate.id.clone()),
                    ("g_tk", "5381".into()),
                    ("format", "json".into()),
                    ("platform", "yqq".into()),
                ],
                Some("https://y.qq.com/portal/player.html"),
                false,
            )
            .await?;
            if data.get("code").and_then(Value::as_i64) != Some(0) {
                return Err(ProviderError::Rejected);
            }
            qqmusic_result(&data)
        }
        _ => return Err(ProviderError::BadPayload),
    };
    Ok(result.with_title(&candidate.title))
}

fn automatic_candidates(
    query: &TrackQuery,
    mut candidates: Vec<LyricCandidate>,
) -> Vec<LyricCandidate> {
    candidates.retain(|candidate| {
        if candidate.source == "youtube_music" {
            return crate::youtube_music::matches_track(query, candidate);
        }
        matches(
            &query.track,
            &query.artists,
            query.duration_ms,
            &candidate.title,
            &candidate.artists,
            Some(candidate.duration_ms),
        )
    });
    let album = normalize(&query.album);
    candidates.sort_by_key(|candidate| normalize(&candidate.album) != album);
    candidates.truncate(MAX_AUTOMATIC_FETCHES);
    candidates
}

async fn fetch_first_available<F, Fut>(
    candidates: Vec<LyricCandidate>,
    deadline: tokio::time::Instant,
    mut fetch: F,
) -> ProviderResult
where
    F: FnMut(LyricCandidate) -> Fut,
    Fut: std::future::Future<Output = ProviderResult>,
{
    let mut fallback = None;
    let mut last_error = None;
    for candidate in candidates {
        if tokio::time::Instant::now() >= deadline {
            last_error = Some(ProviderError::Timeout);
            break;
        }
        let outcome = match tokio::time::timeout_at(deadline, fetch(candidate)).await {
            Ok(outcome) => outcome,
            Err(_) => {
                last_error = Some(ProviderError::Timeout);
                break;
            }
        };
        match outcome {
            Ok(result) if !result.cues.is_empty() => return Ok(result),
            Ok(result) if !result.is_empty() && fallback.is_none() => fallback = Some(result),
            Ok(_) => {}
            Err(error) => last_error = Some(error),
        }
    }
    if let Some(result) = fallback {
        return Ok(result);
    }
    if let Some(error) = last_error {
        return Err(error);
    }
    Ok(LyricsResult::default())
}

async fn automatic_search(
    client: &reqwest::Client,
    query: &TrackQuery,
    source: &str,
) -> ProviderResult {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    let candidates = tokio::time::timeout_at(
        deadline,
        search_candidates(client, &query.search_phrase(), source),
    )
    .await
    .map_err(|_| ProviderError::Timeout)?;
    let first = match candidates {
        Ok(candidates) => {
            fetch_first_available(
                automatic_candidates(query, candidates),
                deadline,
                |candidate| async move { fetch_candidate(client, &candidate).await },
            )
            .await
        }
        Err(error) => Err(error),
    };
    if source != "youtube_music" || first.as_ref().is_ok_and(|result| !result.is_empty()) {
        return first;
    }
    // SMTC may expose an MV's translated metadata rather than the album song's
    // localized title/artist. Search videos only after Songs gave no usable lyrics,
    // sharing the original deadline and the same recording identity safeguards.
    let videos = tokio::time::timeout_at(
        deadline,
        crate::youtube_music::search_videos(client, &query.search_phrase()),
    )
    .await
    .map_err(|_| ProviderError::Timeout)??;
    let mut fallback = first;
    for video in automatic_candidates(query, videos) {
        match tokio::time::timeout_at(deadline, fetch_candidate(client, &video)).await {
            Ok(Ok(result)) if !result.cues.is_empty() => return Ok(result),
            Ok(Ok(result)) if !result.is_empty() => {
                // Keep the MV's plain lyrics before looking up its localized song.
                // An exhausted enrichment deadline must not erase downloaded text.
                if !fallback.as_ref().is_ok_and(|saved| !saved.is_empty()) {
                    fallback = Ok(result);
                }
                if let Ok(Ok(synced)) = tokio::time::timeout_at(
                    deadline,
                    crate::youtube_music::localized_song_lyrics(client, query, &video),
                )
                .await
                {
                    if !synced.cues.is_empty() {
                        return Ok(synced);
                    }
                }
            }
            Ok(Ok(_)) => {}
            outcome => {
                if !fallback.as_ref().is_ok_and(|saved| !saved.is_empty()) {
                    fallback = Err(match outcome {
                        Ok(Err(error)) => error,
                        _ => ProviderError::Timeout,
                    });
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            break;
        }
    }
    fallback
}

// ---------------------------------------------------------------- LRCLIB

pub async fn lrclib(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    let params = [
        ("track_name", query.track.clone()),
        ("artist_name", query.primary_artist().to_string()),
        ("album_name", query.album.clone()),
        (
            "duration",
            ((query.duration_ms as f64 / 1000.0).round() as i64).to_string(),
        ),
    ];
    let exact = request_json(client, "https://lrclib.net/api/get", &params, None, false).await;
    lrclib_with_fallback(query, exact, || automatic_search(client, query, "lrclib")).await
}

async fn lrclib_with_fallback<F, Fut>(
    query: &TrackQuery,
    exact: Result<Value, ProviderError>,
    search: F,
) -> ProviderResult
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = ProviderResult>,
{
    if let Ok(data) = exact {
        if candidate_from_json("lrclib", &data).is_some_and(|candidate| {
            matches(
                &query.track,
                &query.artists,
                query.duration_ms,
                &candidate.title,
                &candidate.artists,
                Some(candidate.duration_ms),
            )
        }) {
            let result = lrclib_result(&data);
            if !result.is_empty() {
                return Ok(result);
            }
        }
    }
    search().await
}

pub async fn netease(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    automatic_search(client, query, "netease").await
}

pub async fn qqmusic(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    automatic_search(client, query, "qqmusic").await
}

fn base64_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

/// Run one provider by its settings id.
///
/// The id space is owned by `settings::PROVIDERS`, so an id that reaches here
/// without a match came from a settings file this build does not understand;
/// it answers "nothing found" rather than failing the whole lookup.
pub async fn fetch_one(
    client: &reqwest::Client,
    musixmatch_session: &crate::musixmatch::Session,
    id: &str,
    query: &TrackQuery,
) -> ProviderResult {
    match id {
        "lrclib" => lrclib(client, query).await,
        "petitlyrics" => crate::petitlyrics::fetch(client, query).await,
        "musixmatch" => crate::musixmatch::fetch(client, musixmatch_session, query).await,
        "netease" => netease(client, query).await,
        "qqmusic" => qqmusic(client, query).await,
        "youtube_music" => automatic_search(client, query, "youtube_music").await,
        _ => Ok(LyricsResult::empty("")),
    }
}

/// Ordered lookup across the sources the settings enable.
///
/// The first word-timed result wins. After finding line timing, inspect at most
/// two more enabled sources for words, then keep that original line result.
/// Plain text remains a last resort. Errors never break the source chain.
///
/// The order is the reader's, from the settings panel; `settings::PROVIDERS`
/// documents the default and why it is what it is.
pub async fn fetch_lyrics(
    client: &reqwest::Client,
    musixmatch_session: &crate::musixmatch::Session,
    query: &TrackQuery,
    order: &[String],
) -> LyricsResult {
    let mut chain = Chain::default();
    let mut word_deadline = None;
    let alternate = query.alternate_query();
    'queries: for query in std::iter::once(query).chain(alternate.as_ref()) {
        for id in order {
            let label = crate::settings::provider_label(id).unwrap_or(id.as_str());
            let lookup = fetch_one(client, musixmatch_session, id, query);
            let outcome = if let Some(deadline) = word_deadline {
                match tokio::time::timeout_at(deadline, lookup).await {
                    Ok(outcome) => outcome,
                    // Optional enrichment must not delay an already usable answer.
                    Err(_) => break 'queries,
                }
            } else {
                lookup.await
            };
            if let Some(result) = chain.consider(label, outcome) {
                return result;
            }
            if chain.remaining_after_lines.is_some() && word_deadline.is_none() {
                word_deadline = Some(tokio::time::Instant::now() + Duration::from_secs(3));
            }
        }
    }

    chain.finish()
}

/// Look a track up in exactly one source, because the reader pinned it there.
///
/// No fallback: a pin that quietly answered from somewhere else would make the
/// source badge a lie, and the badge is the only way to tell where a line came
/// from.
pub async fn fetch_pinned(
    client: &reqwest::Client,
    musixmatch_session: &crate::musixmatch::Session,
    id: &str,
    query: &TrackQuery,
) -> LyricsResult {
    let label = crate::settings::provider_label(id).unwrap_or(id);
    let mut chain = Chain::default();
    if let Some(result) = chain.consider(
        label,
        fetch_one(client, musixmatch_session, id, query).await,
    ) {
        return result;
    }
    if let Some(alternate) = query.alternate_query() {
        if let Some(result) = chain.consider(
            label,
            fetch_one(client, musixmatch_session, id, &alternate).await,
        ) {
            return result;
        }
    }
    let mut result = chain.finish();
    // A plain-text-only answer still came from the pinned source.
    if result.source.is_empty() {
        result.source = label.to_string();
    }
    result
}

#[derive(Default)]
struct Chain {
    fallback: Option<LyricsResult>,
    errors: Vec<String>,
    /// ponytail: two extra lookups bound latency; no parallel task scheduler.
    remaining_after_lines: Option<usize>,
}

impl Chain {
    /// Returns the result to stop on, or `None` to keep going.
    fn consider(&mut self, name: &str, outcome: ProviderResult) -> Option<LyricsResult> {
        if let Some(remaining) = &mut self.remaining_after_lines {
            *remaining = remaining.saturating_sub(1);
        }
        match outcome {
            Ok(mut result) => {
                // Native timing wins, but plain lyrics must not prevent another
                // enabled provider from supplying a synchronized recording.
                if (result.source == "YouTube Music" && !result.cues.is_empty())
                    || result.cues.iter().any(|cue| !cue.words.is_empty())
                {
                    result.errors = std::mem::take(&mut self.errors);
                    return Some(result);
                }
                if !result.cues.is_empty() {
                    self.remaining_after_lines.get_or_insert(2);
                    if self
                        .fallback
                        .as_ref()
                        .is_none_or(|saved| saved.cues.is_empty())
                    {
                        self.fallback = Some(result);
                    }
                } else if !result.text.is_empty() && self.fallback.is_none() {
                    self.fallback = Some(result);
                }
            }
            Err(error) => {
                // Only the kind of failure is recorded: responses and URLs can
                // carry lyrics and metadata and must not reach the interface.
                self.errors.push(format!("{name}: {error}"));
            }
        }
        if self.remaining_after_lines == Some(0) {
            let mut result = self.fallback.take().unwrap_or_default();
            result.errors = std::mem::take(&mut self.errors);
            Some(result)
        } else {
            None
        }
    }

    fn finish(self) -> LyricsResult {
        let mut result = self.fallback.unwrap_or_default();
        result.errors = self.errors;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn localized_query() -> TrackQuery {
        TrackQuery {
            track: "エリーの休日".into(),
            artists: vec!["Sān-Z".into(), "HOYO-MiX".into()],
            album: "スターズ・オブ・リラ+".into(),
            duration_ms: 258_640,
            spotify_id: Some("0XEwwNeNDbk5KaBJcg0389".into()),
        }
    }

    #[test]
    fn recording_alias_requires_verified_identity() {
        let original = localized_query();
        let alternate = original.alternate_query().unwrap();
        assert_eq!(alternate.search_phrase(), "丽都假日 HOYO-MiX");
        assert!(matches(
            &alternate.track,
            &alternate.artists,
            alternate.duration_ms,
            "丽都假日",
            &["三Z-STUDIO".into(), "HOYO-MiX".into(), "于梓贝".into()],
            Some(258_640)
        ));
        assert!(alternate.alternate_query().is_none());
        let mut wrong = original.clone();
        wrong.spotify_id = None;
        assert!(wrong.alternate_query().is_none());
        wrong = original.clone();
        wrong.track.push_str(" - Instrumental");
        assert!(wrong.alternate_query().is_none());
        wrong = original.clone();
        wrong.artists = vec!["Cover Artist".into()];
        assert!(wrong.alternate_query().is_none());
        wrong = original;
        wrong.duration_ms = 120_000;
        assert!(wrong.alternate_query().is_none());
    }

    #[test]
    fn matched_title_belongs_to_winning_lyrics_only() {
        assert!(LyricsResult::empty("test")
            .with_title("Unused")
            .matched_title
            .is_empty());
        let mut chain = Chain::default();
        assert!(chain
            .consider(
                "plain",
                Ok(LyricsResult::from_raw("plain", "plain").with_title("Plain title"))
            )
            .is_none());
        assert!(chain
            .consider(
                "synced",
                Ok(LyricsResult::from_raw("[00:01]line", "synced").with_title("Synced title")),
            )
            .is_none());
        let result = chain.finish();
        assert_eq!(result.matched_title, "Synced title");
    }

    #[tokio::test]
    #[ignore = "requires live lyric providers"]
    async fn live_localized_spotify_lyrics() {
        let client = super::client().unwrap();
        let session = crate::musixmatch::Session::new();
        let query = localized_query();
        let result = fetch_lyrics(&client, &session, &query, &["netease".into()]).await;
        println!(
            "localized auto: source={} title={} cues={} errors={:?}",
            result.source,
            result.matched_title,
            result.cues.len(),
            result.errors
        );
        assert_eq!(result.source, "NetEase");
        assert_eq!(result.matched_title, "丽都假日");
        assert!(!result.cues.is_empty());
        let pinned = fetch_pinned(&client, &session, "netease", &query).await;
        assert_eq!(pinned.source, "NetEase");
        assert_eq!(pinned.matched_title, "丽都假日");
        assert!(!pinned.cues.is_empty());
        let disabled = fetch_lyrics(&client, &session, &query, &[]).await;
        assert!(disabled.is_empty());
        let order = crate::settings::Settings::default().lookup_order();
        let automatic = fetch_lyrics(&client, &session, &query, &order).await;
        println!(
            "localized default: source={} title={} cues={} errors={:?}",
            automatic.source,
            automatic.matched_title,
            automatic.cues.len(),
            automatic.errors
        );
        assert!(!automatic.cues.is_empty());
        assert!(!automatic.matched_title.is_empty());
    }

    #[test]
    fn synced_payload_wins_over_its_own_plain_text() {
        let result = LyricsResult::from_raw("[00:01]LINE_A\n[00:02]LINE_B", "test");
        assert_eq!(result.cues.len(), 2);
        assert_eq!(result.text, "LINE_A\nLINE_B");
    }

    #[test]
    fn blank_timeline_is_treated_as_no_timeline() {
        let result = LyricsResult::from_raw("[00:01]\n[00:02]", "test");
        assert!(result.cues.is_empty());
        assert!(result.text.is_empty());
    }

    #[test]
    fn plain_payload_keeps_its_text_and_drops_metadata_tags() {
        let result = LyricsResult::from_raw("[ar:Someone]\nLINE_A\nLINE_B", "test");
        assert!(result.cues.is_empty());
        assert_eq!(result.text, "LINE_A\nLINE_B");
    }

    /// Live probe against the real endpoints. Ignored by default: it needs the
    /// network, and the unofficial sources can be rate-limited or blocked at any
    /// time. Run with `cargo test -- --ignored --nocapture`.
    ///
    /// It reports which source answered and how many cues came back; it never
    /// prints lyric content.
    #[tokio::test]
    #[ignore]
    async fn live_provider_chain_probe() {
        let client = super::client().unwrap();
        let musixmatch = crate::musixmatch::Session::new();
        let query = TrackQuery {
            track: "Lemon".into(),
            artists: vec!["米津玄師".into()],
            album: "Lemon".into(),
            duration_ms: 255_000,
            spotify_id: None,
        };

        // Each provider is probed on its own so one refusal does not hide the rest.
        let lrclib = super::lrclib(&client, &query).await;
        println!("LRCLIB      -> {}", describe(&lrclib));
        let mxm = crate::musixmatch::fetch(&client, &musixmatch, &query).await;
        println!("Musixmatch  -> {}", describe(&mxm));
        let petit = crate::petitlyrics::fetch(&client, &query).await;
        println!("PetitLyrics -> {}", describe(&petit));
        let netease = super::netease(&client, &query).await;
        println!("NetEase     -> {}", describe(&netease));
        let qq = super::qqmusic(&client, &query).await;
        println!("QQ Music    -> {}", describe(&qq));

        let order = crate::settings::Settings::default().lookup_order();
        let chained = super::fetch_lyrics(&client, &musixmatch, &query, &order).await;
        println!(
            "chain       -> source={:?} synced={} cues={} chars={} errors={:?}",
            chained.source,
            !chained.cues.is_empty(),
            chained.cues.len(),
            chained.text.chars().count(),
            chained.errors
        );
    }

    #[cfg(test)]
    fn describe(outcome: &ProviderResult) -> String {
        match outcome {
            Ok(result) if !result.cues.is_empty() => {
                format!("synced, {} cues", result.cues.len())
            }
            Ok(result) if !result.text.is_empty() => {
                format!("plain, {} chars", result.text.chars().count())
            }
            Ok(_) => "no match".to_string(),
            Err(error) => format!("failed: {error}"),
        }
    }

    fn query() -> TrackQuery {
        TrackQuery {
            track: "Title".into(),
            artists: vec!["First".into()],
            album: "Album".into(),
            duration_ms: 180_000,
            spotify_id: None,
        }
    }

    /// A settings file naming a provider this build dropped must not fail the
    /// lookup; it is simply a source that finds nothing.
    #[tokio::test]
    async fn an_unknown_provider_id_finds_nothing_instead_of_erroring() {
        let client = super::client().unwrap();
        let session = crate::musixmatch::Session::new();
        let result = fetch_one(&client, &session, "ghost", &query())
            .await
            .unwrap();
        assert!(result.is_empty());
    }

    /// An empty order means no source was consulted, which is an empty answer
    /// and not a hang or a panic.
    #[tokio::test]
    async fn an_empty_order_returns_an_empty_result() {
        let client = super::client().unwrap();
        let session = crate::musixmatch::Session::new();
        let result = fetch_lyrics(&client, &session, &query(), &[]).await;
        assert!(result.is_empty());
        assert!(result.errors.is_empty());
    }

    /// Every id the settings offer must be wired into `fetch_one`; a typo would
    /// otherwise turn a source into a silent no-op only noticed in use.
    #[test]
    fn every_settings_provider_id_has_a_label() {
        for (id, label) in crate::settings::PROVIDERS {
            assert_eq!(crate::settings::provider_label(id), Some(label));
        }
    }

    #[test]
    fn search_phrase_joins_title_and_first_artist() {
        let query = TrackQuery {
            track: "Title".into(),
            artists: vec!["First".into(), "Second".into()],
            album: "Album".into(),
            duration_ms: 180_000,
            spotify_id: None,
        };
        assert_eq!(query.search_phrase(), "Title First");
        assert_eq!(query.primary_artist(), "First");
    }

    fn candidate(id: &str) -> LyricCandidate {
        LyricCandidate {
            source: "netease".into(),
            id: id.into(),
            title: "Title".into(),
            artists: vec!["First".into()],
            album: "Album".into(),
            duration_ms: 180_000,
        }
    }

    #[tokio::test]
    async fn lrclib_falls_back_for_http_failure_empty_or_wrong_identity() {
        let empty = serde_json::json!({
            "id": 1, "trackName": "Title", "artistName": "First", "albumName": "Album",
            "duration": 180, "syncedLyrics": "", "plainLyrics": "",
        });
        let wrong = serde_json::json!({
            "id": 2, "trackName": "Title (Live)", "artistName": "First", "albumName": "Album",
            "duration": 180, "syncedLyrics": "[00:01]wrong",
        });
        for exact in [Err(ProviderError::Http), Ok(empty.clone()), Ok(wrong)] {
            let result = lrclib_with_fallback(&query(), exact, || async {
                Ok(LyricsResult::from_raw("[00:01]search answer", "search"))
            })
            .await
            .unwrap();
            assert_eq!(result.source, "search");
        }
        let mut found = empty;
        found["syncedLyrics"] = Value::String("[00:01]exact".into());
        let result = lrclib_with_fallback(&query(), Ok(found), || async {
            panic!("an exact answer must avoid the search request");
        })
        .await
        .unwrap();
        assert_eq!(result.text, "exact");
    }

    #[tokio::test]
    async fn automatic_candidates_continue_after_empty_and_plain_results() {
        let candidates = vec![candidate("1"), candidate("2"), candidate("3")];
        let mut tried = Vec::new();
        let result = fetch_first_available(
            candidates,
            tokio::time::Instant::now() + Duration::from_secs(1),
            |candidate| {
                tried.push(candidate.id.clone());
                async move {
                    Ok(match candidate.id.as_str() {
                        "1" => LyricsResult::empty("NetEase"),
                        "2" => LyricsResult::from_raw("plain", "NetEase"),
                        _ => LyricsResult::from_raw("[00:01]timed", "NetEase"),
                    })
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(tried, ["1", "2", "3"]);
        assert_eq!(result.text, "timed");
        assert_eq!(result.cues.len(), 1);
    }

    #[tokio::test]
    async fn candidate_deadline_preserves_already_fetched_plain_lyrics() {
        let started = tokio::time::Instant::now();
        let deadline = started + Duration::from_millis(20);
        let result = fetch_first_available(
            vec![candidate("1"), candidate("2")],
            deadline,
            |candidate| async move {
                if candidate.id == "1" {
                    Ok(LyricsResult::from_raw("Already fetched", "NetEase"))
                } else {
                    std::future::pending::<ProviderResult>().await
                }
            },
        )
        .await
        .unwrap();
        assert_eq!(result.text, "Already fetched");
        assert!(started.elapsed() < Duration::from_secs(1));

        let error = fetch_first_available(
            vec![candidate("1")],
            tokio::time::Instant::now() + Duration::from_millis(20),
            |_| std::future::pending::<ProviderResult>(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, ProviderError::Timeout));
    }

    #[test]
    fn candidate_search_preserves_manual_aliases_and_rejects_unsafe_ids() {
        let response = serde_json::json!({"code":200,"result":{"songs":[
            {"id":42,"name":"Alias title","artists":[{"name":"Other script"}],
             "album":{"name":"Album"},"duration":180000}
        ]}});
        let candidates = candidates_from_response("netease", &response).unwrap();
        assert_eq!(candidates[0].title, "Alias title");
        assert!(automatic_candidates(&query(), candidates).is_empty());
        for id in [
            "../../settings",
            "https://example.com",
            "1?other=value",
            "",
            "123\n",
        ] {
            assert!(validate_candidate(&candidate(id)).is_err());
        }
        let mut valid = candidate("42");
        assert!(validate_candidate(&valid).is_ok());
        valid.source = "qqmusic".into();
        valid.id = "003abcXYZ".into();
        assert!(validate_candidate(&valid).is_ok());
        valid.source = "youtube_music".into();
        valid.id = "Abc_def-123".into();
        assert!(validate_candidate(&valid).is_ok());
        valid.id = "Abc/def1234".into();
        assert!(validate_candidate(&valid).is_err());
        valid.id = "Abc_def-123".into();
        valid.title = "x".repeat(1025);
        assert!(validate_candidate(&valid).is_err());
    }

    #[test]
    fn automatic_selection_keeps_identity_album_order_and_fetch_bound() {
        let mut candidates = (1..=10)
            .map(|n| candidate(&n.to_string()))
            .collect::<Vec<_>>();
        candidates[0].album = "Compilation".into();
        candidates[1].title = "Title (Live)".into();
        candidates[2].duration_ms += 5000;
        let selected = automatic_candidates(&query(), candidates);
        assert_eq!(selected.len(), MAX_AUTOMATIC_FETCHES);
        assert_eq!(selected[0].id, "4");
        assert!(!selected.iter().any(|item| item.id == "2" || item.id == "3"));
    }

    #[test]
    fn native_lyrics_win_and_missing_native_keeps_fallback_chain() {
        let result = Chain::default()
            .consider(
                "YouTube Music",
                Ok(LyricsResult::from_raw(
                    "[00:01]Native line",
                    "YouTube Music",
                )),
            )
            .unwrap();
        assert_eq!(result.source, "YouTube Music");
        assert!(!result.cues.is_empty());
        for native in [
            Ok(LyricsResult::empty("YouTube Music")),
            Ok(LyricsResult::from_raw(
                "Native plain lyrics",
                "YouTube Music",
            )),
            Err(ProviderError::Http),
        ] {
            let mut chain = Chain::default();
            assert!(chain.consider("YouTube Music", native).is_none());
            assert!(chain
                .consider(
                    "LRCLIB",
                    Ok(LyricsResult::from_raw("[00:01]Fallback", "LRCLIB"))
                )
                .is_none());
            assert_eq!(chain.finish().source, "LRCLIB");
        }
        let mut plain = Chain::default();
        assert!(plain
            .consider(
                "YouTube Music",
                Ok(LyricsResult::from_raw(
                    "Native plain lyrics",
                    "YouTube Music"
                ))
            )
            .is_none());
        assert!(plain.consider("LRCLIB", Err(ProviderError::Http)).is_none());
        assert_eq!(plain.finish().text, "Native plain lyrics");
    }

    #[tokio::test]
    #[ignore = "public YouTube Music regression for the user's SMTC music-video metadata"]
    async fn live_youtube_smtc_music_video_lyrics() {
        let query = TrackQuery {
            track: "Just a Sunny Day for You".into(),
            artists: vec!["YORUSHIKA".into()],
            album: String::new(),
            duration_ms: 199_000,
            spotify_id: None,
        };
        let result = fetch_lyrics(
            &client().unwrap(),
            &crate::musixmatch::Session::new(),
            &query,
            &crate::settings::Settings::default().lyric_order(crate::player::PlayerKind::Ytmusic),
        )
        .await;
        eprintln!(
            "source={}, title={}, lines={}, cues={}, errors={:?}",
            result.source,
            result.matched_title,
            result.text.lines().count(),
            result.cues.len(),
            result.errors
        );
        assert!(
            !result.is_empty(),
            "the screenshot recording has native lyrics"
        );
        assert_eq!(result.source, "YouTube Music");
        assert!(
            !result.cues.is_empty(),
            "prefer the verified song's native time-stamped lyrics over MV plain text"
        );
    }

    #[tokio::test]
    #[ignore = "public YouTube Music regression for a credit joined in the reader's language"]
    async fn live_youtube_smtc_localized_joint_credit() {
        // What SMTC reported for owTWCbq_nSk with YouTube Music in Chinese.
        let query = TrackQuery {
            track: "Something Just Like This".into(),
            artists: crate::smtc::split_artists("The Chainsmokers\u{548c}Coldplay"),
            album: "Something Just Like This".into(),
            duration_ms: 247_641,
            spotify_id: None,
        };
        let result = fetch_lyrics(
            &client().unwrap(),
            &crate::musixmatch::Session::new(),
            &query,
            &crate::settings::Settings::default().lyric_order(crate::player::PlayerKind::Ytmusic),
        )
        .await;
        eprintln!(
            "artists={:?}, source={}, title={}, lines={}, cues={}, errors={:?}",
            query.artists,
            result.source,
            result.matched_title,
            result.text.lines().count(),
            result.cues.len(),
            result.errors
        );
        // YouTube Music answers first, and lists the two artists apart; LRCLIB only
        // sometimes holds the joined credit, and is busy at times.
        assert_eq!(result.source, "YouTube Music");
        assert!(!result.cues.is_empty());
    }

    /// A local server that answers each request with the next status and
    /// `retry-after` in line, and counts what it was asked.
    fn serve(
        answers: Vec<(u16, Option<&'static str>)>,
    ) -> (String, std::sync::mpsc::Receiver<usize>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/api/search", listener.local_addr().unwrap());
        let (done, asked) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut count = 0;
            for (status, retry_after) in answers {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut request = [0u8; 4096];
                let _ = stream.read(&mut request);
                count += 1;
                let header = retry_after
                    .map(|s| format!("retry-after: {s}\r\n"))
                    .unwrap_or_default();
                let _ = write!(
                    stream,
                    "HTTP/1.1 {status} X\r\n{header}content-length: 2\r\nconnection: close\r\n\r\n[]"
                );
            }
            let _ = done.send(count);
        });
        (url, asked)
    }

    #[tokio::test]
    #[ignore = "public LRCLIB; prints how many manual searches got through its overload"]
    async fn live_lrclib_search_rides_out_overload() {
        let client = client().unwrap();
        let mut outcomes = Vec::new();
        for round in 0..10 {
            let query = format!("Something Just Like This The Chainsmokers {round}");
            outcomes.push(match search_candidates(&client, &query, "lrclib").await {
                Ok(_) => "ok".to_string(),
                Err(error) => error.to_string(),
            });
        }
        eprintln!("lrclib manual searches: {outcomes:?}");
    }

    #[tokio::test]
    async fn an_overloaded_server_is_asked_again_after_the_wait_it_names() {
        let client = client().unwrap();
        let (url, asked) = serve(vec![(503, Some("0")), (503, Some("0")), (200, None)]);
        assert_eq!(
            request_json(&client, &url, &[], None, false).await.unwrap(),
            serde_json::json!([])
        );
        assert_eq!(asked.recv_timeout(Duration::from_secs(10)).unwrap(), 3);

        let (url, asked) = serve(vec![(503, Some("0")), (429, None), (503, Some("0"))]);
        let started = std::time::Instant::now();
        assert!(matches!(
            request_json(&client, &url, &[], None, false).await,
            Err(ProviderError::Busy)
        ));
        assert_eq!(asked.recv_timeout(Duration::from_secs(10)).unwrap(), 3);
        // A 429 without `retry-after` waits a second.
        assert!(started.elapsed() >= Duration::from_secs(1));

        // A wait longer than is worth it is not waited for.
        let (url, asked) = serve(vec![(503, Some("60"))]);
        assert!(matches!(
            request_json(&client, &url, &[], None, false).await,
            Err(ProviderError::Busy)
        ));
        assert_eq!(asked.recv_timeout(Duration::from_secs(10)).unwrap(), 1);
    }

    #[test]
    fn a_credit_joined_in_the_readers_language_matches_its_artists_listed_apart() {
        let mut query = query();
        query.artists = crate::smtc::split_artists("First\u{548c}Guest");
        let mut native = candidate("Abc_def-123");
        native.source = "youtube_music".into();
        native.artists = vec!["First".into(), "Guest".into()];
        assert_eq!(
            automatic_candidates(&query, vec![native.clone()]),
            vec![native]
        );
    }

    #[test]
    fn youtube_candidates_require_recording_identity_for_automatic_lookup() {
        let mut exact = candidate("Abc_def-123");
        exact.source = "youtube_music".into();
        let mut unknown_duration = exact.clone();
        unknown_duration.duration_ms = 0;
        let mut live = exact.clone();
        live.title.push_str(" (Live)");
        let mut cover = exact.clone();
        cover.artists = vec!["Cover artist".into()];
        let selected =
            automatic_candidates(&query(), vec![unknown_duration, live, cover, exact.clone()]);
        assert_eq!(selected, vec![exact]);
    }

    #[test]
    fn netease_retains_words_translation_and_line_fallback() {
        let data = serde_json::json!({
            "lrc":{"lyric":"[00:01]AB\n[00:03]Keep this line"},
            "yrc":{"lyric":"[1000,1000](1000,500,0)A(1500,500,0)B"},
            "tlyric":{"lyric":"[00:01]Translation"},
            "ytlrc":{"lyric":"[00:01]Translation"}
        });
        let result = netease_result(&data);
        assert_eq!(result.cues.len(), 2);
        assert_eq!(result.cues[0].words.len(), 2);
        assert_eq!(result.cues[0].translation.as_deref(), Some("Translation"));
        assert_eq!(result.cues[1].text, "Keep this line");
        assert!(result.cues[1].words.is_empty());
        assert!(result.cues[1].translation.is_none());
        let shifted = serde_json::json!({
            "lrc":{"lyric":"[00:01]AB"},
            "yrc":{"lyric":"[1100,1000](1100,500,0)A(1600,500,0)B"},
            "tlyric":{"lyric":"[00:01]Translation"}
        });
        let result = netease_result(&shifted);
        assert_eq!(result.cues[0].time_ms, 1100);
        assert_eq!(result.cues[0].translation.as_deref(), Some("Translation"));
        // Equal line counts do not prove coverage: the rich file can split one
        // sentence in two while omitting a different sentence completely.
        let split_and_missing = serde_json::json!({
            "lrc":{"lyric":"[00:01]AB\n[00:03]Keep this line"},
            "yrc":{"lyric":"[1000,500](1000,500,0)A\n[1500,500](1500,500,0)B"},
            "tlyric":{"lyric":"[00:03]Keep its translation"}
        });
        let result = netease_result(&split_and_missing);
        assert_eq!(result.cues.len(), 2);
        assert_eq!(result.cues[1].text, "Keep this line");
        assert_eq!(
            result.cues[1].translation.as_deref(),
            Some("Keep its translation")
        );
    }

    #[test]
    fn rich_exact_match_is_reserved_before_nearby_repeated_text() {
        let data = serde_json::json!({
            "lrc":{"lyric":"[00:01]Go\n[00:02]Go\n[00:05]Keep"},
            "yrc":{"lyric":"[2000,1000](2000,1000,0)Go"},
            "tlyric":{"lyric":"[00:01]First translation\n[00:02]Second translation"}
        });
        let result = netease_result(&data);
        assert_eq!(
            result
                .cues
                .iter()
                .map(|cue| cue.time_ms)
                .collect::<Vec<_>>(),
            [1000, 2000, 5000]
        );
        assert!(result.cues[0].words.is_empty());
        assert_eq!(result.cues[1].words.len(), 1);
        assert_eq!(
            result.cues[1].translation.as_deref(),
            Some("Second translation")
        );
        let active = crate::lrc::active_line(&result.cues, 2500) as usize;
        assert_eq!(active, 1);
        assert!(!result.cues[active].words.is_empty());
    }

    #[test]
    fn qqmusic_decodes_translation_and_plaintext_qrc() {
        use base64::Engine;
        let encode = |raw: &str| base64::engine::general_purpose::STANDARD.encode(raw);
        let data = serde_json::json!({
            "lyric":encode("[00:01]AB"),
            "qrc":"[1000,1000]A(1000,500)B(1500,500)",
            "trans":encode("[00:01]Translation")
        });
        let result = qqmusic_result(&data);
        assert_eq!(result.cues[0].words.len(), 2);
        assert_eq!(result.cues[0].translation.as_deref(), Some("Translation"));
    }

    #[test]
    fn word_preference_stops_after_two_extra_sources_and_keeps_first_lines() {
        let line = || LyricsResult::from_raw("[00:01]line", "first");
        let mut chain = Chain::default();
        assert!(chain.consider("first", Ok(line())).is_none());
        assert!(chain
            .consider("second", Ok(LyricsResult::empty("second")))
            .is_none());
        let result = chain
            .consider("third", Err(ProviderError::Timeout))
            .unwrap();
        assert_eq!(result.source, "first");
        assert_eq!(result.errors, ["third: Timeout"]);

        let mut chain = Chain::default();
        assert!(chain.consider("first", Ok(line())).is_none());
        let mut rich = LyricsResult::from_raw("[00:01]AB", "rich");
        rich.cues = parse_yrc("[1000,1000](1000,500,0)A(1500,500,0)B");
        assert_eq!(chain.consider("rich", Ok(rich)).unwrap().source, "rich");
    }

    #[tokio::test]
    #[ignore = "requires live lyric providers"]
    async fn live_manual_candidates_and_rich_netease_probe() {
        let client = super::client().unwrap();
        for query in ["丽都假日 HOYO-MiX", "Lemon 米津玄師"] {
            let candidates = search_candidates(&client, query, "netease").await.unwrap();
            assert!(!candidates.is_empty());
            let candidate = &candidates[0];
            let rich_response = request_json(
                &client,
                "https://music.163.com/api/song/lyric/v1",
                &[
                    ("id", candidate.id.clone()),
                    ("cp", "false".into()),
                    ("tv", "0".into()),
                    ("lv", "0".into()),
                    ("rv", "0".into()),
                    ("kv", "0".into()),
                    ("yv", "0".into()),
                    ("ytv", "0".into()),
                    ("yrv", "0".into()),
                ],
                Some("https://music.163.com/"),
                true,
            )
            .await
            .unwrap();
            println!(
                "v1 code={} lrc_bytes={} yrc_bytes={} tlyric_bytes={} ytlrc_bytes={}",
                rich_response
                    .get("code")
                    .and_then(Value::as_i64)
                    .unwrap_or(0),
                rich_response
                    .pointer("/lrc/lyric")
                    .and_then(Value::as_str)
                    .map_or(0, str::len),
                rich_response
                    .pointer("/yrc/lyric")
                    .and_then(Value::as_str)
                    .map_or(0, str::len),
                rich_response
                    .pointer("/tlyric/lyric")
                    .and_then(Value::as_str)
                    .map_or(0, str::len),
                rich_response
                    .pointer("/ytlrc/lyric")
                    .and_then(Value::as_str)
                    .map_or(0, str::len)
            );
            let result = fetch_candidate(&client, candidate).await.unwrap();
            println!(
                "netease id={} candidates={} cues={} words={} translations={}",
                candidate.id,
                candidates.len(),
                result.cues.len(),
                result.cues.iter().map(|cue| cue.words.len()).sum::<usize>(),
                result
                    .cues
                    .iter()
                    .filter(|cue| cue.translation.is_some())
                    .count()
            );
            assert!(!result.is_empty());
        }
    }
}
