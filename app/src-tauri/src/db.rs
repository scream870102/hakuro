//! SQLite store for lyrics already downloaded, and for per-track source choices.
//!
//! Before this existed the cache was a HashMap that died with the process, so
//! every restart re-queried five public endpoints for songs already looked up.
//! The database lives beside the executable (see `settings::data_dir`) and
//! keeps the app polite to sources that are unofficial and rate-limited.
//!
//! Storage is best-effort on purpose: a folder that cannot be written to
//! degrades the app to an in-memory session, it does not stop it from running.

use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};

use crate::lrc::Cue;
use crate::providers::LyricsResult;
use crate::settings;

pub const DATABASE_FILE: &str = "lyrics.db";

/// Rows older than this are re-fetched: a source that had only plain text may
/// have gained a timeline, and a bad match should not be cached forever.
const MAX_AGE_SECONDS: i64 = 60 * 60 * 24 * 30;

/// The source column value meaning "whatever the normal lookup order finds".
pub const AUTO: &str = "";

pub struct Db {
    /// `None` when the database could not be opened; the reason is in `warning`.
    connection: Option<Mutex<Connection>>,
    warning: Option<String>,
}

/// What the player needs to know about a track when caching its lyrics, kept
/// so the database is readable on its own rather than a wall of opaque keys.
pub struct TrackInfo<'a> {
    pub name: &'a str,
    pub artist: &'a str,
}

impl Db {
    /// Open (and migrate) the database beside the executable.
    pub fn open() -> Self {
        match Self::try_open() {
            Ok(connection) => Self {
                connection: Some(Mutex::new(connection)),
                warning: None,
            },
            Err(error) => Self {
                connection: None,
                warning: Some(format!(
                    "Downloaded lyrics cannot be saved between sessions: {error}"
                )),
            },
        }
    }

    fn try_open() -> Result<Connection, String> {
        let path = settings::data_path(DATABASE_FILE)?;
        let connection = Connection::open(&path).map_err(|error| error.to_string())?;
        // WAL keeps a reader from blocking the writer; the lookup task and the
        // interface both touch this connection through the same mutex, but the
        // journal still outlives a hard power loss more gracefully.
        let _ = connection.pragma_update(None, "journal_mode", "WAL");
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS lyrics (
                     track_key   TEXT NOT NULL,
                     requested   TEXT NOT NULL,
                     track_name  TEXT NOT NULL DEFAULT '',
                     artist      TEXT NOT NULL DEFAULT '',
                     source      TEXT NOT NULL DEFAULT '',
                     synced      INTEGER NOT NULL DEFAULT 0,
                     text        TEXT NOT NULL DEFAULT '',
                     cues        TEXT NOT NULL DEFAULT '[]',
                     fetched_at  INTEGER NOT NULL DEFAULT 0,
                     PRIMARY KEY (track_key, requested)
                 );
                 CREATE TABLE IF NOT EXISTS track_source (
                     track_key TEXT PRIMARY KEY,
                     source    TEXT NOT NULL
                 );",
            )
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    /// Set when persistence is unavailable, so the interface can say so once
    /// instead of quietly losing every download.
    pub fn warning(&self) -> Option<&str> {
        self.warning.as_deref()
    }

    fn with<T>(&self, body: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> Option<T> {
        let guard = self.connection.as_ref()?.lock().ok()?;
        // A failing query is a broken cache, never a broken app: the caller
        // treats `None` as a miss and goes to the network.
        body(&guard).ok()
    }

    /// Cached lyrics for this track under this request ("" for the normal
    /// lookup order, otherwise a provider id).
    pub fn lyrics(&self, track_key: &str, requested: &str) -> Option<LyricsResult> {
        let row = self.with(|connection| {
            connection
                .query_row(
                    "SELECT source, text, cues, fetched_at FROM lyrics
                     WHERE track_key = ?1 AND requested = ?2",
                    params![track_key, requested],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    },
                )
                .optional()
        })??;

        let (source, text, cues, fetched_at) = row;
        if now_seconds().saturating_sub(fetched_at) > MAX_AGE_SECONDS {
            return None;
        }
        Some(LyricsResult {
            text,
            source,
            cues: serde_json::from_str::<Vec<Cue>>(&cues).unwrap_or_default(),
            errors: Vec::new(),
        })
    }

    /// Remember a successful lookup. Empty results are not stored, so a source
    /// that was merely unreachable gets another chance next time.
    pub fn save_lyrics(
        &self,
        track_key: &str,
        requested: &str,
        track: TrackInfo<'_>,
        result: &LyricsResult,
    ) {
        if result.is_empty() {
            return;
        }
        let cues = serde_json::to_string(&result.cues).unwrap_or_else(|_| "[]".into());
        self.with(|connection| {
            connection.execute(
                "INSERT INTO lyrics
                     (track_key, requested, track_name, artist, source, synced, text, cues, fetched_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(track_key, requested) DO UPDATE SET
                     track_name = excluded.track_name,
                     artist     = excluded.artist,
                     source     = excluded.source,
                     synced     = excluded.synced,
                     text       = excluded.text,
                     cues       = excluded.cues,
                     fetched_at = excluded.fetched_at",
                params![
                    track_key,
                    requested,
                    track.name,
                    track.artist,
                    result.source,
                    i64::from(!result.cues.is_empty()),
                    result.text,
                    cues,
                    now_seconds(),
                ],
            )
        });
    }

    /// Drop every cached answer for one track, whichever source produced it.
    pub fn forget(&self, track_key: &str) {
        self.with(|connection| {
            connection.execute(
                "DELETE FROM lyrics WHERE track_key = ?1",
                params![track_key],
            )
        });
    }

    /// The source this track is pinned to, or `None` for the normal order.
    pub fn preferred_source(&self, track_key: &str) -> Option<String> {
        let stored: Option<String> = self.with(|connection| {
            connection
                .query_row(
                    "SELECT source FROM track_source WHERE track_key = ?1",
                    params![track_key],
                    |row| row.get(0),
                )
                .optional()
        })?;
        // A pin on a provider this build no longer has is not a pin.
        stored.filter(|id| settings::provider_label(id).is_some())
    }

    /// Pin this track to one source, or clear the pin with `None`.
    pub fn set_preferred_source(
        &self,
        track_key: &str,
        source: Option<&str>,
    ) -> Result<(), String> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| {
                self.warning
                    .clone()
                    .unwrap_or_else(|| "Lyrics storage is unavailable".into())
            })?
            .lock()
            .map_err(|error| error.to_string())?;
        match source {
            Some(source) => connection.execute(
                "INSERT INTO track_source (track_key, source) VALUES (?1, ?2)
                         ON CONFLICT(track_key) DO UPDATE SET source = excluded.source",
                params![track_key, source],
            ),
            None => connection.execute(
                "DELETE FROM track_source WHERE track_key = ?1",
                params![track_key],
            ),
        }
        .map(|_| ())
        .map_err(|error| error.to_string())
    }

    /// How many songs have lyrics on disk — shown in the settings panel so the
    /// cache is visible rather than a mystery file.
    pub fn stored_track_count(&self) -> i64 {
        self.with(|connection| {
            connection.query_row("SELECT COUNT(DISTINCT track_key) FROM lyrics", [], |row| {
                row.get(0)
            })
        })
        .unwrap_or(0)
    }

    /// Empty the lyrics cache, keeping the per-track source choices.
    pub fn clear_lyrics(&self) {
        self.with(|connection| connection.execute("DELETE FROM lyrics", []));
    }
}

fn now_seconds() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::tests::with_temp_data_dir;

    fn sample() -> LyricsResult {
        LyricsResult {
            text: "LINE_A\nLINE_B".into(),
            source: "LRCLIB".into(),
            cues: vec![
                Cue {
                    time_ms: 1000,
                    text: "LINE_A".into(),
                },
                Cue {
                    time_ms: 2000,
                    text: "LINE_B".into(),
                },
            ],
            errors: vec!["NetEase: Http".into()],
        }
    }

    const TRACK: TrackInfo<'static> = TrackInfo {
        name: "Title",
        artist: "Artist",
    };

    #[test]
    fn lyrics_survive_reopening_the_database() {
        with_temp_data_dir(|_| {
            {
                let db = Db::open();
                assert!(
                    db.warning().is_none(),
                    "a writable folder must open cleanly"
                );
                db.save_lyrics("track-1", AUTO, TRACK, &sample());
            }
            // A second `open` is a new process as far as SQLite is concerned.
            let db = Db::open();
            let stored = db.lyrics("track-1", AUTO).expect("cached across sessions");
            assert_eq!(stored.source, "LRCLIB");
            assert_eq!(stored.cues.len(), 2);
            assert_eq!(stored.cues[1].time_ms, 2000);
            // Errors belong to one lookup attempt, not to the cached lyrics.
            assert!(stored.errors.is_empty());
            assert_eq!(db.stored_track_count(), 1);
        });
    }

    #[test]
    fn each_requested_source_is_cached_separately() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &sample());
            let mut netease = sample();
            netease.source = "NetEase".into();
            db.save_lyrics("track-1", "netease", TRACK, &netease);

            assert_eq!(db.lyrics("track-1", AUTO).unwrap().source, "LRCLIB");
            assert_eq!(db.lyrics("track-1", "netease").unwrap().source, "NetEase");
            assert!(db.lyrics("track-1", "qqmusic").is_none());
            assert_eq!(db.stored_track_count(), 1, "one song, two cached answers");
        });
    }

    #[test]
    fn source_preferences_and_order_specific_cache_survive_restart() {
        with_temp_data_dir(|folder| {
            {
                let db = Db::open();
                db.set_preferred_source("track-1", Some("netease")).unwrap();
                db.save_lyrics("track-1", "auto:lrclib,netease", TRACK, &sample());
            }
            assert!(folder.join(DATABASE_FILE).is_file());
            let db = Db::open();
            assert_eq!(db.preferred_source("track-1").as_deref(), Some("netease"));
            assert!(db.lyrics("track-1", "auto:lrclib,netease").is_some());
            assert!(db.lyrics("track-1", "auto:netease,lrclib").is_none());
        });
    }

    #[test]
    fn an_unwritable_database_reports_failure_to_save_a_preference() {
        with_temp_data_dir(|folder| {
            std::fs::create_dir(folder.join(DATABASE_FILE)).unwrap();
            let db = Db::open();
            assert!(db.warning().is_some());
            assert!(db.set_preferred_source("track-1", Some("lrclib")).is_err());
        });
    }

    #[test]
    fn saving_the_same_track_twice_replaces_rather_than_fails() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &sample());
            let mut second = sample();
            second.source = "PetitLyrics".into();
            second.text = "LINE_C".into();
            db.save_lyrics("track-1", AUTO, TRACK, &second);

            let stored = db.lyrics("track-1", AUTO).unwrap();
            assert_eq!(stored.source, "PetitLyrics");
            assert_eq!(stored.text, "LINE_C");
        });
    }

    /// An empty answer means "nobody had it right now", which must not be
    /// remembered as fact.
    #[test]
    fn empty_results_are_not_cached() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &LyricsResult::empty("LRCLIB"));
            assert!(db.lyrics("track-1", AUTO).is_none());
        });
    }

    #[test]
    fn forget_removes_every_cached_source_for_one_track() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &sample());
            db.save_lyrics("track-1", "netease", TRACK, &sample());
            db.save_lyrics("track-2", AUTO, TRACK, &sample());

            db.forget("track-1");
            assert!(db.lyrics("track-1", AUTO).is_none());
            assert!(db.lyrics("track-1", "netease").is_none());
            assert!(
                db.lyrics("track-2", AUTO).is_some(),
                "other tracks are untouched"
            );
        });
    }

    #[test]
    fn stale_rows_are_treated_as_a_miss() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &sample());
            db.with(|connection| {
                connection.execute(
                    "UPDATE lyrics SET fetched_at = ?1",
                    params![now_seconds() - MAX_AGE_SECONDS - 1],
                )
            })
            .unwrap();
            assert!(db.lyrics("track-1", AUTO).is_none());
        });
    }

    #[test]
    fn a_track_can_be_pinned_to_one_source_and_unpinned_again() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            assert_eq!(db.preferred_source("track-1"), None);

            db.set_preferred_source("track-1", Some("netease")).unwrap();
            assert_eq!(db.preferred_source("track-1").as_deref(), Some("netease"));

            db.set_preferred_source("track-1", Some("qqmusic")).unwrap();
            assert_eq!(db.preferred_source("track-1").as_deref(), Some("qqmusic"));

            db.set_preferred_source("track-1", None).unwrap();
            assert_eq!(db.preferred_source("track-1"), None);
        });
    }

    /// A settings file may name a provider a later build dropped; the pin is
    /// then meaningless and must not be handed to the lookup as an id.
    #[test]
    fn a_pin_on_an_unknown_provider_is_ignored() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.set_preferred_source("track-1", Some("ghost")).unwrap();
            assert_eq!(db.preferred_source("track-1"), None);
        });
    }

    #[test]
    fn clearing_the_cache_keeps_the_pinned_sources() {
        with_temp_data_dir(|_| {
            let db = Db::open();
            db.save_lyrics("track-1", AUTO, TRACK, &sample());
            db.set_preferred_source("track-1", Some("netease")).unwrap();

            db.clear_lyrics();
            assert_eq!(db.stored_track_count(), 0);
            assert_eq!(db.preferred_source("track-1").as_deref(), Some("netease"));
        });
    }
}
