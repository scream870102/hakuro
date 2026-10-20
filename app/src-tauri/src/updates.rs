//! Optional startup notification. Only the public release metadata is fetched.

use std::time::Duration;

use semver::Version;
use serde::Deserialize;

const LATEST_API: &str = "https://api.github.com/repos/scream870102/hakuro/releases/latest";
pub const RELEASE_URL: &str = "https://github.com/scream870102/hakuro/releases/latest";

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
}

fn newer_release(release: Release, current: &str) -> Option<String> {
    if release.draft || release.prerelease {
        return None;
    }
    let latest = Version::parse(
        release
            .tag_name
            .strip_prefix('v')
            .unwrap_or(&release.tag_name),
    )
    .ok()?;
    let current = Version::parse(current).ok()?;
    // Build metadata is not a newer release; never suggest a downgrade to a local build.
    (latest.pre.is_empty() && latest.cmp_precedence(&current).is_gt()).then(|| latest.to_string())
}

async fn fetch_latest(http: &reqwest::Client, url: &str, current: &str) -> Option<String> {
    // GitHub's latest endpoint excludes draft/prereleases and is public without a token.
    // https://docs.github.com/en/rest/releases/releases#get-the-latest-release
    let release = http
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", concat!("Hakuro/", env!("CARGO_PKG_VERSION")))
        .header("X-GitHub-Api-Version", "2026-03-10")
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .ok()?
        .error_for_status()
        .ok()?
        .json::<Release>()
        .await
        .ok()?;
    newer_release(release, current)
}

pub async fn check(http: &reqwest::Client, enabled: bool) -> Option<String> {
    if !enabled {
        return None;
    }
    fetch_latest(http, LATEST_API, env!("CARGO_PKG_VERSION")).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_newer_stable_versions_notify() {
        for (tag, expected) in [
            ("v1.5.3", Some("1.5.3")),
            ("v1.10.0", Some("1.10.0")),
            ("2.0.0", Some("2.0.0")),
            ("v1.5.2", None),
            ("v1.5.1", None),
            ("v1.5.2+build.9", None),
            ("v2.0.0-rc.1", None),
            ("not-a-version", None),
        ] {
            let release = Release {
                tag_name: tag.into(),
                draft: false,
                prerelease: false,
            };
            assert_eq!(
                newer_release(release, "1.5.2").as_deref(),
                expected,
                "{tag}"
            );
        }
        for (draft, prerelease) in [(true, false), (false, true)] {
            let release = Release {
                tag_name: "v2.0.0".into(),
                draft,
                prerelease,
            };
            assert!(newer_release(release, "1.5.2").is_none());
        }
    }

    #[tokio::test]
    async fn release_responses_and_failures_are_handled_without_interrupting_startup() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        for (status, body, expected) in [
            (
                "200 OK",
                r#"{"tag_name":"v1.6.0","draft":false,"prerelease":false}"#,
                Some("1.6.0"),
            ),
            ("200 OK", "invalid json", None),
            (
                "403 Forbidden",
                r#"{"message":"API rate limit exceeded"}"#,
                None,
            ),
            ("404 Not Found", "{}", None),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/latest", listener.local_addr().unwrap());
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap().to_lowercase();
                assert!(request.contains("user-agent: hakuro/"));
                assert!(!request.contains("authorization:"));
                write!(
                    stream,
                    "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            });
            let client = reqwest::Client::new();
            assert_eq!(
                fetch_latest(&client, &url, "1.5.2").await.as_deref(),
                expected
            );
            server.join().unwrap();
        }
        assert!(check(&reqwest::Client::new(), false).await.is_none());
    }
}
