"""Current-Windows-user DPAPI storage for a Spotify refresh token only.

Windows API signatures and ownership:
https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
https://learn.microsoft.com/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata
https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-localfree
"""
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import tempfile


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _cache_path():
    root = os.environ.get("LOCALAPPDATA")
    if not root:
        raise OSError("Local application storage is unavailable")
    return Path(root) / "SpotifyOriginalLyrics" / "session.bin"


def _dpapi(data: bytes, client_id: str, *, decrypt=False) -> bytes:
    if os.name != "nt":
        raise OSError("Windows DPAPI is required")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    blob_pointer = ctypes.POINTER(_DataBlob)
    crypt32.CryptProtectData.argtypes = [blob_pointer, wintypes.LPCWSTR, blob_pointer,
                                        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [blob_pointer, ctypes.POINTER(wintypes.LPWSTR), blob_pointer,
                                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, blob_pointer]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    input_buffer = ctypes.create_string_buffer(data)
    entropy_bytes = ("SpotifyOriginalLyrics:" + client_id).encode("utf-8")
    entropy_buffer = ctypes.create_string_buffer(entropy_bytes)
    incoming = _DataBlob(len(data), ctypes.cast(input_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    entropy = _DataBlob(len(entropy_bytes), ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = _DataBlob()
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    # CRYPTPROTECT_UI_FORBIDDEN = 0x1; never set LOCAL_MACHINE (0x4).
    try:
        if not function(ctypes.byref(incoming), None, ctypes.byref(entropy), None, None,
                        0x1, ctypes.byref(outgoing)):
            raise ctypes.WinError(ctypes.get_last_error())
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        if outgoing.pbData:
            # Unprotect returns plaintext in native memory; clear it before LocalFree.
            if decrypt:
                ctypes.memset(outgoing.pbData, 0, outgoing.cbData)
            kernel32.LocalFree(ctypes.cast(outgoing.pbData, ctypes.c_void_p))
        ctypes.memset(input_buffer, 0, len(input_buffer))


def load_refresh_token(client_id: str) -> str | None:
    try:
        with _cache_path().open("rb") as stream:
            encrypted = stream.read(131073)
        if not encrypted or len(encrypted) > 131072:
            return None
        payload = json.loads(_dpapi(encrypted, client_id, decrypt=True).decode("utf-8"))
        if not isinstance(payload, dict) or payload.get("client_id") != client_id:
            return None
        token = payload.get("refresh_token")
        return token if isinstance(token, str) and token else None
    except (OSError, ValueError, TypeError):
        return None


def save_refresh_token(client_id: str, token: str) -> None:
    if not isinstance(client_id, str) or not client_id or not isinstance(token, str) or not token:
        raise ValueError("Client ID and refresh token are required")
    payload = json.dumps({"client_id": client_id, "refresh_token": token}, separators=(",", ":")).encode("utf-8")
    if len(payload) > 65536:
        raise ValueError("Session data is too large")
    encrypted = _dpapi(payload, client_id)
    path = _cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="wb", dir=path.parent, prefix="session-", suffix=".tmp", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encrypted)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
