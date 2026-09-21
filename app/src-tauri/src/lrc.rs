//! LRC timeline parsing.
//!
//! Ported from the Python `lyrics_sources.parse_lrc`; the behaviour it encodes is
//! covered by the tests at the bottom of this file and must not drift:
//! a positive `[offset:]` advances the lyrics, so it is subtracted from cue times.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

static STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]").unwrap());
static META: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[(?:ar|ti|al|by|re|ve|length|offset):[^\]]*\]").unwrap());
static OFFSET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\[offset:([+-]?\d+)\]").unwrap());

/// One timed lyric line. `text` may hold several lines joined by `\n` when a
/// source stamps a translation with the same time as the original.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Cue {
    pub time_ms: i64,
    pub text: String,
}

/// Decode HTML entities the way Python's `html.unescape` does for lyric payloads.
pub fn unescape(raw: &str) -> String {
    html_escape::decode_html_entities(raw).into_owned()
}

/// Strip timestamps and LRC metadata tags, leaving the words of a line.
pub fn strip_tags(raw: &str) -> String {
    let without_meta = META.replace_all(raw, "");
    STAMP.replace_all(&without_meta, "").trim().to_string()
}

pub fn parse_lrc(text: &str) -> Vec<Cue> {
    // The offset tag is read before entity decoding, matching the Python order.
    let offset: i64 = OFFSET
        .captures_iter(text)
        .last()
        .and_then(|caps| caps[1].parse().ok())
        .unwrap_or(0);

    let decoded = unescape(text);
    let mut grouped: BTreeMap<i64, Vec<String>> = BTreeMap::new();

    // Split on both line terminators; LRC files from some sources still use bare CR.
    for line in decoded.split(['\n', '\r']) {
        let stamps: Vec<_> = STAMP.captures_iter(line).collect();
        if stamps.is_empty() {
            continue;
        }
        let words = strip_tags(line);
        for stamp in stamps {
            let minutes: i64 = stamp[1].parse().unwrap_or(0);
            let seconds: i64 = stamp[2].parse().unwrap_or(0);
            // A 1- or 2-digit fraction is left-aligned: ".1" is 100 ms, not 1 ms.
            let fraction: i64 = stamp
                .get(3)
                .map(|m| format!("{:0<3}", m.as_str()))
                .unwrap_or_else(|| "000".to_string())
                .parse()
                .unwrap_or(0);
            let millis = (minutes * 60 + seconds) * 1000 + fraction;
            let bucket = grouped.entry((millis - offset).max(0)).or_default();
            if !words.is_empty() && !bucket.iter().any(|existing| existing == &words) {
                bucket.push(words.clone());
            }
        }
    }

    grouped
        .into_iter()
        .map(|(time_ms, words)| Cue {
            time_ms,
            text: words.join("\n"),
        })
        .collect()
}

/// Index of the cue covering `position_ms`, or -1 before the first cue.
/// Equivalent to Python's `bisect_right(cues, position) - 1`.
pub fn active_line(cues: &[Cue], position_ms: i64) -> i64 {
    let mut low = 0usize;
    let mut high = cues.len();
    while low < high {
        let mid = (low + high) / 2;
        if position_ms < cues[mid].time_ms {
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    low as i64 - 1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cues(pairs: &[(i64, &str)]) -> Vec<Cue> {
        pairs
            .iter()
            .map(|(time_ms, text)| Cue {
                time_ms: *time_ms,
                text: (*text).to_string(),
            })
            .collect()
    }

    #[test]
    fn tags_offset_merge_and_blank() {
        let raw = "[ar:Test]\n[00:02.50][00:01.005]LINE_A\n[00:02.50]LINE_B\n[00:02.50]LINE_A\n[00:04]\n[offset:+500]";
        assert_eq!(
            parse_lrc(raw),
            cues(&[(505, "LINE_A"), (2000, "LINE_A\nLINE_B"), (3500, "")])
        );
    }

    #[test]
    fn negative_offset_and_invalid_input() {
        assert_eq!(
            parse_lrc("[offset:-100]\n[00:00.1]LINE_A\n[00:70]LINE_B\n[ti:test]"),
            cues(&[(200, "LINE_A")])
        );
        assert_eq!(parse_lrc("plain lyrics"), cues(&[]));
        // Offsets never push a cue below zero.
        assert_eq!(parse_lrc("[offset:900]\n[00:00.1]LINE_A"), cues(&[(0, "LINE_A")]));
    }

    #[test]
    fn carriage_return_only_files_still_parse() {
        assert_eq!(parse_lrc("[00:01]LINE_A\r[00:02]LINE_B"), cues(&[(1000, "LINE_A"), (2000, "LINE_B")]));
    }

    #[test]
    fn line_boundaries_and_seek_back() {
        let parsed = cues(&[(1000, "LINE_A"), (2000, "LINE_B")]);
        assert_eq!(active_line(&parsed, 999), -1);
        assert_eq!(active_line(&parsed, 1000), 0);
        assert_eq!(active_line(&parsed, 1500), 0);
        assert_eq!(active_line(&parsed, 2000), 1);
        assert_eq!(active_line(&[], 999), -1);
    }
}
