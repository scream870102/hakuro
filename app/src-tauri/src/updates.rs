//! Optional startup update. The release feed and the signed installer are public
//! GitHub release assets; the installer is downloaded in the background and only
//! installed when the user restarts from the notification or closes Hakuro.

use std::time::Duration;

use semver::Version;
use tauri::utils::{config::BundleType, platform::bundle_type};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

pub const RELEASE_URL: &str = "https://github.com/scream870102/hakuro/releases/latest";

/// A newer release whose installer has been downloaded and its signature verified.
pub struct Ready {
    update: Update,
    bytes: Vec<u8>,
}

impl Ready {
    pub fn version(&self) -> &str {
        &self.update.version
    }

    /// On Windows this runs the installer and exits Hakuro, so it only returns on failure.
    pub fn install(&self, restart: bool) -> Result<(), String> {
        self.update
            .clone()
            .restart_after_install(restart)
            .install(&self.bytes)
            .map_err(|error| error.to_string())
    }
}

fn is_newer(latest: &Version, current: &Version) -> bool {
    // Build metadata is not a newer release; never suggest a downgrade to a local build.
    latest.pre.is_empty() && latest.cmp_precedence(current).is_gt()
}

pub enum Found {
    Ready(Ready),
    /// A portable or development build only links to the release page: the
    /// installer would add a second, installed copy instead of replacing it.
    Manual(String),
}

pub async fn find(app: &AppHandle) -> Option<Found> {
    let mut update = app
        .updater_builder()
        .version_comparator(|current, release| is_newer(&release.version, &current))
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?
        .check()
        .await
        .ok()??;
    if bundle_type() != Some(BundleType::Nsis) {
        return Some(Found::Manual(update.version));
    }
    // The check's timeout covers a whole request, which would cut a slow installer off.
    update.timeout = None;
    let bytes = update.download(|_, _| {}, || {}).await.ok()?;
    Some(Found::Ready(Ready { update, bytes }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_stable_versions_update() {
        let current = Version::parse("1.5.2").unwrap();
        for (latest, expected) in [
            ("1.5.3", true),
            ("1.10.0", true),
            ("2.0.0", true),
            ("1.5.2", false),
            ("1.5.1", false),
            ("1.5.2+build.9", false),
            ("2.0.0-rc.1", false),
        ] {
            assert_eq!(
                is_newer(&Version::parse(latest).unwrap(), &current),
                expected,
                "{latest}"
            );
        }
    }
}
