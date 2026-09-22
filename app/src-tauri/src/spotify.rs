//! Spotify Web API client: Authorization Code with PKCE, playback state, transport control.
//!
//! Endpoints and scopes verified against the official Web API reference:
//! https://developer.spotify.com/documentation/web-api/reference/get-information-about-the-users-current-playback
//! https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback
//! https://developer.spotify.com/documentation/web-api/reference/seek-to-position-in-currently-playing-track
//!
//! The redirect URI must use the literal loopback address: Spotify disallows
//! `localhost` for new authorizations, so `http://127.0.0.1:8787/callback` it is.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::Duration;

use base64::Engine;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::player::{Playback, PlayerError, PlayerKind};
use crate::token_store;

const REDIRECT_URI: &str = "http://127.0.0.1:8787/callback";
const CALLBACK_ADDRESS: &str = "127.0.0.1:8787";
/// Playback control needs `user-modify-playback-state`; adding it invalidates any
/// refresh token minted before, so the user authorizes once more after upgrading.
const SCOPES: &str =
    "user-read-currently-playing user-read-playback-state user-modify-playback-state";
const AUTHORIZE_URL: &str = "https://accounts.spotify.com/authorize";
const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";
const API_BASE: &str = "https://api.spotify.com/v1";
/// The browser tab is opened by us; if nobody completes the form, stop waiting.
const AUTH_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Debug, thiserror::Error)]
pub enum SpotifyError {
    /// The cached session is gone or rejected: the user has to authorize again.
    #[error("Spotify authorization is required")]
    LoginRequired,
    #[error("{0}")]
    Config(String),
    #[error("{0}")]
    Network(String),
    /// Spotify said no, with its own wording — including the Premium refusal,
    /// whose exact text is not documented, so it is passed through as received.
    #[error("{message}")]
    Refused { status: u16, message: String },
    #[error("Spotify rate limit")]
    RateLimited { retry_after: u64 },
}

impl From<reqwest::Error> for SpotifyError {
    fn from(error: reqwest::Error) -> Self {
        if error.is_timeout() {
            SpotifyError::Network("Spotify did not respond in time".into())
        } else {
            SpotifyError::Network("Spotify is unreachable".into())
        }
    }
}

impl From<SpotifyError> for PlayerError {
    fn from(error: SpotifyError) -> Self {
        match error {
            SpotifyError::LoginRequired => PlayerError::NeedsAuth,
            SpotifyError::Config(message) => PlayerError::Config(message),
            SpotifyError::Network(message) => PlayerError::Network(message),
            // The status is dropped: nothing downstream branches on it, and the
            // message is Spotify's own wording, which is what gets shown.
            SpotifyError::Refused { message, .. } => PlayerError::Refused { message },
            SpotifyError::RateLimited { retry_after } => PlayerError::RateLimited { retry_after },
        }
    }
}

fn base64_url(bytes: &[u8]) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn pkce_pair() -> (String, String) {
    let mut raw = [0u8; 64];
    rand::fill(&mut raw);
    let verifier = base64_url(&raw);
    let challenge = base64_url(&Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub struct Spotify {
    client_id: String,
    http: reqwest::Client,
    access_token: RwLock<String>,
    refresh_token: RwLock<Option<String>>,
    /// Non-fatal note shown in the interface, e.g. the session could not be cached.
    cache_warning: RwLock<String>,
    /// The scopes Spotify says this token carries, when it says so at all.
    granted_scopes: RwLock<Option<String>>,
}

impl Spotify {
    pub fn new(client_id: String) -> Result<Self, SpotifyError> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| SpotifyError::Network("Cannot start the HTTPS client".into()))?;
        Ok(Self {
            client_id,
            http,
            access_token: RwLock::new(String::new()),
            refresh_token: RwLock::new(None),
            cache_warning: RwLock::new(String::new()),
            granted_scopes: RwLock::new(None),
        })
    }

    pub async fn cache_warning(&self) -> String {
        self.cache_warning.read().await.clone()
    }

    /// Whether the current token may control playback.
    ///
    /// A refresh token minted before `user-modify-playback-state` was requested
    /// still refreshes successfully, but every transport call would fail with a
    /// 403 the user cannot act on. When Spotify tells us the granted scopes, an
    /// upgrade is detected here instead; when it does not, we assume the token is
    /// fine rather than forcing a needless sign-in.
    async fn has_control_scope(&self) -> bool {
        match self.granted_scopes.read().await.as_deref() {
            Some(granted) => granted
                .split_whitespace()
                .any(|scope| scope == "user-modify-playback-state"),
            None => true,
        }
    }

    /// Reuse the stored refresh token when possible; only a missing or rejected
    /// one sends the user back to the browser.
    pub async fn connect_session(&self) -> Result<bool, SpotifyError> {
        let cached = token_store::load_refresh_token(&self.client_id);
        if let Some(token) = cached {
            *self.refresh_token.write().await = Some(token);
            match self.refresh().await {
                Ok(()) => return Ok(!self.has_control_scope().await),
                Err(SpotifyError::LoginRequired) => {
                    // Only an explicit rejection clears the cache; a network blip must not.
                    token_store::clear_refresh_token();
                    *self.refresh_token.write().await = None;
                    *self.granted_scopes.write().await = None;
                }
                Err(other) => return Err(other),
            }
        }
        Ok(true)
    }

    /// Build the URL the user has to open, and the state/verifier to check it against.
    pub fn authorization_request(&self) -> (String, String, String) {
        let (verifier, challenge) = pkce_pair();
        let state = base64_url(&{
            let mut raw = [0u8; 24];
            rand::fill(&mut raw);
            raw
        });
        let query = [
            ("client_id", self.client_id.as_str()),
            ("response_type", "code"),
            ("redirect_uri", REDIRECT_URI),
            ("code_challenge_method", "S256"),
            ("code_challenge", challenge.as_str()),
            ("scope", SCOPES),
            ("state", state.as_str()),
        ]
        .iter()
        .map(|(key, value)| format!("{key}={}", urlencoding::encode(value)))
        .collect::<Vec<_>>()
        .join("&");
        (format!("{AUTHORIZE_URL}?{query}"), verifier, state)
    }

    /// Wait on the loopback callback, then trade the code for tokens.
    pub async fn complete_authorization(
        &self,
        verifier: String,
        state: String,
    ) -> Result<(), SpotifyError> {
        let code = tokio::task::spawn_blocking(move || wait_for_callback(&state))
            .await
            .map_err(|_| SpotifyError::Network("Authorization was interrupted".into()))??;

        let form = [
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", self.client_id.as_str()),
            ("code_verifier", verifier.as_str()),
        ];
        let data = self.post_token(&form).await?;
        self.accept_token(&data).await;
        Ok(())
    }

    async fn refresh(&self) -> Result<(), SpotifyError> {
        let token = self
            .refresh_token
            .read()
            .await
            .clone()
            .ok_or(SpotifyError::LoginRequired)?;
        let form = [
            ("grant_type", "refresh_token"),
            ("refresh_token", token.as_str()),
            ("client_id", self.client_id.as_str()),
        ];
        let data = self.post_token(&form).await?;
        self.accept_token(&data).await;
        Ok(())
    }

    async fn post_token(&self, form: &[(&str, &str)]) -> Result<Value, SpotifyError> {
        let response = self.http.post(TOKEN_URL).form(form).send().await?;
        let status = response.status();
        let body: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        // `invalid_grant` is Spotify saying this refresh token is finished.
        let error = body.get("error").and_then(Value::as_str).unwrap_or("");
        if error == "invalid_grant" || status == reqwest::StatusCode::BAD_REQUEST {
            return Err(SpotifyError::LoginRequired);
        }
        Err(SpotifyError::Network(format!(
            "Spotify refused the sign-in ({})",
            status.as_u16()
        )))
    }

    async fn accept_token(&self, data: &Value) {
        if let Some(access) = data.get("access_token").and_then(Value::as_str) {
            *self.access_token.write().await = access.to_string();
        }
        // Optional in the OAuth response; absence means "unchanged", not "none".
        if let Some(scope) = data.get("scope").and_then(Value::as_str) {
            *self.granted_scopes.write().await = Some(scope.to_string());
        }
        // Spotify rotates refresh tokens; store whichever one came back.
        if let Some(refreshed) = data.get("refresh_token").and_then(Value::as_str) {
            *self.refresh_token.write().await = Some(refreshed.to_string());
            match token_store::save_refresh_token(&self.client_id, refreshed) {
                Ok(()) => self.cache_warning.write().await.clear(),
                Err(_) => {
                    *self.cache_warning.write().await =
                        "The sign-in could not be saved; you may need to authorize again next time."
                            .to_string();
                }
            }
        }
    }

    /// One authenticated call, retrying once after refreshing an expired token.
    async fn call(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
    ) -> Result<Option<Value>, SpotifyError> {
        for attempt in 0..2 {
            let token = self.access_token.read().await.clone();
            let response = self
                .http
                .request(method.clone(), format!("{API_BASE}{path}"))
                .bearer_auth(token)
                .query(query)
                .header("Content-Length", "0")
                .send()
                .await?;
            let status = response.status();

            if status == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                self.refresh().await?;
                continue;
            }
            if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                let retry_after = response
                    .headers()
                    .get("Retry-After")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(10);
                return Err(SpotifyError::RateLimited { retry_after });
            }
            if status == reqwest::StatusCode::NO_CONTENT {
                return Ok(None);
            }
            if status.is_success() {
                let body = response.bytes().await?;
                if body.is_empty() {
                    return Ok(None);
                }
                return Ok(serde_json::from_slice(&body).ok());
            }

            let body: Value = response.json().await.unwrap_or(Value::Null);
            let message = body
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("Spotify rejected the request")
                .to_string();
            return Err(SpotifyError::Refused {
                status: status.as_u16(),
                message,
            });
        }
        Err(SpotifyError::LoginRequired)
    }

    /// Full player state: richer than `/currently-playing`, and it reports which
    /// transport actions Spotify will currently accept.
    pub async fn playback(&self) -> Result<Playback, SpotifyError> {
        let Some(data) = self.call(reqwest::Method::GET, "/me/player", &[]).await? else {
            return Ok(Playback::default());
        };

        let item = data.get("item").cloned().unwrap_or(Value::Null);
        let is_track = item
            .get("type")
            .and_then(Value::as_str)
            .map(|kind| kind == "track")
            .unwrap_or(item.is_object());
        if !is_track {
            return Ok(Playback::default());
        }

        let album = item.get("album").cloned().unwrap_or(Value::Null);
        // Spotify lists album images widest first; the second one is plenty for a blur.
        let album_art = album
            .get("images")
            .and_then(Value::as_array)
            .and_then(|images| images.first())
            .and_then(|image| image.get("url"))
            .and_then(Value::as_str)
            .map(str::to_string);

        let disallows = data
            .get("actions")
            .and_then(|actions| actions.get("disallows"))
            .cloned()
            .unwrap_or(Value::Null);
        let allowed = |key: &str| !disallows.get(key).and_then(Value::as_bool).unwrap_or(false);

        Ok(Playback {
            track_id: item
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            name: item
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            artists: item
                .get("artists")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|artist| artist.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            album: album
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            album_art,
            duration_ms: item.get("duration_ms").and_then(Value::as_i64).unwrap_or(0),
            progress_ms: data.get("progress_ms").and_then(Value::as_i64),
            is_playing: data
                .get("is_playing")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            has_track: true,
            can_skip_next: allowed("skipping_next"),
            can_skip_previous: allowed("skipping_prev"),
            can_seek: allowed("seeking"),
            device_name: data
                .get("device")
                .and_then(|device| device.get("name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            source: PlayerKind::Spotify,
        })
    }

    pub async fn play(&self) -> Result<(), SpotifyError> {
        self.call(reqwest::Method::PUT, "/me/player/play", &[])
            .await?;
        Ok(())
    }

    pub async fn pause(&self) -> Result<(), SpotifyError> {
        self.call(reqwest::Method::PUT, "/me/player/pause", &[])
            .await?;
        Ok(())
    }

    pub async fn next(&self) -> Result<(), SpotifyError> {
        self.call(reqwest::Method::POST, "/me/player/next", &[])
            .await?;
        Ok(())
    }

    pub async fn previous(&self) -> Result<(), SpotifyError> {
        self.call(reqwest::Method::POST, "/me/player/previous", &[])
            .await?;
        Ok(())
    }

    /// `position_ms` is a query parameter on this endpoint, not a body field.
    pub async fn seek(&self, position_ms: i64) -> Result<(), SpotifyError> {
        self.call(
            reqwest::Method::PUT,
            "/me/player/seek",
            &[("position_ms", position_ms.max(0).to_string())],
        )
        .await?;
        Ok(())
    }
}

/// Serve exactly one loopback request and return the authorization code.
fn wait_for_callback(expected_state: &str) -> Result<String, SpotifyError> {
    let listener = TcpListener::bind(CALLBACK_ADDRESS).map_err(|_| {
        SpotifyError::Config(format!(
            "Cannot listen on {CALLBACK_ADDRESS}. Close whatever is using that port and retry."
        ))
    })?;
    listener
        .set_nonblocking(false)
        .map_err(|_| SpotifyError::Network("Cannot accept the sign-in callback".into()))?;

    let deadline = std::time::Instant::now() + AUTH_TIMEOUT;
    for incoming in listener.incoming() {
        if std::time::Instant::now() > deadline {
            break;
        }
        let Ok(mut stream) = incoming else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));

        let Some(target) = read_request_target(&stream) else {
            respond(&mut stream, "Sign-in failed. You can close this tab.");
            continue;
        };
        let Some((path, query)) = target.split_once('?') else {
            respond(&mut stream, "Sign-in failed. You can close this tab.");
            continue;
        };
        if path != "/callback" {
            respond(&mut stream, "Not found.");
            continue;
        }

        let mut code = None;
        let mut state = None;
        let mut error = None;
        for pair in query.split('&') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let value = urlencoding::decode(value).unwrap_or_default().into_owned();
            match key {
                "code" => code = Some(value),
                "state" => state = Some(value),
                "error" => error = Some(value),
                _ => {}
            }
        }

        if let Some(error) = error {
            respond(
                &mut stream,
                "Sign-in was cancelled. You can close this tab.",
            );
            return Err(SpotifyError::Config(format!("Spotify returned: {error}")));
        }
        // A mismatched state means this callback did not come from our request.
        if state.as_deref() != Some(expected_state) {
            respond(&mut stream, "Sign-in failed. You can close this tab.");
            continue;
        }
        if let Some(code) = code {
            respond(&mut stream, "Signed in. You can close this tab.");
            return Ok(code);
        }
        respond(&mut stream, "Sign-in failed. You can close this tab.");
    }
    Err(SpotifyError::Network("Sign-in timed out".into()))
}

fn read_request_target(stream: &TcpStream) -> Option<String> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    // Bound the request line; a browser redirect is never long.
    if reader.by_ref().take(8192).read_line(&mut line).ok()? == 0 {
        return None;
    }
    line.split_whitespace().nth(1).map(str::to_string)
}

fn respond(stream: &mut TcpStream, message: &str) {
    let body = format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Hakuro</title>\
         <style>body{{background:#121212;color:#e8e8e8;font-family:system-ui,sans-serif;\
         display:grid;place-items:center;height:100vh;margin:0}}</style></head>\
         <body><p>{message}</p></body></html>"
    );
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_the_sha256_of_the_verifier() {
        let (verifier, challenge) = pkce_pair();
        // RFC 7636 requires 43..128 characters for the verifier.
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert_eq!(challenge, base64_url(&Sha256::digest(verifier.as_bytes())));
        assert!(!challenge.contains('=') && !challenge.contains('+') && !challenge.contains('/'));
    }

    #[test]
    fn every_authorization_request_is_unique() {
        let spotify = Spotify::new("dummyclientid".into()).unwrap();
        let (first_url, first_verifier, first_state) = spotify.authorization_request();
        let (_, second_verifier, second_state) = spotify.authorization_request();
        assert_ne!(first_verifier, second_verifier);
        assert_ne!(first_state, second_state);
        assert!(first_url.starts_with(AUTHORIZE_URL));
        assert!(first_url.contains("code_challenge_method=S256"));
        // The loopback literal, not "localhost", which Spotify no longer accepts.
        assert!(first_url.contains("127.0.0.1%3A8787%2Fcallback"));
        assert!(first_url.contains("user-modify-playback-state"));
        assert!(first_url.contains(&format!("state={first_state}")));
    }
}
