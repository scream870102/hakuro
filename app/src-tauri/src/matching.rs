//! Conservative track identity matching.
//!
//! Ported from the Python `lyrics_sources._normal` / `_matches`. Version words
//! (Live, Remix, ...) are deliberately kept: stripping them picks wrong recordings.
//! Traditional/Simplified conversion is used for comparison only — displayed
//! lyrics are never rewritten.

use std::sync::LazyLock;

use ferrous_opencc::config::BuiltinConfig;
use ferrous_opencc::OpenCC;
use unicode_normalization::UnicodeNormalization;

use crate::lrc::unescape;

/// Dictionaries are embedded in the crate at build time, so no data files ship
/// beside the executable.
static TO_SIMPLIFIED: LazyLock<OpenCC> = LazyLock::new(|| {
    OpenCC::from_config(BuiltinConfig::T2s).expect("embedded t2s dictionary must load")
});

/// Fold a title or artist name down to a comparison key.
pub fn normalize(value: &str) -> String {
    let decoded = unescape(value);
    let nfkc: String = decoded.nfkc().collect();
    let folded = caseless::default_case_fold_str(&nfkc);
    TO_SIMPLIFIED
        .convert(&folded)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// A candidate only matches when the title is identical after folding, at least
/// one artist overlaps, and both durations are known and within four seconds —
/// the same window LRCLIB uses.
pub fn matches(
    track: &str,
    artists: &[String],
    duration_ms: i64,
    title: &str,
    candidate_artists: &[String],
    candidate_ms: Option<i64>,
) -> bool {
    let wanted_title = normalize(track);
    if wanted_title.is_empty() || wanted_title != normalize(title) {
        return false;
    }

    let wanted: Vec<String> = artists
        .iter()
        .filter(|a| !a.is_empty())
        .map(|a| normalize(a))
        .collect();
    let found: Vec<String> = candidate_artists
        .iter()
        .filter(|a| !a.is_empty())
        .map(|a| normalize(a))
        .collect();
    if wanted.is_empty() || !wanted.iter().any(|a| found.contains(a)) {
        return false;
    }

    // A missing duration cannot establish which recording this is.
    match candidate_ms {
        Some(candidate) if duration_ms > 0 && candidate > 0 => {
            (duration_ms - candidate).abs() <= 4000
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artists(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn requires_artist_duration_and_version() {
        let check = |title: &str, artist: &str, duration: Option<i64>| {
            // Fullwidth "Ａ" must fold to ASCII "a" through NFKC.
            matches("Ａ Song", &artists(&["Singer"]), 180_000, title, &artists(&[artist]), duration)
        };
        assert!(check("a song", "SINGER", Some(182_000)));
        assert!(!check("A Song (Live)", "Singer", Some(180_000)));
        assert!(!check("A Song", "Cover Artist", Some(180_000)));
        assert!(!check("A Song", "Singer", Some(185_000)));
        assert!(!check("A Song", "Singer", None));
    }

    #[test]
    fn chinese_matching_converts_only_the_comparison() {
        assert!(matches(
            "測試曲目",
            &artists(&["測試歌手"]),
            256_000,
            "测试曲目",
            &artists(&["测试歌手"]),
            Some(257_000)
        ));
        assert!(!matches(
            "測試曲目",
            &artists(&["測試歌手"]),
            269_000,
            "测试曲目 (Live)",
            &artists(&["测试歌手"]),
            Some(269_000)
        ));
        // A romanized artist name is not treated as the same artist.
        assert!(!matches(
            "測試曲目",
            &artists(&["測試歌手"]),
            269_000,
            "测试曲目",
            &artists(&["Ceshi Geshou"]),
            Some(269_000)
        ));
    }

    #[test]
    fn empty_title_never_matches() {
        assert!(!matches("", &artists(&["Singer"]), 180_000, "", &artists(&["Singer"]), Some(180_000)));
    }
}
