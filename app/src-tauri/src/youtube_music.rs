//! Anonymous metadata and lyrics only; no player, cookies or audio requests.
//! Protocol references: Folia 851af3478/electron/ytm/{ytmApiBridge,catalog}.cjs;
//! YouTube.js v18.1.0/src/utils/Constants.ts and MusicDescriptionShelf.ts;
//! ytmusicapi/parsers/search.py (song search filter). These unofficial APIs can fail.

use std::time::Duration;

use serde_json::{json, Value};

use crate::lrc::Cue;
use crate::providers::{
    validate_candidate, LyricCandidate, LyricsResult, ProviderError, TrackQuery,
};

const SOURCE: &str = "YouTube Music";
const MAX_BYTES: usize = 2_000_000;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);

pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

fn context(mobile: bool) -> Value {
    if mobile {
        json!({"client": {"clientName": "ANDROID_MUSIC", "clientVersion": "7.21.50", "hl": "en"}})
    } else {
        json!({"client": {"clientName": "WEB_REMIX", "clientVersion": "1.20250219.01.00", "hl": "en"}})
    }
}

async fn request(
    client: &reqwest::Client,
    endpoint: &str,
    mut body: Value,
    mobile: bool,
) -> Result<Value, ProviderError> {
    body["context"] = context(mobile);
    let mut response = client
        .post(format!(
            "https://music.youtube.com/youtubei/v1/{endpoint}?prettyPrint=false"
        ))
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .timeout(REQUEST_TIMEOUT)
        .json(&body)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ProviderError::Http);
    }
    if response
        .content_length()
        .is_some_and(|n| n > MAX_BYTES as u64)
    {
        return Err(ProviderError::TooLarge);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_BYTES {
            return Err(ProviderError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| ProviderError::BadJson)
}

pub async fn search(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<LyricCandidate>, ProviderError> {
    search_filtered(client, query, "EgWKAQIIAWoMEA4QChADEAQQCRAF").await
}

/// Music videos can carry translated titles absent from the song catalog.
pub async fn search_videos(
    client: &reqwest::Client,
    query: &str,
) -> Result<Vec<LyricCandidate>, ProviderError> {
    // ytmusicapi/parsers/search.py:get_search_params + _get_param2 (videos = IQ).
    // Verified anonymously on 2026-10-19: official video rows include artist + duration.
    search_filtered(client, query, "EgWKAQIQAWoMEA4QChADEAQQCRAF").await
}

async fn search_filtered(
    client: &reqwest::Client,
    query: &str,
    filter: &str,
) -> Result<Vec<LyricCandidate>, ProviderError> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err(ProviderError::BadPayload);
    }
    let page = request(
        client,
        "search",
        json!({
            "query": query, "params": filter
        }),
        false,
    )
    .await?;
    Ok(search_results(&page))
}

/// Accept a bilingual title only with the same artist and known recording length.
pub fn matches_track(query: &TrackQuery, candidate: &LyricCandidate) -> bool {
    let matches = |title: &str| {
        crate::matching::matches(
            &query.track,
            &query.artists,
            query.duration_ms,
            title,
            &candidate.artists,
            Some(candidate.duration_ms),
        )
    };
    if matches(&candidate.title) {
        return true;
    }
    if candidate.source != "youtube_music" {
        return false;
    }
    bilingual_title(&candidate.title).is_some_and(|(_, translation)| matches(translation))
}

fn bilingual_title(title: &str) -> Option<(&str, &str)> {
    let (left, right) = title.split_once(" - ")?;
    if right.contains(" - ") {
        return None;
    }
    let (original, translation) = if cjk_title(left) && latin_title(right) {
        (left, right)
    } else if cjk_title(right) && latin_title(left) {
        (right, left)
    } else {
        return None;
    };
    // ponytail: only explicit two-language titles; unsupported layouts remain manual choices.
    // Never discard a version annotation on either side while selecting an alias.
    if annotated(original) || annotated(translation) {
        return None;
    }
    Some((original, translation))
}

/// The title a catalog song would carry: the original half of a bilingual video
/// title, otherwise the title itself.
fn catalog_title(title: &str) -> &str {
    bilingual_title(title).map_or(title, |(original, _)| original)
}

/// A video's lyrics can be plain while its native catalog recording has timing.
/// Bridge localized names only through the same native artist id, exact original
/// title and known durations; this fetches the catalog entry's own lyric timeline.
pub async fn localized_song_lyrics(
    client: &reqwest::Client,
    query: &TrackQuery,
    video: &LyricCandidate,
) -> Result<LyricsResult, ProviderError> {
    validate_candidate(video)?;
    if video.source != "youtube_music" || !matches_track(query, video) {
        return Err(ProviderError::Rejected);
    }
    let original = catalog_title(&video.title);
    // The caller shares its original provider deadline across video + song requests.
    let watch = request(client, "next", json!({"videoId": video.id}), false).await?;
    let songs = request(
        client,
        "search",
        json!({
            "query": original, "params": "EgWKAQIIAWoMEA4QChADEAQQCRAF"
        }),
        false,
    )
    .await?;
    let Some(song) = localized_song(query, video, &watch, &songs) else {
        return Ok(LyricsResult::empty(SOURCE));
    };
    let result = lyrics(client, &song).await?;
    Ok(if result.cues.is_empty() {
        LyricsResult::empty(SOURCE)
    } else {
        result
    })
}

fn artist_ids(value: &Value) -> Vec<&str> {
    let mut endpoints = Vec::new();
    renderers(value, "browseEndpoint", &mut endpoints);
    endpoints.into_iter().filter_map(|endpoint| {
        let kind = endpoint.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")?.as_str()?;
        let id = endpoint.get("browseId")?.as_str()?;
        (kind == "MUSIC_PAGE_TYPE_ARTIST" && id.starts_with("UC") && id.len() <= 128).then_some(id)
    }).collect()
}

fn near_duration(left: i64, right: i64) -> bool {
    left > 0 && right > 0 && (left - right).abs() <= 4000
}

fn localized_song(
    query: &TrackQuery,
    video: &LyricCandidate,
    watch: &Value,
    search: &Value,
) -> Option<LyricCandidate> {
    let original = catalog_title(&video.title);
    let mut rows = Vec::new();
    renderers(watch, "playlistPanelVideoRenderer", &mut rows);
    let selected = rows
        .into_iter()
        .find(|row| row["selected"] == true && row["videoId"] == video.id)?;
    let length = duration_ms(&text(&selected["lengthText"]))?;
    if crate::matching::normalize(&text(&selected["title"]))
        != crate::matching::normalize(&video.title)
        || !near_duration(length, query.duration_ms)
        || !near_duration(length, video.duration_ms)
    {
        return None;
    }
    let artists = artist_ids(&selected["longBylineText"]);
    if artists.is_empty() {
        return None;
    }
    let mut rows = Vec::new();
    renderers(search, "musicResponsiveListItemRenderer", &mut rows);
    for row in rows {
        // Only artist endpoints in metadata columns establish identity, not menus/recommendations.
        let song_artists = artist_ids(&row["flexColumns"]);
        if !artists.iter().any(|id| song_artists.contains(id)) {
            continue;
        }
        let wrapped = json!({"musicResponsiveListItemRenderer": row});
        let Some(song) = search_results(&wrapped).into_iter().next() else {
            continue;
        };
        if song.id != video.id
            && crate::matching::normalize(&song.title) == crate::matching::normalize(original)
            && near_duration(song.duration_ms, query.duration_ms)
            && near_duration(song.duration_ms, length)
        {
            return Some(song);
        }
    }
    None
}

fn cjk_title(text: &str) -> bool {
    text.chars().any(is_cjk)
        && text
            .chars()
            .all(|c| c.is_whitespace() || (is_cjk(c) && c.is_alphabetic()))
}

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{3040}'..='\u{30ff}' | '\u{3400}'..='\u{9fff}'
        | '\u{ff66}'..='\u{ff9f}' | '\u{20000}'..='\u{2fa1f}')
}

fn latin_title(text: &str) -> bool {
    text.chars().any(|c| c.is_ascii_alphabetic())
        && text.chars().all(|c| {
            !c.is_alphabetic() || c.is_ascii_alphabetic() || ('\u{00c0}'..='\u{024f}').contains(&c)
        })
}

fn annotated(text: &str) -> bool {
    if text.contains([
        '(', ')', '[', ']', '{', '}', '（', '）', '【', '】', '［', '］', '「', '」', '『', '』',
    ]) {
        return true;
    }
    let folded = crate::matching::normalize(text);
    [
        "live",
        "remix",
        "cover",
        "instrumental",
        "karaoke",
        "acoustic",
        "version",
        "remaster",
        "edit",
        "demo",
        "ライブ",
        "ライヴ",
        "カバー",
        "リミックス",
        "インスト",
        "カラオケ",
        "ピアノ",
        "オフボーカル",
        "弾き語り",
        "伴奏",
        "演唱会",
        "现场",
        "翻唱",
        "纯音乐",
        "版",
    ]
    .iter()
    .any(|marker| folded.contains(marker))
}

/// Unknown/missing lyrics are empty, and request errors remain ordinary provider errors.
pub async fn lyrics(
    client: &reqwest::Client,
    candidate: &LyricCandidate,
) -> Result<LyricsResult, ProviderError> {
    validate_candidate(candidate)?;
    if candidate.source != "youtube_music" || !valid_video_id(&candidate.id) {
        return Err(ProviderError::BadPayload);
    }
    // Bound the whole lookup, including the optional plain-text web response.
    tokio::time::timeout(Duration::from_secs(12), async {
        let page = request(client, "next", json!({"videoId": candidate.id}), false).await?;
        let Some(id) = lyrics_browse_id(&page) else {
            return Ok(LyricsResult::empty(SOURCE));
        };
        let mobile = request(client, "browse", json!({"browseId": id}), true).await;
        let result = with_web_fallback(
            mobile,
            request(client, "browse", json!({"browseId": id}), false),
        )
        .await?;
        Ok(result.with_title(&candidate.title))
    })
    .await
    .map_err(|_| ProviderError::Timeout)?
}

async fn with_web_fallback(
    mobile: Result<Value, ProviderError>,
    web: impl std::future::Future<Output = Result<Value, ProviderError>>,
) -> Result<LyricsResult, ProviderError> {
    if let Ok(page) = &mobile {
        let result = parse_lyrics(page);
        if !result.is_empty() {
            return Ok(result);
        }
    }
    let result = parse_lyrics(&web.await?);
    if result.is_empty() {
        // An empty web page does not erase a failure of the timed-lyrics request.
        mobile?;
    }
    Ok(result)
}

fn text(value: &Value) -> String {
    if let Some(simple) = value.get("simpleText").and_then(Value::as_str) {
        return simple.to_string();
    }
    value
        .get("runs")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|run| run.get("text").and_then(Value::as_str))
        .collect()
}

// Search result layouts can add wrappers; inspect only the named renderer, not arbitrary text.
fn renderers<'a>(value: &'a Value, key: &str, found: &mut Vec<&'a Value>) {
    match value {
        Value::Object(object) => {
            if let Some(renderer) = object.get(key) {
                found.push(renderer);
            } else {
                for child in object.values() {
                    renderers(child, key, found);
                }
            }
        }
        Value::Array(array) => {
            for child in array {
                renderers(child, key, found);
            }
        }
        _ => {}
    }
}

fn duration_ms(value: &str) -> Option<i64> {
    let parts: Vec<_> = value.trim().split(':').collect();
    if !(2..=3).contains(&parts.len()) {
        return None;
    }
    let mut seconds = 0_i64;
    for (i, part) in parts.iter().enumerate() {
        if part.is_empty() || !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        let n = part.parse::<i64>().ok()?;
        if i > 0 && n >= 60 {
            return None;
        }
        seconds = seconds.checked_mul(60)?.checked_add(n)?;
    }
    seconds
        .checked_mul(1000)
        .filter(|n| *n > 0 && *n <= 86_400_000)
}

fn search_results(page: &Value) -> Vec<LyricCandidate> {
    let mut rows = Vec::new();
    renderers(page, "musicResponsiveListItemRenderer", &mut rows);
    let mut results: Vec<LyricCandidate> = Vec::new();
    for row in rows {
        let columns: Vec<_> = row
            .get("flexColumns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|column| column.pointer("/musicResponsiveListItemFlexColumnRenderer/text"))
            .collect();
        let Some(first) = columns.first() else {
            continue;
        };
        let title = text(first).trim().to_string();
        let id = row
            .pointer("/playlistItemData/videoId")
            .or_else(|| first.pointer("/runs/0/navigationEndpoint/watchEndpoint/videoId"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !valid_video_id(id) || results.iter().any(|item| item.id == id) {
            continue;
        }
        let mut artists = Vec::new();
        let mut album = String::new();
        let mut length = 0;
        for column in columns.iter().skip(1) {
            for run in column
                .get("runs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let label = run.get("text").and_then(Value::as_str).unwrap_or("").trim();
                let endpoint = &run["navigationEndpoint"]["browseEndpoint"];
                let page_type = endpoint.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")
                    .and_then(Value::as_str).unwrap_or("");
                let browse_id = endpoint
                    .get("browseId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if page_type == "MUSIC_PAGE_TYPE_ARTIST" || browse_id.starts_with("UC") {
                    if !label.is_empty() && !artists.iter().any(|artist| artist == label) {
                        artists.push(label.to_string());
                    }
                } else if page_type == "MUSIC_PAGE_TYPE_ALBUM" || browse_id.starts_with("MPRE") {
                    album = label.to_string();
                } else if let Some(ms) = duration_ms(label) {
                    length = ms;
                }
            }
        }
        for fixed in row
            .get("fixedColumns")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            if let Some(ms) = duration_ms(&text(
                &fixed["musicResponsiveListItemFixedColumnRenderer"]["text"],
            )) {
                length = ms;
            }
        }
        let candidate = LyricCandidate {
            source: "youtube_music".into(),
            id: id.into(),
            title,
            artists,
            album,
            duration_ms: length,
        };
        if validate_candidate(&candidate).is_ok() {
            results.push(candidate);
        }
        if results.len() == 20 {
            break;
        }
    }
    results
}

fn lyrics_browse_id(page: &Value) -> Option<&str> {
    let tabs = page.pointer("/contents/singleColumnMusicWatchNextResultsRenderer/tabbedRenderer/watchNextTabbedResultsRenderer/tabs")?.as_array()?;
    tabs.iter().filter_map(|tab| {
        let endpoint = tab.pointer("/tabRenderer/endpoint/browseEndpoint")?;
        let kind = endpoint.pointer("/browseEndpointContextSupportedConfigs/browseEndpointContextMusicConfig/pageType")?.as_str()?;
        let id = endpoint.get("browseId")?.as_str()?;
        (kind == "MUSIC_PAGE_TYPE_TRACK_LYRICS" && !id.is_empty() && id.len() <= 1024).then_some(id)
    }).next()
}

fn parse_lyrics(page: &Value) -> LyricsResult {
    let mut result = LyricsResult::empty(SOURCE);
    let timed = page.pointer("/contents/elementRenderer/newElement/type/componentType/model/timedLyricsModel/lyricsData/timedLyricsData");
    for line in timed.and_then(Value::as_array).into_iter().flatten() {
        let text = line
            .get("lyricLine")
            .and_then(Value::as_str)
            .unwrap_or("")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        let time = &line["cueRange"]["startTimeMilliseconds"];
        let time = time.as_i64().or_else(|| time.as_str()?.parse().ok());
        if let Some(time_ms) = time.filter(|ms| (0..=86_400_000).contains(ms)) {
            // Preserve instrumental breaks so the preceding line stops highlighting.
            let text = if text.chars().any(char::is_alphanumeric) {
                text
            } else {
                String::new()
            };
            result.cues.push(Cue {
                time_ms,
                text,
                words: Vec::new(),
                translation: None,
            });
        }
    }
    if result.cues.iter().any(|cue| !cue.text.is_empty()) {
        result.cues.sort_by_key(|cue| cue.time_ms);
        result.text = result
            .cues
            .iter()
            .map(|cue| cue.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        return result;
    }
    result.cues.clear();
    let mut shelves = Vec::new();
    renderers(
        page.get("contents").unwrap_or(&Value::Null),
        "musicDescriptionShelfRenderer",
        &mut shelves,
    );
    if let Some(shelf) = shelves.first() {
        // The footer is provider attribution, not a lyric line.
        result.text = text(&shelf["description"]).trim().to_string();
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn localized_song_requires_native_artist_and_recording_evidence() {
        let query = TrackQuery {
            track: "A Sunny Day".into(),
            artists: vec!["Singer".into()],
            album: String::new(),
            duration_ms: 199_000,
            spotify_id: None,
            video_ids: Vec::new(),
        };
        let video = LyricCandidate {
            source: "youtube_music".into(),
            id: "video123456".into(),
            title: "晴れの日 - A Sunny Day".into(),
            artists: query.artists.clone(),
            album: String::new(),
            duration_ms: 200_000,
        };
        let artist = json!({"text": "歌手", "navigationEndpoint": {"browseEndpoint": {
            "browseId": "UCsameNativeArtist",
            "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}
        }}});
        let watch = json!({"playlistPanelVideoRenderer": {"videoId": video.id, "selected": true,
            "title": {"simpleText": video.title}, "lengthText": {"simpleText": "3:20"},
            "longBylineText": {"runs": [artist.clone()]}}});
        let search = json!({"musicResponsiveListItemRenderer": {
            "playlistItemData": {"videoId": "song1234567"},
            "flexColumns": [
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"simpleText": "晴れの日"}}},
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [artist, {"text": "3:19"}]}}}
            ]
        }});
        assert_eq!(
            localized_song(&query, &video, &watch, &search).unwrap().id,
            "song1234567"
        );
        let mutations = [
            ("/musicResponsiveListItemRenderer/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs/0/navigationEndpoint/browseEndpoint/browseId", json!("UCcoverArtist")),
            ("/musicResponsiveListItemRenderer/flexColumns/0/musicResponsiveListItemFlexColumnRenderer/text/simpleText", json!("晴れの日 ライブ")),
            ("/musicResponsiveListItemRenderer/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs/1/text", json!("3:30")),
            ("/musicResponsiveListItemRenderer/flexColumns/1/musicResponsiveListItemFlexColumnRenderer/text/runs/1/text", json!("unknown")),
        ];
        for (path, value) in mutations {
            let mut changed = search.clone();
            *changed.pointer_mut(path).unwrap() = value;
            assert!(
                localized_song(&query, &video, &watch, &changed).is_none(),
                "accepted {path}"
            );
        }
        for (field, value) in [
            ("videoId", json!("related1234")),
            ("selected", json!(false)),
            ("title", json!({"simpleText": "別曲 - Other Song"})),
            ("lengthText", json!({"simpleText": "3:30"})),
        ] {
            let mut changed = watch.clone();
            changed["playlistPanelVideoRenderer"][field] = value;
            assert!(
                localized_song(&query, &video, &changed, &search).is_none(),
                "accepted {field}"
            );
        }
    }

    /// Measured 2026-10-20: ytmdesktop2 playing the official video FM7MFYoylVs
    /// gives no counterpart, and the video's own lyrics are plain; the catalog
    /// song owTWCbq_nSk, same title and artists, is timed.
    #[test]
    fn a_music_video_with_a_plain_title_finds_its_catalog_song_by_the_same_evidence() {
        let query = TrackQuery {
            track: "Something Just Like This".into(),
            artists: vec!["Duo".into()],
            album: String::new(),
            duration_ms: 248_000,
            spotify_id: None,
            video_ids: vec!["FM7MFYoylVs".into()],
        };
        let video = LyricCandidate {
            source: "youtube_music".into(),
            id: "FM7MFYoylVs".into(),
            title: query.track.clone(),
            artists: query.artists.clone(),
            album: String::new(),
            duration_ms: 248_000,
        };
        let artist = json!({"text": "Duo", "navigationEndpoint": {"browseEndpoint": {
            "browseId": "UCnativeDuoArtist",
            "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {"pageType": "MUSIC_PAGE_TYPE_ARTIST"}}
        }}});
        let watch = json!({"playlistPanelVideoRenderer": {"videoId": video.id, "selected": true,
            "title": {"simpleText": "Something Just Like This"}, "lengthText": {"simpleText": "4:08"},
            "longBylineText": {"runs": [artist.clone()]}}});
        let song = |id: &str, title: &str, length: &str| {
            json!({"musicResponsiveListItemRenderer": {
                "playlistItemData": {"videoId": id},
                "flexColumns": [
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"simpleText": title}}},
                    {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [artist.clone(), {"text": length}]}}}
                ]
            }})
        };
        let found = localized_song(
            &query,
            &video,
            &watch,
            &json!([
                song("FM7MFYoylVs", "Something Just Like This", "4:08"),
                song("owTWCbq_nSk", "Something Just Like This", "4:07")
            ]),
        );
        assert_eq!(
            found.unwrap().id,
            "owTWCbq_nSk",
            "the video itself is never its own song"
        );
        for (title, length) in [
            ("Something Just Like This (Live)", "4:07"),
            ("Something Just Like This", "4:30"),
        ] {
            assert!(
                localized_song(&query, &video, &watch, &song("owTWCbq_nSk", title, length))
                    .is_none(),
                "accepted {title} {length}"
            );
        }
    }

    #[test]
    fn bilingual_video_alias_preserves_recording_guards() {
        let query = TrackQuery {
            track: "Just a Sunny Day for You".into(),
            artists: vec!["YORUSHIKA".into()],
            album: String::new(),
            duration_ms: 199_000,
            spotify_id: None,
            video_ids: Vec::new(),
        };
        let mut candidate = LyricCandidate {
            source: "youtube_music".into(),
            id: "-VKIqrvVOpo".into(),
            title: "ただ君に晴れ - Just a Sunny Day for You".into(),
            artists: vec!["Yorushika".into()],
            album: String::new(),
            duration_ms: 200_000,
        };
        assert!(matches_track(&query, &candidate));
        assert_eq!(candidate.title, "ただ君に晴れ - Just a Sunny Day for You");
        candidate.artists = vec!["Cover Artist".into()];
        assert!(!matches_track(&query, &candidate));
        candidate.artists = vec!["Yorushika".into()];
        for length in [0, 210_000] {
            candidate.duration_ms = length;
            assert!(!matches_track(&query, &candidate));
        }
        candidate.duration_ms = 200_000;
        candidate.source = "lrclib".into();
        assert!(!matches_track(&query, &candidate));
        candidate.source = "youtube_music".into();
        for title in [
            "Just a Sunny Day for You - Live",
            "Just a Sunny Day for You - Remix",
            "Just a Sunny Day for You - Cover",
            "ただ君に晴れ - Just a Sunny Day for You - Live",
            "ただ君に晴れ (Live) - Just a Sunny Day for You",
            "ただ君に晴れ【ライブ】 - Just a Sunny Day for You",
            "ただ君に晴れ カラオケ - Just a Sunny Day for You",
            "ただ君に晴れ インスト - Just a Sunny Day for You",
            "ただ君に晴れ カバー - Just a Sunny Day for You",
            "ただ君に晴れ リミックス - Just a Sunny Day for You",
            "ただ君に晴れ 現場版 - Just a Sunny Day for You",
            "ただ君に晴れ - Just a Sunny Day for You (Live)",
            "ただ君に晴れ Off Vocal - Just a Sunny Day for You",
            "ただ君に晴れ Piano - Just a Sunny Day for You",
            "ただ君に晴れ ピアノ - Just a Sunny Day for You",
            "ただ君に晴れ オフボーカル - Just a Sunny Day for You",
            "ただ君に晴れ 2025 - Just a Sunny Day for You",
            "ただ君に晴れ ★ - Just a Sunny Day for You",
        ] {
            candidate.title = title.into();
            assert!(!matches_track(&query, &candidate), "accepted {title}");
        }
        let mut japanese_query = query.clone();
        japanese_query.track = "ただ君に晴れ".into();
        candidate.title = "ただ君に晴れ - Just a Sunny Day for You Piano".into();
        assert!(!matches_track(&japanese_query, &candidate));
        candidate.title = query.track.clone();
        candidate.source = "lrclib".into();
        assert!(matches_track(&query, &candidate));
    }

    #[test]
    fn metadata_does_not_invent_duration_or_artists() {
        let row = json!({"musicResponsiveListItemRenderer": {
            "playlistItemData": {"videoId": "abcdefgh_-1"},
            "flexColumns": [
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{"text": "Song"}]}}},
                {"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [
                    {"text": "Singer", "navigationEndpoint": {"browseEndpoint": {"browseId": "UCartist"}}},
                    {"text": " • "}, {"text": "Album", "navigationEndpoint": {"browseEndpoint": {"browseId": "MPREalbum"}}},
                    {"text": " • "}, {"text": "3:04"}
                ]}}}
            ]
        }});
        let parsed = search_results(&json!({"contents": [row.clone(), row.clone()]}));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].artists, ["Singer"]);
        assert_eq!(parsed[0].album, "Album");
        assert_eq!(parsed[0].duration_ms, 184_000);
        let mut unknown = row;
        unknown["musicResponsiveListItemRenderer"]["flexColumns"]
            .as_array_mut()
            .unwrap()
            .truncate(1);
        let parsed = search_results(&unknown);
        assert_eq!(parsed[0].duration_ms, 0);
        assert!(parsed[0].artists.is_empty());
        assert!(!valid_video_id("https://x"));
        assert!(!valid_video_id("abcdefgh/12"));
        assert_eq!(duration_ms("1:02:03"), Some(3_723_000));
        assert_eq!(duration_ms("3:99"), None);
    }

    #[test]
    fn timed_plain_missing_and_browse_id() {
        let timed = json!({"contents":{"elementRenderer":{"newElement":{"type":{"componentType":{"model":{"timedLyricsModel":{"lyricsData":{"timedLyricsData":[
            {"lyricLine":" Second  line ","cueRange":{"startTimeMilliseconds":"2400"}},
            {"lyricLine":"第一行","cueRange":{"startTimeMilliseconds":0}},
            {"lyricLine":"♪","cueRange":{"startTimeMilliseconds":1000}},
            {"lyricLine":"invalid","cueRange":{"startTimeMilliseconds":-1}}
        ]}}}}}}}}});
        let result = parse_lyrics(&timed);
        assert_eq!(result.cues.len(), 3);
        assert_eq!(result.cues[0].time_ms, 0);
        assert_eq!(result.cues[1].time_ms, 1000);
        assert!(result.cues[1].text.is_empty());
        assert_eq!(result.cues[2].time_ms, 2400);
        assert_eq!(result.text, "第一行\n\nSecond line");
        let mut blank = timed.clone();
        blank.pointer_mut("/contents/elementRenderer/newElement/type/componentType/model/timedLyricsModel/lyricsData/timedLyricsData")
            .unwrap().as_array_mut().unwrap().retain(|line| line["lyricLine"] == "♪");
        assert!(parse_lyrics(&blank).is_empty());
        let plain = json!({"contents":{"sectionListRenderer":{"contents":[{"musicDescriptionShelfRenderer":{
            "description":{"runs":[{"text":"Line A\n"},{"text":"Line B"}]}, "footer":{"runs":[{"text":"Attribution"}]}
        }}]}}});
        let result = parse_lyrics(&plain);
        assert!(result.cues.is_empty());
        assert_eq!(result.text, "Line A\nLine B");
        assert!(parse_lyrics(&json!({})).is_empty());
        let next = json!({"contents":{"singleColumnMusicWatchNextResultsRenderer":{"tabbedRenderer":{"watchNextTabbedResultsRenderer":{"tabs":[{"tabRenderer":{"endpoint":{"browseEndpoint":{
            "browseId":"MPLYexample", "browseEndpointContextSupportedConfigs":{"browseEndpointContextMusicConfig":{"pageType":"MUSIC_PAGE_TYPE_TRACK_LYRICS"}}
        }}}}]}}}}});
        assert_eq!(lyrics_browse_id(&next), Some("MPLYexample"));
        assert_eq!(lyrics_browse_id(&json!({})), None);
    }

    #[tokio::test]
    async fn mobile_failure_can_use_web_plain_lyrics() {
        let plain = json!({"contents": {"musicDescriptionShelfRenderer": {
            "description": {"simpleText": "Plain line"}
        }}});
        let result = with_web_fallback(Err(ProviderError::Http), async { Ok(plain.clone()) })
            .await
            .unwrap();
        assert_eq!(result.text, "Plain line");
        assert!(result.cues.is_empty());
        let result = with_web_fallback(Ok(plain), async { Err(ProviderError::Http) })
            .await
            .unwrap();
        assert_eq!(result.text, "Plain line");
        assert!(matches!(
            with_web_fallback(Err(ProviderError::Http), async { Ok(json!({})) }).await,
            Err(ProviderError::Http)
        ));
        assert!(with_web_fallback(Ok(json!({})), async { Ok(json!({})) })
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    #[ignore = "public native localized-song timing regression"]
    async fn live_localized_song_timing() {
        let client = crate::providers::client().unwrap();
        let query = TrackQuery {
            track: "Just a Sunny Day for You".into(),
            artists: vec!["YORUSHIKA".into()],
            album: String::new(),
            duration_ms: 199_000,
            spotify_id: None,
            video_ids: Vec::new(),
        };
        let videos = search_videos(&client, "Just a Sunny Day for You YORUSHIKA")
            .await
            .unwrap();
        let video = videos
            .iter()
            .find(|video| matches_track(&query, video))
            .unwrap();
        let result = localized_song_lyrics(&client, &query, video).await.unwrap();
        eprintln!(
            "localized native song video={} source={} title={} timed_cues={}",
            video.id,
            result.source,
            result.matched_title,
            result.cues.len()
        );
        assert!(!result.cues.is_empty());
    }

    #[tokio::test]
    #[ignore = "public native lyric timing diagnostic; prints metadata only"]
    async fn live_native_timing_diagnostic() {
        let client = crate::providers::client().unwrap();
        for id in ["-VKIqrvVOpo", "ZdzoLCLliW0"] {
            let next = request(&client, "next", json!({"videoId": id}), false)
                .await
                .unwrap();
            let browse_id = lyrics_browse_id(&next).unwrap();
            let page = request(&client, "browse", json!({"browseId": browse_id}), true)
                .await
                .unwrap();
            let rows = page.pointer("/contents/elementRenderer/newElement/type/componentType/model/timedLyricsModel/lyricsData/timedLyricsData")
                .and_then(Value::as_array).unwrap();
            let timestamps: Vec<i64> = rows
                .iter()
                .filter_map(|line| {
                    let time = line.pointer("/cueRange/startTimeMilliseconds")?;
                    time.as_i64().or_else(|| time.as_str()?.parse().ok())
                })
                .filter(|ms| (0..=86_400_000).contains(ms))
                .collect();
            let parsed = parse_lyrics(&page);
            eprintln!("native timing id={id} browse={browse_id} entries={} valid_timestamps={} parsed_cues={} first_timestamps={:?}",
                rows.len(), timestamps.len(), parsed.cues.len(), timestamps.iter().take(5).collect::<Vec<_>>());
            assert_eq!(parsed.cues.len(), timestamps.len());
            assert!(!rows.is_empty());
        }
    }

    #[tokio::test]
    #[ignore = "public YouTube Music network smoke test"]
    async fn live_search_and_lyrics() {
        let client = crate::providers::client().unwrap();
        let candidates = search(&client, "Rick Astley Never Gonna Give You Up")
            .await
            .unwrap();
        assert!(!candidates.is_empty());
        let result = lyrics(&client, &candidates[0]).await.unwrap();
        eprintln!(
            "YouTube Music: {} candidates; {} lyric lines; {} timed cues",
            candidates.len(),
            result.text.lines().count(),
            result.cues.len()
        );
        assert!(!result.is_empty());
    }
}
