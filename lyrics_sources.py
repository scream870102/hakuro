"""Bounded public lyric lookups; no credentials or audio downloads.

Schemas verified against https://lrclib.net/docs and source implementations:
https://gist.github.com/strategist922/2995321a3ae170bd1f95d69c329287d8
https://gist.github.com/zengkid/68c455a860f29f215036be19171f0d6f
https://github.com/CharlesPikachu/musicdl/blob/master/musicdl/modules/sources/qq.py
NetEase and QQ Music are unofficial public endpoints and can change/block access.
"""
import base64
from dataclasses import dataclass
import html
import json
import re
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from opencc import OpenCC

# Pure-Python OpenCC: https://github.com/yichen0831/opencc-python
# Package its config/ and dictionary/ data with PyInstaller --collect-data opencc.
_CHINESE_MATCH = OpenCC("t2s")


@dataclass
class LyricsResult:
    text: str
    source: str
    cues: list[tuple[int, str]]
    errors: tuple[str, ...] = ()


_STAMP = re.compile(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]")
_META = re.compile(r"\[(?:ar|ti|al|by|re|ve|length|offset):[^\]]*\]", re.I)


def parse_lrc(text: str) -> list[tuple[int, str]]:
    """Positive LRC offset advances lyrics, so subtract it from cue times."""
    offsets = re.findall(r"\[offset:([+-]?\d+)\]", text, re.I)
    offset = int(offsets[-1]) if offsets else 0
    grouped = {}
    for line in html.unescape(text).splitlines():
        stamps = list(_STAMP.finditer(line))
        if not stamps:
            continue
        words = _META.sub("", _STAMP.sub("", line)).strip()
        for stamp in stamps:
            minute, second, fraction = stamp.groups()
            millis = (int(minute) * 60 + int(second)) * 1000 + int((fraction or "0").ljust(3, "0"))
            bucket = grouped.setdefault(max(0, millis - offset), [])
            if words and words not in bucket:
                bucket.append(words)
    return [(stamp, "\n".join(words)) for stamp, words in sorted(grouped.items())]


def _result(raw, source):
    raw = html.unescape(raw or "")
    cues = parse_lrc(raw)
    if not any(words for _, words in cues):
        cues = []
    text = "\n".join(words for _, words in cues) if cues else _META.sub("", _STAMP.sub("", raw)).strip()
    return LyricsResult(text, source, cues)


def _normal(value):
    # Keep version words (live/remix/etc.); fuzzy stripping can choose a wrong recording.
    normalized = unicodedata.normalize("NFKC", html.unescape(value)).casefold()
    return "".join(c for c in _CHINESE_MATCH.convert(normalized) if c.isalnum())


def _matches(track, artists, duration_ms, title, candidate_artists, candidate_ms):
    if not _normal(track) or _normal(track) != _normal(title or ""):
        return False
    wanted = {_normal(a) for a in artists if a}
    found = {_normal(a) for a in candidate_artists if a}
    if not wanted or not wanted.intersection(found):
        return False
    # Missing duration cannot establish the recording, and +/- 4 s matches LRCLIB's window.
    return bool(duration_ms and candidate_ms and abs(duration_ms - float(candidate_ms)) <= 4000)


def _json(url, params=None, referer=None, post=False):
    headers = {"User-Agent": "SpotifyOriginalLyrics/2.0", "Accept": "application/json"}
    if referer:
        headers["Referer"] = referer
    encoded = urllib.parse.urlencode(params or {})
    request = urllib.request.Request(url if post else url + ("?" + encoded if encoded else ""),
                                     data=encoded.encode() if post else None, headers=headers)
    with urllib.request.urlopen(request, timeout=6) as response:
        raw = response.read(2_000_001)
    if len(raw) > 2_000_000:
        raise ValueError("response too large")
    return json.loads(raw.decode("utf-8-sig"))


def _lrclib(track, artists, album, duration_ms):
    params = {"track_name": track, "artist_name": artists[0] if artists else "",
              "album_name": album, "duration": round(duration_ms / 1000)}
    try:
        data = _json("https://lrclib.net/api/get", params)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return LyricsResult("", "LRCLIB", [])
        raise
    # Exact endpoint already matches album/duration; still validate returned identity.
    if not _matches(track, artists, duration_ms, data.get("trackName"),
                    [data.get("artistName", "")], float(data.get("duration") or 0) * 1000):
        return LyricsResult("", "LRCLIB", [])
    synced = _result(data.get("syncedLyrics"), "LRCLIB")
    return synced if synced.cues else _result(data.get("plainLyrics") or data.get("syncedLyrics"), "LRCLIB")


def _netease(track, artists, album, duration_ms):
    data = _json("https://music.163.com/api/search/get/",
                 {"s": " ".join([track] + artists[:1]), "limit": 8, "type": 1, "offset": 0},
                 "https://music.163.com/", post=True)
    if data.get("code") != 200:
        raise ValueError("search rejected")
    candidates = data.get("result", {}).get("songs", [])
    candidates.sort(key=lambda s: _normal((s.get("album") or {}).get("name", "")) != _normal(album))
    for song in candidates:
        if _matches(track, artists, duration_ms, song.get("name"),
                    [a.get("name", "") for a in song.get("artists", [])], song.get("duration")):
            data = _json("https://music.163.com/api/song/lyric",
                         {"id": song["id"], "lv": -1, "tv": -1}, "https://music.163.com/")
            if data.get("code") != 200:
                raise ValueError("lyrics rejected")
            return _result((data.get("lrc") or {}).get("lyric"), "NetEase")
    return LyricsResult("", "NetEase", [])


def _qqmusic(track, artists, album, duration_ms):
    # new_json=1 currently empties this endpoint; use the verified legacy schema.
    data = _json("https://c.y.qq.com/soso/fcgi-bin/client_search_cp",
                 {"w": " ".join([track] + artists[:1]), "n": 8, "p": 1, "format": "json", "cr": 1},
                 "https://y.qq.com/")
    if data.get("code") != 0:
        raise ValueError("search rejected")
    candidates = data.get("data", {}).get("song", {}).get("list", [])
    candidates.sort(key=lambda s: _normal(s.get("albumname", "")) != _normal(album))
    for song in candidates:
        if _matches(track, artists, duration_ms, song.get("songname"),
                    [a.get("name", "") for a in song.get("singer", [])], float(song.get("interval") or 0) * 1000):
            data = _json("https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg",
                         {"songmid": song["songmid"], "g_tk": 5381, "format": "json", "platform": "yqq"},
                         "https://y.qq.com/portal/player.html")
            if data.get("code") != 0:
                raise ValueError("lyrics rejected")
            raw = base64.b64decode(data.get("lyric") or "", validate=True).decode("utf-8")
            return _result(raw, "QQ Music")
    return LyricsResult("", "QQ Music", [])


def fetch_lyrics(track: str, artists: list[str], album: str, duration_ms: int) -> LyricsResult:
    """First matched synchronized result wins; keep plain lyrics while trying backups."""
    errors = []
    fallback = LyricsResult("", "", [])
    for name, provider in (("LRCLIB", _lrclib), ("NetEase", _netease), ("QQ Music", _qqmusic)):
        try:
            result = provider(track, artists, album, duration_ms)
        except Exception as error:
            # Do not display provider responses or URLs (they can contain lyrics/metadata).
            errors.append(f"{name}: {type(error).__name__}")
            continue
        if result.cues:
            result.errors = tuple(errors)
            return result
        if result.text and not fallback.text:
            fallback = result
    fallback.errors = tuple(errors)
    return fallback
