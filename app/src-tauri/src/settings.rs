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

use crate::player::PlayerKind;

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
/// the original backstop. Native YouTube Music lyrics are selected by the player,
/// not by this global fallback preference list.
pub const PROVIDERS: [(&str, &str); 5] = [
    ("lrclib", "LRCLIB"),
    ("petitlyrics", "PetitLyrics"),
    ("musixmatch", "Musixmatch"),
    ("netease", "NetEase"),
    ("qqmusic", "QQ Music"),
];

pub fn provider_label(id: &str) -> Option<&'static str> {
    if id == "youtube_music" {
        return Some("YouTube Music");
    }
    PROVIDERS
        .iter()
        .find(|(known, _)| *known == id)
        .map(|(_, label)| *label)
}

pub fn available_providers(player: PlayerKind) -> Vec<(&'static str, &'static str)> {
    let mut providers = PROVIDERS.to_vec();
    if player.plays_youtube_music() {
        providers.insert(0, ("youtube_music", "YouTube Music"));
    }
    providers
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

/// When the window lets clicks fall through to whatever is underneath.
///
/// Only ever acts while the window is pinned on top: an unpinned window that
/// swallowed nothing and answered nothing would just look broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClickThrough {
    /// Always answer the mouse.
    #[default]
    Off,
    /// Pass clicks through only while another window has focus.
    Auto,
    /// Always pass clicks through.
    Always,
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
    /// Controls: the cube's glow, the scrubber, the poster band.
    pub accent: String,
    /// The lyric line currently being sung.
    pub active_line: String,
    /// Lines already sung.
    pub past_line: String,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            accent: "#e6ff1f".into(),
            active_line: "#f4f6f5".into(),
            past_line: "#3e4040".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub shortcuts: Vec<crate::shortcuts::Binding>,
    /// Which player to follow. A reader uses one or the other, never both, so
    /// this is a switch rather than a priority list.
    pub player: PlayerKind,
    /// Spotify Client ID. Empty until the reader fills it in, and only asked for
    /// when the player above is Spotify.
    pub client_id: String,
    /// Where ytmdesktop2 serves its API; only read when that is the player.
    pub ytmd_port: u16,
    pub sources: Vec<SourcePreference>,
    pub theme: Theme,
    /// Auto-scroll the lyrics to the current line.
    pub follow_lyrics: bool,
    /// Keep the window above every other window.
    ///
    /// Stored rather than reset each launch: a reader who pins the lyrics over
    /// a game or a video wants them pinned the next time too.
    pub always_on_top: bool,
    /// Background opacity, as a percentage. The lyrics themselves stay opaque;
    /// this only thins what is behind them, so the window can sit over a game
    /// without hiding it.
    pub opacity: u8,
    pub click_through: ClickThrough,
    /// Compact mode strips the window down to the cube alone. Stored so the
    /// window comes back the way it was left.
    pub compact: bool,
    /// Whether compact's cube stretches sideways to show the lyrics. Stored
    /// for the same reason: a reader who hid them wants them hidden next time.
    pub compact_lyrics: bool,
    /// Kept so older and newer settings files round-trip, but compact no longer
    /// has a background to thin: its window is the cube and nothing else.
    pub compact_opacity: u8,
    /// Lyric type size in pixels, per mode.
    pub lyric_size: u8,
    pub compact_lyric_size: u8,
    /// The tile floor that ripples with the sound under the cube, per mode.
    /// Compact's window grows to hold it, so a reader may want it in one mode
    /// and not the other.
    pub wave_full: bool,
    pub wave_compact: bool,
}

/// Type-size bounds, shared by the two sliders. The floor stays readable at a
/// glance from across a desk; the ceiling still fits three lines in compact.
pub const MIN_LYRIC_SIZE: u8 = 12;
pub const MAX_LYRIC_SIZE: u8 = 44;

/// Below this the chrome stops being findable, so the slider stops here too.
pub const MIN_OPACITY: u8 = 30;

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcuts: crate::shortcuts::defaults(),
            player: PlayerKind::default(),
            client_id: String::new(),
            ytmd_port: crate::ytmdesktop::DEFAULT_PORT,
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
            opacity: 100,
            click_through: ClickThrough::Off,
            compact: false,
            compact_lyrics: false,
            compact_opacity: 85,
            lyric_size: 26,
            compact_lyric_size: 18,
            wave_full: true,
            wave_compact: true,
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
            let known = PROVIDERS.iter().any(|(id, _)| *id == source.id);
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
        if !crate::ytmdesktop::PORTS.contains(&self.ytmd_port) {
            self.ytmd_port = crate::ytmdesktop::DEFAULT_PORT;
        }
        self.opacity = self.opacity.clamp(MIN_OPACITY, 100);
        self.compact_opacity = self.compact_opacity.clamp(MIN_OPACITY, 100);
        self.lyric_size = self.lyric_size.clamp(MIN_LYRIC_SIZE, MAX_LYRIC_SIZE);
        self.compact_lyric_size = self
            .compact_lyric_size
            .clamp(MIN_LYRIC_SIZE, MAX_LYRIC_SIZE);
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

    /// Native lyrics belong to the selected playback terminal. Use the sample's
    /// player so an in-flight lookup cannot follow a newly switched setting.
    pub fn lyric_order(&self, player: PlayerKind) -> Vec<String> {
        let mut order = self.lookup_order();
        order.retain(|id| id != "youtube_music");
        if player.plays_youtube_music() {
            order.insert(0, "youtube_music".into());
        }
        order
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
    let pending = path.with_extension("json.tmp");
    std::fs::write(&pending, text)
        .and_then(|()| std::fs::rename(&pending, &path))
        .map_err(|error| format!("Cannot write {}: {error}", path.display()))
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

    /// Files written before compact could hide its lyrics open with them hidden,
    /// and the reader's choice survives a save and reload.
    #[test]
    fn compact_lyrics_defaults_off_and_persists() {
        let old: Settings = serde_json::from_str(r#"{"compact":true}"#).unwrap();
        assert!(!old.compact_lyrics);
        assert!(serde_json::to_string(&Settings::default())
            .unwrap()
            .contains("\"compactLyrics\":false"));
        with_temp_data_dir(|_| {
            let settings = Settings {
                compact_lyrics: true,
                ..Settings::default()
            };
            save(&settings).unwrap();
            assert!(load().compact_lyrics);
        });
    }

    #[test]
    fn shortcuts_default_for_old_files_and_persist_changes_without_partial_writes() {
        let old: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(old.shortcuts, crate::shortcuts::defaults());
        with_temp_data_dir(|folder| {
            let mut settings = Settings::default();
            save(&settings).unwrap();
            settings.shortcuts[0].accelerator = "Ctrl+KeyJ".into();
            settings.shortcuts[0].global = true;
            save(&settings).unwrap();
            assert_eq!(load().shortcuts, settings.shortcuts);
            std::fs::create_dir(folder.join("settings.json.tmp")).unwrap();
            let saved = settings.clone();
            settings.shortcuts.clear();
            assert!(save(&settings).is_err());
            assert_eq!(load(), saved);
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

    /// A hand-edited settings file must not be able to make the window vanish.
    #[test]
    fn normalize_clamps_opacity_into_a_findable_range() {
        for (stored, expected) in [(0, MIN_OPACITY), (5, MIN_OPACITY), (60, 60), (255, 100)] {
            let mut settings = Settings {
                opacity: stored,
                compact_opacity: stored,
                ..Settings::default()
            };
            settings.normalize();
            assert_eq!(settings.opacity, expected, "opacity {stored}");
            assert_eq!(
                settings.compact_opacity, expected,
                "compact opacity {stored}"
            );
        }
    }

    /// Both sliders share the bounds, and neither may reach zero: lyrics that
    /// cannot be seen are the one thing this window is for.
    #[test]
    fn normalize_clamps_both_lyric_sizes() {
        for (stored, expected) in [(0, MIN_LYRIC_SIZE), (26, 26), (200, MAX_LYRIC_SIZE)] {
            let mut settings = Settings {
                lyric_size: stored,
                compact_lyric_size: stored,
                ..Settings::default()
            };
            settings.normalize();
            assert_eq!(settings.lyric_size, expected, "lyric size {stored}");
            assert_eq!(
                settings.compact_lyric_size, expected,
                "compact lyric size {stored}"
            );
        }
    }

    #[test]
    fn click_through_round_trips_through_its_lowercase_names() {
        for (mode, text) in [
            (ClickThrough::Off, "\"off\""),
            (ClickThrough::Auto, "\"auto\""),
            (ClickThrough::Always, "\"always\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), text);
            assert_eq!(serde_json::from_str::<ClickThrough>(text).unwrap(), mode);
        }
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

    #[test]
    fn native_lyrics_follow_the_player_not_global_source_preferences() {
        let mut settings = Settings {
            sources: vec![
                SourcePreference {
                    id: "netease".into(),
                    enabled: true,
                },
                SourcePreference {
                    id: "youtube_music".into(),
                    enabled: false,
                },
                SourcePreference {
                    id: "lrclib".into(),
                    enabled: false,
                },
            ],
            ..Settings::default()
        };
        settings.normalize();
        assert!(!settings
            .sources
            .iter()
            .any(|source| source.id == "youtube_music"));
        let spotify = settings.lyric_order(PlayerKind::Spotify);
        assert_eq!(spotify, ["netease", "petitlyrics", "musixmatch", "qqmusic"]);
        let youtube = settings.lyric_order(PlayerKind::Ytmdesktop2);
        assert_eq!(youtube[0], "youtube_music");
        assert_eq!(&youtube[1..], spotify);
        assert_ne!(
            format!("auto:{}", youtube.join(",")),
            format!("auto:{}", spotify.join(","))
        );
        assert!(!available_providers(PlayerKind::Spotify)
            .iter()
            .any(|(id, _)| *id == "youtube_music"));
        assert_eq!(
            available_providers(PlayerKind::Ytmdesktop2)[0].0,
            "youtube_music"
        );
    }

    #[test]
    fn a_ytmdesktop2_port_outside_its_own_range_falls_back_to_the_default() {
        let mut settings = Settings::default();
        assert_eq!(settings.ytmd_port, 13091);
        settings.ytmd_port = 20000;
        settings.normalize();
        assert_eq!(settings.ytmd_port, 20000);
        for wrong in [80, 9998, 39_999 + 1] {
            settings.ytmd_port = wrong;
            settings.normalize();
            assert_eq!(settings.ytmd_port, 13091, "port {wrong}");
        }
        // Files written before the option existed still load, with the default.
        let older: Settings = serde_json::from_str(r#"{"player":"ytmdesktop2"}"#).unwrap();
        assert_eq!(older.player, PlayerKind::Ytmdesktop2);
        assert_eq!(older.ytmd_port, 13091);
    }

    /// The system media session player is gone. A file that still chooses it
    /// must not fail to parse, which would reset every other choice too.
    #[test]
    fn a_file_choosing_the_retired_media_session_keeps_everything_else() {
        with_temp_data_dir(|folder| {
            std::fs::write(
                folder.join(SETTINGS_FILE),
                r#"{"player":"ytmusic","clientId":"abc123","ytmdPort":20000,
                    "compact":true,"lyricSize":30,"waveCompact":false}"#,
            )
            .unwrap();
            let loaded = load();
            assert_eq!(loaded.player, PlayerKind::Ytmdesktop2);
            assert_eq!(loaded.client_id, "abc123");
            assert_eq!(loaded.ytmd_port, 20000);
            assert!(loaded.compact && !loaded.wave_compact);
            assert_eq!(loaded.lyric_size, 30);

            save(&loaded).unwrap();
            let text = std::fs::read_to_string(folder.join(SETTINGS_FILE)).unwrap();
            assert!(text.contains("\"ytmdesktop2\"") && !text.contains("ytmusic"));
        });
    }

    #[test]
    fn the_wave_is_on_in_both_modes_until_turned_off_in_one() {
        let older: Settings = serde_json::from_str(r#"{"compact":true}"#).unwrap();
        assert!(older.wave_full && older.wave_compact);
        let chosen: Settings =
            serde_json::from_str(r#"{"waveFull":true,"waveCompact":false}"#).unwrap();
        assert!(chosen.wave_full && !chosen.wave_compact);
        let text = serde_json::to_string(&chosen).unwrap();
        assert!(text.contains("\"waveCompact\":false"));
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
