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
static WORD_STAMP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?>").unwrap());
static TIMED_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\[(\d+),(\d+)\]").unwrap());
static YRC_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\((\d+),(\d+),0\)").unwrap());
static QRC_WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\((\d+),(\d+)\)").unwrap());

/// One timed lyric line. `text` may hold several lines joined by `\n` when a
/// source stamps a translation with the same time as the original.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Cue {
    pub time_ms: i64,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub words: Vec<WordCue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub translation: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WordCue {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

/// Decode HTML entities the way Python's `html.unescape` does for lyric payloads.
pub fn unescape(raw: &str) -> String {
    html_escape::decode_html_entities(raw).into_owned()
}

/// Strip timestamps and LRC metadata tags, leaving the words of a line.
pub fn strip_tags(raw: &str) -> String {
    let without_meta = META.replace_all(raw, "");
    let without_stamps = STAMP.replace_all(&without_meta, "");
    WORD_STAMP
        .replace_all(&without_stamps, "")
        .trim()
        .to_string()
}

fn offset(text: &str) -> i64 {
    OFFSET
        .captures_iter(text)
        .last()
        .and_then(|caps| caps[1].parse().ok())
        .unwrap_or(0)
}

fn stamp_ms(stamp: &regex::Captures<'_>) -> i64 {
    let minutes: i64 = stamp[1].parse().unwrap_or(0);
    let seconds: i64 = stamp[2].parse().unwrap_or(0);
    let fraction: i64 = stamp
        .get(3)
        .map(|m| format!("{:0<3}", m.as_str()))
        .and_then(|fraction| fraction.parse().ok())
        .unwrap_or(0);
    (minutes * 60 + seconds) * 1000 + fraction
}

pub fn parse_lrc(text: &str) -> Vec<Cue> {
    // The offset tag is read before entity decoding, matching the Python order.
    let offset = offset(text);

    let decoded = unescape(text);
    let mut grouped: BTreeMap<i64, Cue> = BTreeMap::new();

    // Split on both line terminators; LRC files from some sources still use bare CR.
    for line in decoded.split(['\n', '\r']) {
        let stamps: Vec<_> = STAMP.captures_iter(line).collect();
        if stamps.is_empty() {
            continue;
        }
        let text = strip_tags(line);
        let word_stamps: Vec<_> = WORD_STAMP.captures_iter(line).collect();
        let first_stamp = stamp_ms(&stamps[0]);
        for stamp in stamps {
            let millis = stamp_ms(&stamp);
            let time_ms = millis.saturating_sub(offset).max(0);
            let mut words = Vec::new();
            if let Some(first_word) = word_stamps.first() {
                // Some enhanced files use the line stamp as the first word stamp.
                let prefix = STAMP.replace_all(&line[..first_word.get(0).unwrap().start()], "");
                let prefix = META.replace_all(&prefix, "");
                if !prefix.trim().is_empty() {
                    words.push(WordCue {
                        start_ms: time_ms,
                        end_ms: stamp_ms(first_word)
                            .saturating_add(millis - first_stamp)
                            .saturating_sub(offset)
                            .max(0),
                        text: prefix.into_owned(),
                    });
                }
            }
            for (index, word_stamp) in word_stamps.iter().enumerate() {
                let next = word_stamps.get(index + 1);
                let word_text = &line[word_stamp.get(0).unwrap().end()
                    ..next
                        .map(|stamp| stamp.get(0).unwrap().start())
                        .unwrap_or(line.len())];
                if word_text.is_empty() {
                    continue;
                }
                let shift = millis - first_stamp;
                let start_ms = stamp_ms(word_stamp)
                    .saturating_add(shift)
                    .saturating_sub(offset)
                    .max(0);
                let end_ms = next
                    .map(stamp_ms)
                    .unwrap_or_else(|| stamp_ms(word_stamp))
                    .saturating_add(shift)
                    .saturating_sub(offset)
                    .max(0);
                words.push(WordCue {
                    start_ms,
                    end_ms,
                    text: word_text.to_string(),
                });
            }
            if words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<String>()
                .trim()
                != text
                || words
                    .iter()
                    .any(|word| word.start_ms < time_ms || word.end_ms < word.start_ms)
                || words
                    .windows(2)
                    .any(|pair| pair[0].start_ms > pair[1].start_ms)
            {
                words.clear();
            }
            let cue = grouped.entry(time_ms).or_insert_with(|| Cue {
                time_ms,
                ..Default::default()
            });
            if !text.is_empty() && !cue.text.lines().any(|existing| existing == text) {
                if cue.text.is_empty() {
                    cue.text = text.clone();
                    cue.words = words;
                } else {
                    cue.text.push('\n');
                    cue.text.push_str(&text);
                    // Multiple same-time lines may be languages or duet voices; preserve both.
                    cue.words.clear();
                }
            }
        }
    }

    let mut cues: Vec<_> = grouped.into_values().collect();
    for index in 0..cues.len().saturating_sub(1) {
        let next_start = cues[index + 1].time_ms;
        if let Some(last) = cues[index].words.last_mut() {
            if last.end_ms == last.start_ms && next_start > last.start_ms {
                last.end_ms = next_start;
            }
        }
    }
    cues
}

/// NetEase YRC: `[lineStart,duration](absoluteWordStart,duration,0)text`.
pub fn parse_yrc(raw: &str) -> Vec<Cue> {
    parse_timed_words(raw, true)
}

/// Decoded QQ QRC: `[lineStart,duration]text(absoluteWordStart,duration)`.
pub fn parse_qrc(raw: &str) -> Vec<Cue> {
    if let Ok(document) = roxmltree::Document::parse(raw) {
        if let Some(content) = document
            .descendants()
            .find_map(|node| node.attribute("LyricContent"))
        {
            return parse_timed_words(content, false);
        }
    }
    parse_timed_words(raw, false)
}

fn parse_timed_words(raw: &str, yrc: bool) -> Vec<Cue> {
    let offset = offset(raw);
    let decoded = unescape(raw);
    let mut cues = Vec::new();
    for line in decoded.split(['\r', '\n']) {
        let Some(header) = TIMED_LINE.captures(line.trim()) else {
            continue;
        };
        let (Ok(start), Ok(duration)) = (header[1].parse::<i64>(), header[2].parse::<i64>()) else {
            continue;
        };
        let Some(line_end) = start.checked_add(duration) else {
            continue;
        };
        let body = &line.trim()[header.get(0).unwrap().end()..];
        let pattern = if yrc { &*YRC_WORD } else { &*QRC_WORD };
        let stamps: Vec<_> = pattern.captures_iter(body).collect();
        if stamps.is_empty() {
            continue;
        }
        let mut words = Vec::new();
        let mut valid = true;
        for (index, stamp) in stamps.iter().enumerate() {
            let (Ok(word_start), Ok(word_duration)) =
                (stamp[1].parse::<i64>(), stamp[2].parse::<i64>())
            else {
                valid = false;
                break;
            };
            let Some(word_end) = word_start.checked_add(word_duration) else {
                valid = false;
                break;
            };
            if word_start < start
                || word_end > line_end
                || words.last().is_some_and(|word: &WordCue| {
                    word.start_ms > word_start.saturating_sub(offset).max(0)
                })
            {
                valid = false;
                break;
            }
            let range = if yrc {
                stamp.get(0).unwrap().end()
                    ..stamps
                        .get(index + 1)
                        .map(|next| next.get(0).unwrap().start())
                        .unwrap_or(body.len())
            } else {
                index
                    .checked_sub(1)
                    .map(|prev| stamps[prev].get(0).unwrap().end())
                    .unwrap_or(0)..stamp.get(0).unwrap().start()
            };
            let text = &body[range];
            if !text.is_empty() {
                words.push(WordCue {
                    start_ms: word_start.saturating_sub(offset).max(0),
                    end_ms: word_end.saturating_sub(offset).max(0),
                    text: text.to_string(),
                });
            }
        }
        let text = pattern.replace_all(body, "").trim().to_string();
        if !valid
            || words.is_empty()
            || words
                .iter()
                .map(|word| word.text.as_str())
                .collect::<String>()
                .trim()
                != text
        {
            continue;
        }
        cues.push(Cue {
            time_ms: start.saturating_sub(offset).max(0),
            text,
            words,
            ..Default::default()
        });
    }
    cues.sort_by_key(|cue| cue.time_ms);
    cues
}

/// Only exact timestamps (after declared offsets) establish a translation match.
/// Sparse or shifted tracks must never silently attach to a different lyric line.
pub fn merge_translation(cues: &mut [Cue], raw: &str) {
    let translations: BTreeMap<_, _> = parse_lrc(raw)
        .into_iter()
        .map(|cue| (cue.time_ms, cue.text))
        .collect();
    for cue in cues {
        let Some(text) = translations.get(&cue.time_ms) else {
            continue;
        };
        let lines: Vec<_> = text
            .lines()
            .filter(|line| {
                !line.trim().is_empty()
                    && !cue
                        .text
                        .lines()
                        .any(|original| original.trim() == line.trim())
            })
            .collect();
        if !lines.is_empty() {
            cue.translation = Some(lines.join("\n"));
        }
    }
}

/// Index of the cue covering `position_ms`, or -1 before the first cue.
/// Equivalent to Python's `bisect_right(cues, position) - 1`.
///
/// The running highlight is driven by `activeLine` in `clock.ts`, because it
/// has to move between polls rather than once per lookup. This copy exists to
/// hold that search honest against the parser's own output, so it is compiled
/// for the tests only.
#[cfg(test)]
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
                ..Default::default()
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
        assert_eq!(
            parse_lrc("[offset:900]\n[00:00.1]LINE_A"),
            cues(&[(0, "LINE_A")])
        );
    }

    #[test]
    fn carriage_return_only_files_still_parse() {
        assert_eq!(
            parse_lrc("[00:01]LINE_A\r[00:02]LINE_B"),
            cues(&[(1000, "LINE_A"), (2000, "LINE_B")])
        );
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

    #[test]
    fn old_cached_cues_still_deserialize() {
        let cue: Cue = serde_json::from_str(r#"{"time_ms":1000,"text":"Line"}"#).unwrap();
        assert_eq!(cue, cues(&[(1000, "Line")])[0]);
        assert_eq!(
            serde_json::to_string(&cue).unwrap(),
            r#"{"time_ms":1000,"text":"Line"}"#
        );
    }

    #[test]
    fn enhanced_lrc_keeps_words_offsets_and_repeated_lines() {
        let parsed =
            parse_lrc("[offset:100]\n[00:01][00:05]<00:01>Hello <00:01.5>world<00:02>\n[00:08]End");
        assert_eq!(parsed[0].text, "Hello world");
        assert_eq!(
            parsed[0].words,
            vec![
                WordCue {
                    start_ms: 900,
                    end_ms: 1400,
                    text: "Hello ".into()
                },
                WordCue {
                    start_ms: 1400,
                    end_ms: 1900,
                    text: "world".into()
                },
            ]
        );
        assert_eq!(parsed[1].words[0].start_ms, 4900);
        assert_eq!(parsed[1].words[1].end_ms, 5900);
        assert!(parsed[2].words.is_empty());
        let inferred = parse_lrc("[00:01]<00:01>One\n[00:03]<00:03>Two");
        assert_eq!(inferred[0].words[0].end_ms, 3000);
        assert_eq!(inferred[1].words[0].end_ms, 3000);
        assert!(parse_lrc("[00:01]<00:02>Bad<00:01>time")[0]
            .words
            .is_empty());
        let implicit_first = parse_lrc("[00:01]Hello <00:02>world<00:03>");
        assert_eq!(
            implicit_first[0].words[0],
            WordCue {
                start_ms: 1000,
                end_ms: 2000,
                text: "Hello ".into(),
            }
        );
        assert_eq!(
            parse_lrc("[offset:9223372036854775807]\n[00:01]Safe")[0].time_ms,
            0
        );
    }

    #[test]
    fn yrc_and_qrc_preserve_absolute_word_timing() {
        let yrc = parse_yrc(
            "[offset:100]\n[1000,1200](1000,400,0)Hello (1400,800,0)world\n{\"metadata\":true}",
        );
        let qrc = parse_qrc("[offset:100]\n[1000,1200]Hello (1000,400)world(1400,800)");
        assert_eq!(yrc, qrc);
        assert_eq!(yrc[0].time_ms, 900);
        assert_eq!(
            yrc[0].words[1],
            WordCue {
                start_ms: 1300,
                end_ms: 2100,
                text: "world".into()
            }
        );
        let xml = parse_qrc("<QrcInfos><LyricInfo><Lyric_1 LyricContent=\"[1000,500]Hello(1000,500)\"/></LyricInfo></QrcInfos>");
        assert_eq!(xml[0].text, "Hello");
        assert!(parse_yrc("[1000,200]no words").is_empty());
        assert!(parse_qrc("[00:01]ordinary LRC").is_empty());
        assert!(parse_yrc("[1000,200](1000,500,0)outside line").is_empty());
        assert!(parse_yrc("[9223372036854775807,1](0,1,0)overflow").is_empty());
        assert!(parse_qrc("[1000,200]Hello(1000,200)lost text").is_empty());
    }

    #[test]
    fn translation_aligns_offsets_without_zipping_sparse_or_shifted_lines() {
        let mut parsed =
            parse_lrc("[00:01]Original\n[00:02]Second\n[00:03]Third\n[00:03]Another voice");
        merge_translation(
            &mut parsed,
            "[offset:100]\n[00:01.1]Original\n[00:01.1]翻譯\n[00:03.1]第三句\n[00:04.1]Not a match",
        );
        assert_eq!(parsed[0].translation.as_deref(), Some("翻譯"));
        assert!(parsed[1].translation.is_none());
        assert_eq!(parsed[2].text, "Third\nAnother voice");
        assert_eq!(parsed[2].translation.as_deref(), Some("第三句"));
        let mut shifted = parse_lrc("[00:01]Original\n[00:02]Second");
        merge_translation(&mut shifted, "[00:01.5]Unknown\n[00:02.5]Unknown");
        assert!(shifted.iter().all(|cue| cue.translation.is_none()));
    }
}
