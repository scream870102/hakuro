//! Portable, user-editable configuration stored beside the executable.
//!
//! Everything Hakuro persists — `settings.json`, `lyrics.db`, `session.bin` —
//! lives in one folder next to the program, so the whole app can be copied to
//! another machine or a USB stick without leaving state behind in the profile.
//!
//! The Spotify Client ID lives here rather than in a `secret.env` beside the
//! executable: it is typed in the settings panel, so a first run needs no text
//! editor. It is still never compiled into the binary, so sharing a build does
//! not share a Spotify identity.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[cfg(test)]
thread_local! {
    static TEST_DATA_DIR: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

pub const SETTINGS_FILE: &str = "settings.json";

/// Every lyrics source, in the default lookup order.
///
/// LRCLIB is open and fastest. The Japanese-market sources come next because
/// this player is used on a Japan-region account, PetitLyrics ahead of
/// Musixmatch because live probing on 2026-09-21 showed PetitLyrics answering
/// reliably while Musixmatch was rate-limited. The Chinese sources stay last as
/// the original backstop.
pub const PROVIDERS: [(&str, &str); 5] = [
    ("lrclib", "LRCLIB"),
    ("petitlyrics", "PetitLyrics"),
    ("musixmatch", "Musixmatch"),
    ("netease", "NetEase"),
    ("qqmusic", "QQ Music"),
];

pub fn provider_label(id: &str) -> Option<&'static str> {
    PROVIDERS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, label)| *label)
}

/// The folder holding every file this app writes.
pub fn data_dir() -> Result<PathBuf, String> {
    #[cfg(test)]
    if let Some(folder) = TEST_DATA_DIR.with(|path| path.borrow().clone()) {
        return Ok(folder);
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .ok_or_else(|| "Cannot locate the application folder.".to_string())
}

pub fn data_path(name: &str) -> Result<PathBuf, String> {
    let dir = data_dir()?;
    // A portable install may be unpacked into a folder that does not exist yet.
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir.join(name))
}

/// One entry of the global lookup order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourcePreference {
    pub id: String,
    pub enabled: bool,
}

/// Colours the reader can change. Stored as CSS colour strings and handed to
/// the interface untouched, which keeps the palette in one place instead of
/// spreading hard-coded values through the stylesheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Theme {
    /// Controls: the follow toggle, the scrubber, the synced badge.
    pub accent: String,
    /// The lyric line currently being sung.
    pub active_line: String,
    /// Lines already sung.
    pub past_line: String,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: "#1db954".into(),
            active_line: "#f4f6f5".into(),
            past_line: "#3e4040".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Spotify Client ID. Empty until the reader fills it in.
    pub client_id: String,
    pub sources: Vec<SourcePreference>,
    pub theme: Theme,
    /// Auto-scroll the lyrics to the current line.
    pub follow_lyrics: bool,
    /// Keep the window above every other window.
    ///
    /// Stored rather than reset each launch: a reader who pins the lyrics over
    /// a game or a video wants them pinned the next time too.
    pub always_on_top: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            sources: PROVIDERS
                .iter()
                .map(|(id, _)| SourcePreference {
                    id: (*id).to_string(),
                    enabled: true,
                })
                .collect(),
            theme: Theme::default(),
            follow_lyrics: true,
            always_on_top: false,
        }
    }
}

impl Settings {
    /// Drop sources this build does not have, drop duplicates, and append any
    /// source the stored file predates — so a settings file written by an older
    /// or newer build never silently hides a provider or resurrects a dead one.
    pub fn normalize(&mut self) {
        let mut seen: Vec<String> = Vec::new();
        self.sources.retain(|source| {
            let known = provider_label(&source.id).is_some();
            let fresh = !seen.contains(&source.id);
            if known && fresh {
                seen.push(source.id.clone());
            }
            known && fresh
        });
        for (id, _) in PROVIDERS {
            if !seen.iter().any(|known| known == id) {
                self.sources.push(SourcePreference {
                    id: id.to_string(),
                    enabled: true,
                });
            }
        }
        self.client_id = self.client_id.trim().to_string();
    }

    /// The lookup order actually used: enabled sources, in the stored order.
    ///
    /// All-disabled is treated as "no preference expressed" rather than "never
    /// look anything up", because a settings file that silently stops all
    /// lyrics is worse than one that ignores an unusable choice.
    pub fn lookup_order(&self) -> Vec<String> {
        let enabled: Vec<String> = self
            .sources
            .iter()
            .filter(|source| source.enabled)
            .map(|source| source.id.clone())
            .collect();
        if enabled.is_empty() {
            return self
                .sources
                .iter()
                .map(|source| source.id.clone())
                .collect();
        }
        enabled
    }
}

/// Read `settings.json`, falling back to defaults.
///
/// A missing file is the normal first run. A corrupt one is also answered with
/// defaults rather than a failure: losing a colour choice is recoverable, being
/// unable to open the app to fix it is not.
pub fn load() -> Settings {
    let mut settings = data_path(SETTINGS_FILE)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
        .unwrap_or_default();
    settings.normalize();
    settings
}

pub fn save(settings: &Settings) -> Result<(), String> {
    let path = data_path(SETTINGS_FILE)?;
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| format!("Cannot write {}: {error}", path.display()))
}

/// A Client ID is 32 lowercase hex characters today, but Spotify documents no
/// format, so this only rejects what certainly is not one: empty, or carrying
/// characters no identifier uses. A wrong-but-plausible value is Spotify's to
/// refuse, with its own wording.
pub fn validate_client_id(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Enter your Spotify Client ID in Settings.".into());
    }
    if !value.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("The Client ID should be letters and digits only. Use the Client ID, not the client secret.".into());
    }
    Ok(value.to_string())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// Redirect the data folder so tests never read or write the real one.
    pub fn with_temp_data_dir<T>(body: impl FnOnce(&std::path::Path) -> T) -> T {
        let folder = std::env::temp_dir().join(format!(
            "hakuro-test-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&folder);
        std::fs::create_dir_all(&folder).unwrap();
        let previous = TEST_DATA_DIR.with(|path| path.replace(Some(folder.clone())));
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| body(&folder)));
        TEST_DATA_DIR.with(|path| path.replace(previous));
        let _ = std::fs::remove_dir_all(&folder);
        match outcome {
            Ok(value) => value,
            Err(panic) => std::panic::resume_unwind(panic),
        }
    }

    #[test]
    fn defaults_list_every_provider_in_lookup_order() {
        let settings = Settings::default();
        let ids: Vec<&str> = settings.sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids, PROVIDERS.map(|(id, _)| id).to_vec());
        assert!(settings.client_id.is_empty());
    }

    #[test]
    fn saved_settings_survive_a_round_trip() {
        with_temp_data_dir(|_| {
            let mut settings = Settings::default();
            settings.client_id = "abc123".into();
            settings.theme.accent = "#ff8800".into();
            settings.sources.reverse();
            save(&settings).unwrap();

            let reloaded = load();
            assert_eq!(reloaded.client_id, "abc123");
            assert_eq!(reloaded.theme.accent, "#ff8800");
            assert_eq!(reloaded.sources, settings.sources);
        });
    }

    #[test]
    fn a_corrupt_file_falls_back_to_defaults_instead_of_locking_the_app_out() {
        with_temp_data_dir(|folder| {
            std::fs::write(folder.join(SETTINGS_FILE), "{ not json").unwrap();
            assert_eq!(load(), Settings::default());
        });
    }

    #[test]
    fn normalize_drops_unknown_and_duplicate_sources_and_appends_missing_ones() {
        let mut settings = Settings {
            sources: vec![
                SourcePreference {
                    id: "qqmusic".into(),
                    enabled: false,
                },
                SourcePreference {
                    id: "ghost".into(),
                    enabled: true,
                },
                SourcePreference {
                    id: "qqmusic".into(),
                    enabled: true,
                },
            ],
            ..Settings::default()
        };
        settings.normalize();

        let ids: Vec<&str> = settings.sources.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids[0], "qqmusic", "the stored order is kept");
        assert_eq!(
            ids.len(),
            PROVIDERS.len(),
            "every provider is present exactly once"
        );
        assert!(!ids.contains(&"ghost"));
        assert!(!settings.sources[0].enabled, "the stored flag is kept");
    }

    #[test]
    fn lookup_order_keeps_only_enabled_sources() {
        let mut settings = Settings::default();
        settings.sources[0].enabled = false;
        settings.sources[2].enabled = false;
        assert_eq!(
            settings.lookup_order(),
            vec!["petitlyrics", "netease", "qqmusic"]
        );
    }

    /// Disabling everything must not mean "never fetch lyrics again".
    #[test]
    fn disabling_every_source_falls_back_to_the_full_order() {
        let mut settings = Settings::default();
        for source in &mut settings.sources {
            source.enabled = false;
        }
        assert_eq!(settings.lookup_order().len(), PROVIDERS.len());
    }

    #[test]
    fn client_id_validation_rejects_blank_and_punctuation_but_accepts_alphanumerics() {
        assert!(validate_client_id("  ").is_err());
        assert!(validate_client_id("SPOTIFY_CLIENT_ID=abc").is_err());
        assert_eq!(validate_client_id("  abc123  ").unwrap(), "abc123");
    }
}
