//! Simplified Chinese lyrics rewritten in Traditional (Taiwan) characters.
//!
//! Opt-in, and run once when lyrics are downloaded: the database keeps the
//! rewritten text, so the cache and the screen always agree. Japanese lyrics
//! are left alone — shinjitai such as 国 and 学 are also Simplified, and
//! rewriting them would turn correct Japanese into Chinese.

use std::sync::LazyLock;

use ferrous_opencc::config::BuiltinConfig;
use ferrous_opencc::OpenCC;

use crate::lrc::WordCue;
use crate::matching::TO_SIMPLIFIED;
use crate::providers::LyricsResult;

static TO_TRADITIONAL: LazyLock<OpenCC> = LazyLock::new(|| {
    OpenCC::from_config(BuiltinConfig::S2tw).expect("embedded s2tw dictionary must load")
});

/// Rewrite the lyrics and their translations, each only when it reads as
/// Simplified Chinese: a Japanese song with a Chinese translation keeps its
/// original lines and gets its translation rewritten.
pub fn convert(result: &mut LyricsResult) {
    let lines = std::iter::once(result.text.as_str())
        .chain(result.cues.iter().map(|cue| cue.text.as_str()))
        .collect::<Vec<_>>()
        .join("\n");
    if is_simplified(&lines) {
        result.text = TO_TRADITIONAL.convert(&result.text);
        for cue in &mut result.cues {
            cue.text = TO_TRADITIONAL.convert(&cue.text);
            convert_words(&mut cue.words);
        }
    }

    let translations = result
        .cues
        .iter()
        .filter_map(|cue| cue.translation.as_deref())
        .collect::<Vec<_>>()
        .join("\n");
    if is_simplified(&translations) {
        for translation in result
            .cues
            .iter_mut()
            .filter_map(|cue| cue.translation.as_mut())
        {
            *translation = TO_TRADITIONAL.convert(translation);
        }
    }
}

/// Convert a line's word timings as one piece, so a phrase split across words
/// (头|发) still converts as a phrase (頭|髮, not 頭|發).
fn convert_words(words: &mut [WordCue]) {
    let joined: String = words.iter().map(|word| word.text.as_str()).collect();
    let converted: Vec<char> = TO_TRADITIONAL.convert(&joined).chars().collect();
    if converted.len() != joined.chars().count() {
        // A rewrite that changes the length cannot be cut back at the word
        // boundaries, so each word converts on its own.
        for word in words {
            word.text = TO_TRADITIONAL.convert(&word.text);
        }
        return;
    }
    let mut rest = converted.as_slice();
    for word in words {
        let (head, tail) = rest.split_at(word.text.chars().count());
        word.text = head.iter().collect();
        rest = tail;
    }
}

/// No kana, and more characters change toward Traditional than toward
/// Simplified. Kana means Japanese, however many Han characters it shares.
fn is_simplified(text: &str) -> bool {
    !text.chars().any(is_kana) && changes(text, &TO_TRADITIONAL) > changes(text, &TO_SIMPLIFIED)
}

fn changes(text: &str, converter: &OpenCC) -> usize {
    converter
        .convert(text)
        .chars()
        .zip(text.chars())
        .filter(|(after, before)| after != before)
        .count()
}

/// Hiragana and katakana letters. The katakana middle dot and long-vowel mark
/// are left out: Chinese lyrics borrow them as punctuation.
fn is_kana(c: char) -> bool {
    matches!(c, '\u{3041}'..='\u{3096}' | '\u{30A1}'..='\u{30FA}')
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lrc::Cue;

    fn cue(text: &str, words: &[&str], translation: Option<&str>) -> Cue {
        Cue {
            time_ms: 0,
            text: text.into(),
            words: words
                .iter()
                .map(|word| WordCue {
                    start_ms: 0,
                    end_ms: 0,
                    text: (*word).into(),
                })
                .collect(),
            translation: translation.map(Into::into),
        }
    }

    fn lyrics(cues: Vec<Cue>) -> LyricsResult {
        LyricsResult {
            text: cues
                .iter()
                .map(|cue| cue.text.as_str())
                .collect::<Vec<_>>()
                .join("\n"),
            cues,
            ..LyricsResult::empty("NetEase")
        }
    }

    fn words(cue: &Cue) -> Vec<&str> {
        cue.words.iter().map(|word| word.text.as_str()).collect()
    }

    #[test]
    fn simplified_lyrics_are_rewritten_with_their_words() {
        let mut result = lyrics(vec![
            cue("我们的头发", &["我们", "的头", "发"], None),
            cue("这是爱", &[], None),
        ]);
        convert(&mut result);
        assert_eq!(result.text, "我們的頭髮\n這是愛");
        assert_eq!(result.cues[0].text, "我們的頭髮");
        // 头发 is one phrase even though the words split it.
        assert_eq!(words(&result.cues[0]), ["我們", "的頭", "髮"]);
        assert_eq!(result.cues[1].text, "這是愛");
    }

    #[test]
    fn japanese_lines_stay_while_a_chinese_translation_is_rewritten() {
        let mut result = lyrics(vec![cue("国の学校", &["国", "の", "学校"], Some("国家的学校"))]);
        convert(&mut result);
        assert_eq!(result.text, "国の学校");
        assert_eq!(words(&result.cues[0]), ["国", "の", "学校"]);
        assert_eq!(result.cues[0].translation.as_deref(), Some("國家的學校"));
    }

    #[test]
    fn traditional_and_latin_lyrics_are_left_alone() {
        let mut result = lyrics(vec![
            cue("我們的頭髮", &[], Some("Our hair")),
            cue("這是愛", &[], None),
        ]);
        let before = result.clone();
        convert(&mut result);
        assert_eq!((result.text, result.cues), (before.text, before.cues));
    }

    #[test]
    fn chinese_punctuation_borrowed_from_katakana_is_not_japanese() {
        let mut result = lyrics(vec![cue("周杰伦・说好的幸福呢", &[], None)]);
        convert(&mut result);
        assert_eq!(result.text, "周杰倫・說好的幸福呢");
    }
}
