//! PetitLyrics (プチリリ) — the lyrics platform most Japanese third-party players use.
//!
//! Schema cross-checked against several independent open-source clients
//! (MusicBee.PetitLyrics, EeveeSpotifyReincarnated, canticle, prismriver-lyrics).
//! This is an unofficial public endpoint: it can change or block access, so every
//! failure here has to stay recoverable by the next provider in the chain.
//!
//! `lyricsType` selects one of three unrelated payload shapes:
//!   1 = plain UTF-8 text
//!   2 = an obfuscated binary blob that also needs a second type-1 request — skipped
//!   3 = XML with per-word millisecond timings — what we ask for first

use roxmltree::Document;
use serde_json::Value as JsonValue;

use crate::lrc::Cue;
use crate::matching::normalize;
use crate::providers::{LyricsResult, ProviderError, TrackQuery};

const ENDPOINT: &str = "https://p1.petitlyrics.com/api/GetPetitLyricsData.php";
const CLIENT_APP_ID: &str = "p1110417";
const TERMINAL_TYPE: &str = "10";
const SOURCE: &str = "PetitLyrics";

pub async fn fetch(client: &reqwest::Client, query: &TrackQuery) -> Result<LyricsResult, ProviderError> {
    // Word-synced first; it is the only tier that carries a usable timeline.
    if let Some(song) = request(client, query, "3").await? {
        if let Some(cues) = parse_word_synced(&song.payload) {
            if cues.iter().any(|cue| !cue.text.is_empty()) {
                let text = cues
                    .iter()
                    .map(|cue| cue.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                return Ok(LyricsResult {
                    text,
                    source: SOURCE.to_string(),
                    cues,
                    errors: Vec::new(),
                });
            }
        }
    }

    // Plain text is still better than nothing, and another provider may yet
    // supply a timeline for the same song.
    if let Some(song) = request(client, query, "1").await? {
        let text = song.payload.trim();
        if !text.is_empty() {
            return Ok(LyricsResult::from_raw(text, SOURCE));
        }
    }

    Ok(LyricsResult::empty(SOURCE))
}

struct Song {
    /// The decoded `lyricsData` payload: XML for type 3, plain text for type 1.
    payload: String,
}

async fn request(
    client: &reqwest::Client,
    query: &TrackQuery,
    lyrics_type: &str,
) -> Result<Option<Song>, ProviderError> {
    let form = [
        ("clientAppId", CLIENT_APP_ID),
        ("terminalType", TERMINAL_TYPE),
        ("lyricsType", lyrics_type),
        ("key_title", query.track.as_str()),
        ("key_artist", query.artists.first().map(String::as_str).unwrap_or("")),
        ("key_album", query.album.as_str()),
    ];

    let response = client.post(ENDPOINT).form(&form).send().await?;
    if !response.status().is_success() {
        return Err(ProviderError::Http);
    }
    let body = response.text().await?;

    let document = Document::parse(&body).map_err(|_| ProviderError::BadPayload)?;
    let Some(song) = document
        .descendants()
        .find(|node| node.has_tag_name("song"))
    else {
        return Ok(None);
    };

    let child_text = |name: &str| {
        song.children()
            .find(|node| node.has_tag_name(name))
            .and_then(|node| node.text())
            .unwrap_or("")
            .to_string()
    };

    // The endpoint matched on title/artist/album, but it answers fuzzily, so
    // confirm the title it actually returned. PetitLyrics exposes no reliable
    // duration or Spotify id, so the title is the strictest key available here.
    let returned_title = child_text("title");
    if !returned_title.is_empty() && normalize(&returned_title) != normalize(&query.track) {
        return Ok(None);
    }

    let encoded: String = child_text("lyricsData")
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    if encoded.is_empty() {
        return Ok(None);
    }
    let decoded = base64_decode(&encoded).ok_or(ProviderError::BadPayload)?;
    let payload = String::from_utf8(decoded).map_err(|_| ProviderError::BadPayload)?;
    Ok(Some(Song { payload }))
}

/// Fold the per-word timings of a `<wsy>` document into one cue per line.
pub fn parse_word_synced(xml: &str) -> Option<Vec<Cue>> {
    let document = Document::parse(xml).ok()?;
    let mut cues: Vec<Cue> = Vec::new();

    for line in document.descendants().filter(|node| node.has_tag_name("line")) {
        let words: Vec<_> = line
            .children()
            .filter(|node| node.has_tag_name("word"))
            .collect();

        // A line starts when its first word starts.
        let start = words.iter().find_map(|word| {
            word.children()
                .find(|node| node.has_tag_name("starttime"))
                .and_then(|node| node.text())
                .and_then(|text| text.trim().parse::<i64>().ok())
        });
        let Some(start) = start else { continue };

        let text = line
            .children()
            .find(|node| node.has_tag_name("linestring"))
            .and_then(|node| node.text())
            .map(str::to_string)
            .unwrap_or_else(|| {
                // Older payloads omit <linestring>; rebuild the line from its words.
                words
                    .iter()
                    .filter_map(|word| {
                        word.children()
                            .find(|node| node.has_tag_name("wordstring"))
                            .and_then(|node| node.text())
                    })
                    .collect::<String>()
            });

        cues.push(Cue {
            time_ms: start.max(0),
            text: text.trim().to_string(),
        });
    }

    if cues.is_empty() {
        return None;
    }
    cues.sort_by_key(|cue| cue.time_ms);
    Some(cues)
}

/// The `mxm` subtitle format Musixmatch returns is a JSON string of cue objects;
/// it lives here because both Japanese providers hand back nested payloads.
pub fn parse_mxm_subtitle(body: &str) -> Option<Vec<Cue>> {
    let parsed: JsonValue = serde_json::from_str(body).ok()?;
    let entries = parsed.as_array()?;
    let mut cues: Vec<Cue> = Vec::new();
    for entry in entries {
        let seconds = entry
            .get("time")
            .and_then(|time| time.get("total"))
            .and_then(JsonValue::as_f64)?;
        let text = entry
            .get("text")
            .and_then(JsonValue::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        cues.push(Cue {
            time_ms: (seconds * 1000.0).round() as i64,
            text,
        });
    }
    if cues.is_empty() {
        return None;
    }
    cues.sort_by_key(|cue| cue.time_ms);
    Some(cues)
}

fn base64_decode(value: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_timings_collapse_to_one_cue_per_line() {
        let xml = "<wsy><line><linestring>LINE_A</linestring>\
                   <word><starttime>0</starttime><endtime>450</endtime><wordstring>W1</wordstring></word>\
                   <word><starttime>450</starttime><endtime>900</endtime><wordstring>W2</wordstring></word></line>\
                   <line><linestring>LINE_B</linestring>\
                   <word><starttime>1200</starttime><endtime>1800</endtime><wordstring>W3</wordstring></word></line></wsy>";
        let cues = parse_word_synced(xml).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0], Cue { time_ms: 0, text: "LINE_A".into() });
        assert_eq!(cues[1], Cue { time_ms: 1200, text: "LINE_B".into() });
    }

    #[test]
    fn missing_linestring_falls_back_to_joined_words() {
        let xml = "<wsy><line>\
                   <word><starttime>500</starttime><wordstring>W1</wordstring></word>\
                   <word><starttime>900</starttime><wordstring>W2</wordstring></word></line></wsy>";
        let cues = parse_word_synced(xml).unwrap();
        assert_eq!(cues[0], Cue { time_ms: 500, text: "W1W2".into() });
    }

    #[test]
    fn lines_without_timings_are_dropped_and_payloads_without_lines_fail() {
        assert!(parse_word_synced("<wsy><line><linestring>LINE_A</linestring></line></wsy>").is_none());
        assert!(parse_word_synced("not xml at all").is_none());
    }

    #[test]
    fn mxm_subtitle_cues_convert_seconds_to_milliseconds() {
        let body = r#"[{"text":"LINE_A","time":{"total":12.34}},{"text":"LINE_B","time":{"total":0.5}}]"#;
        let cues = parse_mxm_subtitle(body).unwrap();
        assert_eq!(cues[0], Cue { time_ms: 500, text: "LINE_B".into() });
        assert_eq!(cues[1], Cue { time_ms: 12_340, text: "LINE_A".into() });
    }

    #[test]
    fn mxm_subtitle_rejects_non_cue_payloads() {
        assert!(parse_mxm_subtitle("").is_none());
        assert!(parse_mxm_subtitle("[]").is_none());
        assert!(parse_mxm_subtitle(r#"{"not":"an array"}"#).is_none());
    }
}
