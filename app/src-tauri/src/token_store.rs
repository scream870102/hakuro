//! Current-Windows-user DPAPI storage for a Spotify refresh token only.
//!
//! Ported from the Python `token_store`. Windows API signatures and ownership:
//! https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
//! https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
//! https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-localfree

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB, CryptProtectData, CryptUnprotectData,
};

/// An encrypted blob far larger than this is not something this app wrote.
const MAX_ENCRYPTED_BYTES: usize = 131_072;
const MAX_PAYLOAD_BYTES: usize = 65_536;

#[derive(Serialize, Deserialize)]
struct Session {
    client_id: String,
    refresh_token: String,
}

fn cache_path() -> Result<PathBuf, String> {
    let root = std::env::var_os("LOCALAPPDATA")
        .ok_or_else(|| "Local application storage is unavailable".to_string())?;
    Ok(PathBuf::from(root)
        .join("SpotifyOriginalLyrics")
        .join("session.bin"))
}

/// The stored blob is bound to both the Windows user and the client id, so a
/// different Spotify app cannot reuse a cached token.
fn entropy_bytes(client_id: &str) -> Vec<u8> {
    format!("SpotifyOriginalLyrics:{client_id}").into_bytes()
}

fn wipe(buffer: &mut [u8]) {
    for byte in buffer.iter_mut() {
        // Volatile so the zeroing is not optimized away.
        unsafe { std::ptr::write_volatile(byte, 0) };
    }
}

fn blob(data: &mut [u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: data.len() as u32,
        pbData: data.as_mut_ptr(),
    }
}

/// Copy the output blob into Rust memory, then clear and release the native one.
/// `CryptUnprotectData` hands back plaintext in a LocalAlloc buffer that the
/// caller owns.
unsafe fn take_output(output: CRYPT_INTEGER_BLOB, sensitive: bool) -> Vec<u8> {
    if output.pbData.is_null() {
        return Vec::new();
    }
    let length = output.cbData as usize;
    let copied = unsafe { std::slice::from_raw_parts(output.pbData, length) }.to_vec();
    if sensitive {
        for index in 0..length {
            unsafe { std::ptr::write_volatile(output.pbData.add(index), 0) };
        }
    }
    unsafe { LocalFree(Some(HLOCAL(output.pbData as *mut _))) };
    copied
}

fn protect(data: &mut [u8], client_id: &str, decrypt: bool) -> Result<Vec<u8>, String> {
    let mut entropy = entropy_bytes(client_id);
    let input = blob(data);
    let entropy_blob = blob(&mut entropy);
    let mut output = CRYPT_INTEGER_BLOB::default();

    // CRYPTPROTECT_UI_FORBIDDEN keeps this non-interactive; LOCAL_MACHINE (0x4)
    // is deliberately never set, so another Windows user cannot decrypt the file.
    let call = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy_blob),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                None,
                Some(&entropy_blob),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };

    let result = match call {
        Ok(()) => Ok(unsafe { take_output(output, decrypt) }),
        Err(error) => {
            unsafe { take_output(output, decrypt) };
            Err(error.message())
        }
    };
    wipe(data);
    result
}

/// Returns `None` whenever the cache is missing, unreadable, bound to another
/// client id, or written by a different Windows user — never an error, because
/// every one of those simply means "authorize again".
pub fn load_refresh_token(client_id: &str) -> Option<String> {
    let path = cache_path().ok()?;
    let mut encrypted = fs::read(path).ok()?;
    if encrypted.is_empty() || encrypted.len() > MAX_ENCRYPTED_BYTES {
        return None;
    }

    let mut decrypted = protect(&mut encrypted, client_id, true).ok()?;
    let session: Result<Session, _> = serde_json::from_slice(&decrypted);
    wipe(&mut decrypted);

    let session = session.ok()?;
    if session.client_id != client_id || session.refresh_token.is_empty() {
        return None;
    }
    Some(session.refresh_token)
}

pub fn save_refresh_token(client_id: &str, token: &str) -> Result<(), String> {
    if client_id.is_empty() || token.is_empty() {
        return Err("Client ID and refresh token are required".to_string());
    }

    let mut payload = serde_json::to_vec(&Session {
        client_id: client_id.to_string(),
        refresh_token: token.to_string(),
    })
    .map_err(|_| "Session data could not be encoded".to_string())?;
    if payload.len() > MAX_PAYLOAD_BYTES {
        wipe(&mut payload);
        return Err("Session data is too large".to_string());
    }

    let encrypted = protect(&mut payload, client_id, false)?;
    let path = cache_path()?;
    let parent = path
        .parent()
        .ok_or_else(|| "Local application storage is unavailable".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    // Write beside the target and rename, so an interrupted save never leaves a
    // half-written blob that would cost the user a re-authorization.
    let temporary = parent.join(format!("session-{}.tmp", std::process::id()));
    let write = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(&encrypted)?;
        file.sync_all()
    })();
    if let Err(error) = write {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    if let Err(error) = fs::rename(&temporary, &path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

/// Drop the cached session, e.g. after Spotify rejects the refresh token.
pub fn clear_refresh_token() {
    if let Ok(path) = cache_path() {
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs real DPAPI against a dummy token; it must never touch the user's
    /// actual cache, so the test redirects LOCALAPPDATA at a temp folder.
    fn with_temp_localappdata<T>(body: impl FnOnce() -> T) -> T {
        let previous = std::env::var_os("LOCALAPPDATA");
        let folder = std::env::temp_dir().join(format!("sol-test-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        unsafe { std::env::set_var("LOCALAPPDATA", &folder) };
        let outcome = body();
        match previous {
            Some(value) => unsafe { std::env::set_var("LOCALAPPDATA", value) },
            None => unsafe { std::env::remove_var("LOCALAPPDATA") },
        }
        let _ = std::fs::remove_dir_all(&folder);
        outcome
    }

    #[test]
    fn round_trips_and_binds_to_the_client_id() {
        with_temp_localappdata(|| {
            assert!(load_refresh_token("client-one").is_none());

            save_refresh_token("client-one", "dummy-refresh-token").unwrap();
            assert_eq!(
                load_refresh_token("client-one").as_deref(),
                Some("dummy-refresh-token")
            );

            // A different client id must not be able to read the blob.
            assert!(load_refresh_token("client-two").is_none());

            clear_refresh_token();
            assert!(load_refresh_token("client-one").is_none());
        });
    }

    #[test]
    fn rejects_empty_input() {
        assert!(save_refresh_token("", "token").is_err());
        assert!(save_refresh_token("client", "").is_err());
    }
}
