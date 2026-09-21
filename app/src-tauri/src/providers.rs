//! Bounded public lyric lookups; no credentials and no audio downloads.
//!
//! Schemas carried over from the Python implementation, which verified them against
//! https://lrclib.net/docs and open-source client implementations. NetEase and QQ
//! Music are unofficial public endpoints and can change or block access at any time,
//! so a failing provider must never break the chain.

use std::time::Duration;

use serde_json::Value;

use crate::lrc::{parse_lrc, strip_tags, unescape, Cue};
use crate::matching::{matches, normalize};

const USER_AGENT: &str = "SpotifyOriginalLyrics/3.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_RESPONSE_BYTES: usize = 2_000_000;

#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct LyricsResult {
    pub text: String,
    pub source: String,
    pub cues: Vec<Cue>,
    pub errors: Vec<String>,
}

impl LyricsResult {
    pub fn empty(source: &str) -> Self {
        Self {
            text: String::new(),
            source: source.to_string(),
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
            cues,
            errors: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty() && self.cues.is_empty()
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
}

#[derive(Debug, thiserror::Error)]
pub enum ProviderError {
    #[error("Http")]
    Http,
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
    let body = response.bytes().await?;
    if body.len() > MAX_RESPONSE_BYTES {
        return Err(ProviderError::TooLarge);
    }
    if !status.is_success() {
        return Err(ProviderError::Http);
    }
    // utf-8-sig: these endpoints occasionally prefix a BOM.
    let text = String::from_utf8_lossy(&body);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|_| ProviderError::BadJson)
}

fn str_field(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or("").to_string()
}

fn names(value: &Value, key: &str) -> Vec<String> {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|list| list.iter().map(|entry| str_field(entry, "name")).collect())
        .unwrap_or_default()
}

// ---------------------------------------------------------------- LRCLIB

pub async fn lrclib(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    let params = [
        ("track_name", query.track.clone()),
        ("artist_name", query.primary_artist().to_string()),
        ("album_name", query.album.clone()),
        ("duration", ((query.duration_ms as f64 / 1000.0).round() as i64).to_string()),
    ];

    let response = client
        .get("https://lrclib.net/api/get")
        .query(&params)
        .header("Accept", "application/json")
        .send()
        .await?;
    // 404 simply means LRCLIB has no entry for this recording.
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(LyricsResult::empty("LRCLIB"));
    }
    if !response.status().is_success() {
        return Err(ProviderError::Http);
    }
    let data: Value = response.json().await?;

    // The exact endpoint already matched album and duration; still verify identity.
    let candidate_ms = data
        .get("duration")
        .and_then(Value::as_f64)
        .map(|seconds| (seconds * 1000.0) as i64);
    if !matches(
        &query.track,
        &query.artists,
        query.duration_ms,
        &str_field(&data, "trackName"),
        &[str_field(&data, "artistName")],
        candidate_ms,
    ) {
        return Ok(LyricsResult::empty("LRCLIB"));
    }

    let synced = str_field(&data, "syncedLyrics");
    let result = LyricsResult::from_raw(&synced, "LRCLIB");
    if !result.cues.is_empty() {
        return Ok(result);
    }
    let plain = str_field(&data, "plainLyrics");
    Ok(LyricsResult::from_raw(
        if plain.is_empty() { &synced } else { &plain },
        "LRCLIB",
    ))
}

// --------------------------------------------------------------- NetEase

pub async fn netease(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    let search = request_json(
        client,
        "https://music.163.com/api/search/get/",
        &[
            ("s", query.search_phrase()),
            ("limit", "8".to_string()),
            ("type", "1".to_string()),
            ("offset", "0".to_string()),
        ],
        Some("https://music.163.com/"),
        true,
    )
    .await?;

    if search.get("code").and_then(Value::as_i64) != Some(200) {
        return Err(ProviderError::Rejected);
    }

    let mut songs: Vec<&Value> = search
        .get("result")
        .and_then(|result| result.get("songs"))
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default();
    // Same-album candidates first; a compilation re-issue often has a worse timeline.
    let wanted_album = normalize(&query.album);
    songs.sort_by_key(|song| {
        normalize(&str_field(song.get("album").unwrap_or(&Value::Null), "name")) != wanted_album
    });

    for song in songs {
        if !matches(
            &query.track,
            &query.artists,
            query.duration_ms,
            &str_field(song, "name"),
            &names(song, "artists"),
            song.get("duration").and_then(Value::as_i64),
        ) {
            continue;
        }
        let Some(id) = song.get("id").and_then(Value::as_i64) else {
            continue;
        };
        let lyric = request_json(
            client,
            "https://music.163.com/api/song/lyric",
            &[
                ("id", id.to_string()),
                ("lv", "-1".to_string()),
                ("tv", "-1".to_string()),
            ],
            Some("https://music.163.com/"),
            false,
        )
        .await?;
        if lyric.get("code").and_then(Value::as_i64) != Some(200) {
            return Err(ProviderError::Rejected);
        }
        let raw = str_field(lyric.get("lrc").unwrap_or(&Value::Null), "lyric");
        return Ok(LyricsResult::from_raw(&raw, "NetEase"));
    }

    Ok(LyricsResult::empty("NetEase"))
}

// -------------------------------------------------------------- QQ Music

pub async fn qqmusic(client: &reqwest::Client, query: &TrackQuery) -> ProviderResult {
    // new_json=1 currently empties this endpoint; the legacy schema is the verified one.
    let search = request_json(
        client,
        "https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
        &[
            ("w", query.search_phrase()),
            ("n", "8".to_string()),
            ("p", "1".to_string()),
            ("format", "json".to_string()),
            ("cr", "1".to_string()),
        ],
        Some("https://y.qq.com/"),
        false,
    )
    .await?;

    if search.get("code").and_then(Value::as_i64) != Some(0) {
        return Err(ProviderError::Rejected);
    }

    let mut songs: Vec<&Value> = search
        .get("data")
        .and_then(|data| data.get("song"))
        .and_then(|song| song.get("list"))
        .and_then(Value::as_array)
        .map(|list| list.iter().collect())
        .unwrap_or_default();
    let wanted_album = normalize(&query.album);
    songs.sort_by_key(|song| normalize(&str_field(song, "albumname")) != wanted_album);

    for song in songs {
        let candidate_ms = song
            .get("interval")
            .and_then(Value::as_f64)
            .map(|seconds| (seconds * 1000.0) as i64);
        if !matches(
            &query.track,
            &query.artists,
            query.duration_ms,
            &str_field(song, "songname"),
            &names(song, "singer"),
            candidate_ms,
        ) {
            continue;
        }
        let songmid = str_field(song, "songmid");
        if songmid.is_empty() {
            continue;
        }
        let lyric = request_json(
            client,
            "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
            &[
                ("songmid", songmid),
                ("g_tk", "5381".to_string()),
                ("format", "json".to_string()),
                ("platform", "yqq".to_string()),
            ],
            Some("https://y.qq.com/portal/player.html"),
            false,
        )
        .await?;
        if lyric.get("code").and_then(Value::as_i64) != Some(0) {
            return Err(ProviderError::Rejected);
        }
        let encoded = str_field(&lyric, "lyric");
        let decoded = base64_decode(&encoded).ok_or(ProviderError::BadPayload)?;
        let raw = String::from_utf8(decoded).map_err(|_| ProviderError::BadPayload)?;
        return Ok(LyricsResult::from_raw(&raw, "QQ Music"));
    }

    Ok(LyricsResult::empty("QQ Music"))
}

fn base64_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

/// Ordered lookup across every provider.
///
/// The first synchronized result wins. Plain text from an earlier provider is
/// kept only as a fallback, so a source with words but no timeline never stops
/// a later source from supplying the timeline. A provider that errors is noted
/// and skipped: none of them is allowed to break the chain.
///
/// Order: LRCLIB is open and fastest. The Japanese-market sources come next
/// because this player is used on a Japan-region account, PetitLyrics ahead of
/// Musixmatch because live probing on 2026-09-21 showed PetitLyrics answering
/// reliably while Musixmatch was rate-limited. The Chinese sources stay last as
/// the original backstop.
pub async fn fetch_lyrics(
    client: &reqwest::Client,
    musixmatch_session: &crate::musixmatch::Session,
    query: &TrackQuery,
) -> LyricsResult {
    let mut chain = Chain::default();

    if let Some(result) = chain.consider("LRCLIB", lrclib(client, query).await) {
        return result;
    }
    if let Some(result) = chain.consider(
        "PetitLyrics",
        crate::petitlyrics::fetch(client, query).await,
    ) {
        return result;
    }
    if let Some(result) = chain.consider(
        "Musixmatch",
        crate::musixmatch::fetch(client, musixmatch_session, query).await,
    ) {
        return result;
    }
    if let Some(result) = chain.consider("NetEase", netease(client, query).await) {
        return result;
    }
    if let Some(result) = chain.consider("QQ Music", qqmusic(client, query).await) {
        return result;
    }

    chain.finish()
}

#[derive(Default)]
struct Chain {
    fallback: Option<LyricsResult>,
    errors: Vec<String>,
}

impl Chain {
    /// Returns the result to stop on, or `None` to keep going.
    fn consider(&mut self, name: &str, outcome: ProviderResult) -> Option<LyricsResult> {
        match outcome {
            Ok(mut result) => {
                if !result.cues.is_empty() {
                    result.errors = std::mem::take(&mut self.errors);
                    return Some(result);
                }
                if !result.text.is_empty() && self.fallback.is_none() {
                    self.fallback = Some(result);
                }
                None
            }
            Err(error) => {
                // Only the kind of failure is recorded: responses and URLs can
                // carry lyrics and metadata and must not reach the interface.
                self.errors.push(format!("{name}: {error}"));
                None
            }
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

        let chained = super::fetch_lyrics(&client, &musixmatch, &query).await;
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
}
