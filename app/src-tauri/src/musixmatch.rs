//! Musixmatch (unofficial endpoint) — the supplier behind Spotify's own lyrics,
//! and the reason a Japan-region track usually has a timeline somewhere.
//!
//! Status as researched on 2026-09-21: the classic `apic-desktop.musixmatch.com`
//! identity has been retired upstream and now answers with a decoy all-zero token
//! and one fixed decoy payload, so it is deliberately not used. The live host is
//! `apic.musixmatch.com`, which is itself rate-limited per IP and can answer an
//! inner `401 captcha` inside an HTTP 200. Every failure mode here must therefore
//! be recoverable: the provider chain simply moves on.

use std::time::{Duration, Instant};

use serde_json::Value;
use tokio::sync::RwLock;

use crate::lrc::{parse_lrc, Cue};
use crate::matching::matches;
use crate::petitlyrics::parse_mxm_subtitle;
use crate::providers::{LyricsResult, ProviderError, TrackQuery};

const HOST: &str = "https://apic.musixmatch.com";
/// Tried in order; a refused identity is not a dead provider.
const APP_IDS: [&str; 2] = ["android-player-v1.0", "mac-ios-v2.0"];
/// Client-side policy, not a server-documented lifetime.
const TOKEN_TTL: Duration = Duration::from_secs(540);
/// Minting is rate-limited per IP, and a refused mint answers a captcha hint.
/// Retrying on every track change guarantees a permanent refusal, so back off.
const MINT_COOLDOWN: Duration = Duration::from_secs(600);
const SOURCE: &str = "Musixmatch";

/// Holds the anonymous user token between lookups so every track change does not
/// mint a new one — rapid minting is exactly what triggers the captcha gate.
#[derive(Default)]
pub struct Session {
    cached: RwLock<Option<(String, String, Instant)>>,
    /// When the last mint was refused, so we stop hammering a gated endpoint.
    refused_at: RwLock<Option<Instant>>,
}

impl Session {
    pub fn new() -> Self {
        Self::default()
    }

    async fn token(&self, client: &reqwest::Client) -> Result<(String, String), ProviderError> {
        if let Some((app_id, token, minted)) = self.cached.read().await.clone() {
            if minted.elapsed() < TOKEN_TTL {
                return Ok((app_id, token));
            }
        }
        if let Some(refused) = *self.refused_at.read().await {
            if refused.elapsed() < MINT_COOLDOWN {
                return Err(ProviderError::Rejected);
            }
        }

        let mut last_error = ProviderError::Rejected;
        for app_id in APP_IDS {
            match mint_token(client, app_id).await {
                Ok(token) => {
                    *self.cached.write().await =
                        Some((app_id.to_string(), token.clone(), Instant::now()));
                    *self.refused_at.write().await = None;
                    return Ok((app_id.to_string(), token));
                }
                Err(error) => last_error = error,
            }
        }
        *self.refused_at.write().await = Some(Instant::now());
        Err(last_error)
    }

    async fn forget(&self) {
        *self.cached.write().await = None;
    }
}

async fn mint_token(client: &reqwest::Client, app_id: &str) -> Result<String, ProviderError> {
    let response = client
        .get(format!("{HOST}/ws/1.1/token.get"))
        .query(&[("app_id", app_id), ("user_language", "en")])
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(ProviderError::Http);
    }
    let data: Value = response.json().await.map_err(|_| ProviderError::BadJson)?;

    // The transport can say 200 while the envelope says 401 — check the envelope.
    if inner_status(&data) != Some(200) {
        return Err(ProviderError::Rejected);
    }
    let token = data
        .get("message")
        .and_then(|message| message.get("body"))
        .and_then(|body| body.get("user_token"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    if is_degenerate(&token) {
        return Err(ProviderError::Rejected);
    }
    Ok(token)
}

fn inner_status(data: &Value) -> Option<i64> {
    data.get("message")
        .and_then(|message| message.get("header"))
        .and_then(|header| header.get("status_code"))
        .and_then(Value::as_i64)
}

/// Reject the sentinels this endpoint is known to hand out instead of a token:
/// an empty string, one character repeated (the all-zero decoy), and
/// `UpgradeRequired`.
fn is_degenerate(token: &str) -> bool {
    if token.is_empty() || token == "UpgradeRequired" {
        return true;
    }
    let mut characters = token.chars();
    match characters.next() {
        Some(first) => characters.all(|c| c == first),
        None => true,
    }
}

pub async fn fetch(
    client: &reqwest::Client,
    session: &Session,
    query: &TrackQuery,
) -> Result<LyricsResult, ProviderError> {
    let (app_id, token) = session.token(client).await?;
    let duration_seconds = (query.duration_ms as f64 / 1000.0).round() as i64;

    let mut params: Vec<(&str, String)> = vec![
        ("format", "json".into()),
        ("namespace", "lyrics_richsynched".into()),
        // `lrc` hands back ready LRC text; `mxm` cue JSON is handled too, because
        // sources disagree on which format this identity actually honours.
        ("subtitle_format", "lrc".into()),
        ("app_id", app_id),
        ("usertoken", token),
        ("q_track", query.track.clone()),
        ("q_artist", query.artists.first().cloned().unwrap_or_default()),
        ("q_artists", query.artists.first().cloned().unwrap_or_default()),
        ("q_album", query.album.clone()),
        ("q_duration", duration_seconds.to_string()),
        ("f_subtitle_length", duration_seconds.to_string()),
    ];
    // The Spotify id is the strongest matching key this endpoint accepts. The bare
    // 22-character id is what the open-source clients send; the URI form is untested.
    if let Some(spotify_id) = query.spotify_id.as_ref().filter(|id| !id.is_empty()) {
        params.push(("track_spotify_id", spotify_id.clone()));
    }

    let response = client
        .get(format!("{HOST}/ws/1.1/macro.subtitles.get"))
        .query(&params)
        .send()
        .await?;
    let status = response.status();
    if !status.is_success() {
        if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
            session.forget().await;
            return Err(ProviderError::Rejected);
        }
        return Err(ProviderError::Http);
    }
    let data: Value = response.json().await.map_err(|_| ProviderError::BadJson)?;

    match inner_status(&data) {
        Some(200) => {}
        Some(401) => {
            // The token went stale or got gated; drop it so the next track remints.
            session.forget().await;
            return Err(ProviderError::Rejected);
        }
        _ => return Err(ProviderError::Rejected),
    }

    let macro_calls = data
        .get("message")
        .and_then(|message| message.get("body"))
        .and_then(|body| body.get("macro_calls"))
        .cloned()
        .unwrap_or(Value::Null);

    if !identity_matches(&macro_calls, query) {
        return Ok(LyricsResult::empty(SOURCE));
    }

    if let Some(body) = subtitle_body(&macro_calls) {
        if let Some(cues) = subtitle_cues(&body) {
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

    if let Some(plain) = plain_body(&macro_calls) {
        if !plain.trim().is_empty() {
            return Ok(LyricsResult::from_raw(&plain, SOURCE));
        }
    }

    Ok(LyricsResult::empty(SOURCE))
}

/// The macro call fuzzy-matches; verify the recording it actually chose.
fn identity_matches(macro_calls: &Value, query: &TrackQuery) -> bool {
    let Some(track) = macro_calls
        .get("matcher.track.get")
        .and_then(|call| call.get("message"))
        .and_then(|message| message.get("body"))
        .and_then(|body| body.get("track"))
    else {
        // No identity block at all: fall back to trusting the query we sent.
        return true;
    };

    let candidate_ms = track
        .get("track_length")
        .and_then(Value::as_f64)
        .map(|seconds| (seconds * 1000.0) as i64);
    let artist = track
        .get("artist_name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    matches(
        &query.track,
        &query.artists,
        query.duration_ms,
        track.get("track_name").and_then(Value::as_str).unwrap_or(""),
        &[artist],
        candidate_ms,
    )
}

fn subtitle_body(macro_calls: &Value) -> Option<String> {
    macro_calls
        .get("track.subtitles.get")?
        .get("message")?
        .get("body")?
        .get("subtitle_list")?
        .as_array()?
        .first()?
        .get("subtitle")?
        .get("subtitle_body")?
        .as_str()
        .map(str::to_string)
}

fn plain_body(macro_calls: &Value) -> Option<String> {
    macro_calls
        .get("track.lyrics.get")?
        .get("message")?
        .get("body")?
        .get("lyrics")?
        .get("lyrics_body")?
        .as_str()
        .map(str::to_string)
}

/// Accept either shape this endpoint may return: LRC text, or the `mxm` cue JSON.
pub fn subtitle_cues(body: &str) -> Option<Vec<Cue>> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.starts_with('[') {
        if let Some(cues) = parse_mxm_subtitle(trimmed) {
            if cues.iter().any(|cue| !cue.text.is_empty()) {
                return Some(cues);
            }
        }
    }
    let cues = parse_lrc(trimmed);
    if cues.iter().any(|cue| !cue.text.is_empty()) {
        Some(cues)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoy_tokens_are_rejected() {
        assert!(is_degenerate(""));
        // The all-zero token the retired desktop identity now hands out.
        assert!(is_degenerate(&"0".repeat(56)));
        assert!(is_degenerate("UpgradeRequired"));
        assert!(!is_degenerate("2203269256ff7abcb649269df00e14c833dbf4ddfb5b36a1aae8b0"));
    }

    #[test]
    fn subtitle_body_is_read_as_lrc_or_as_cue_json() {
        let lrc = subtitle_cues("[00:01.00]LINE_A\n[00:02.00]LINE_B").unwrap();
        assert_eq!(lrc[0], Cue { time_ms: 1000, text: "LINE_A".into() });

        let json = subtitle_cues(r#"[{"text":"LINE_A","time":{"total":1.0}}]"#).unwrap();
        assert_eq!(json[0], Cue { time_ms: 1000, text: "LINE_A".into() });
    }

    #[test]
    fn empty_and_untimed_bodies_are_not_treated_as_a_timeline() {
        assert!(subtitle_cues("").is_none());
        assert!(subtitle_cues("LINE_A\nLINE_B").is_none());
        assert!(subtitle_cues("[00:01.00]\n[00:02.00]").is_none());
    }

    #[test]
    fn inner_envelope_status_is_read_not_the_transport_status() {
        let data: Value = serde_json::from_str(r#"{"message":{"header":{"status_code":401}}}"#).unwrap();
        assert_eq!(inner_status(&data), Some(401));
        assert_eq!(inner_status(&Value::Null), None);
    }

    #[test]
    fn identity_block_rejects_a_different_recording() {
        let macro_calls: Value = serde_json::from_str(
            r#"{"matcher.track.get":{"message":{"body":{"track":{"track_name":"Other Song","artist_name":"Singer","track_length":180}}}}}"#,
        )
        .unwrap();
        let query = TrackQuery {
            track: "A Song".into(),
            artists: vec!["Singer".into()],
            album: "Album".into(),
            duration_ms: 180_000,
            spotify_id: None,
        };
        assert!(!identity_matches(&macro_calls, &query));
        // With no identity block the query we sent is trusted.
        assert!(identity_matches(&Value::Null, &query));
    }
}
