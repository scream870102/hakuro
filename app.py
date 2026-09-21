import base64, hashlib, http.server, json, secrets, threading, time, tkinter as tk
from tkinter import messagebox, ttk
from pathlib import Path
import sys
import queue
from bisect import bisect_right
from lyrics_sources import fetch_lyrics, LyricsResult
import urllib.error, urllib.parse, urllib.request, webbrowser

try:
    import truststore
    truststore.inject_into_ssl()
    TRUSTSTORE_AVAILABLE = True
except ImportError:
    TRUSTSTORE_AVAILABLE = False

REDIRECT_URI = "http://127.0.0.1:8787/callback"
SCOPES = "user-read-currently-playing user-read-playback-state"
SPOTIFY_AUTHORIZE = "https://accounts.spotify.com/authorize"
SPOTIFY_TOKEN = "https://accounts.spotify.com/api/token"
SPOTIFY_NOW_PLAYING = "https://api.spotify.com/v1/me/player/currently-playing"
LRCLIB_URL = "https://lrclib.net/api/get"
POLL_SECONDS = 1.5

def read_client_id():
    # External config belongs beside the EXE, not in PyInstaller's temp folder.
    folder = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent
    path = folder / "secret.env"
    try:
        content = path.read_text(encoding="utf-8-sig")
    except OSError as error:
        raise ValueError(f"Cannot read {path}.\nPlace secret.env beside the app with SPOTIFY_CLIENT_ID=your_client_id.") from error
    values = []
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, line = line.split("=", 1)
            if key.strip() not in ("SPOTIFY_CLIENT_ID", "CLIENT_ID", "clientId"):
                continue
        value = line.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '\"'):
            value = value[1:-1]
        values.append(value)
    if len(values) != 1 or not values[0] or not values[0].isascii() or not values[0].isalnum():
        raise ValueError("secret.env must contain one Client ID: SPOTIFY_CLIENT_ID=your_client_id.\nUse the Client ID, not the client secret.")
    return values[0]

def pkce_pair():
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        p = urllib.parse.urlparse(self.path)
        if p.path != "/callback":
            self.send_error(404); return
        q = urllib.parse.parse_qs(p.query)
        self.server.code = q.get("code", [None])[0]
        self.server.error = q.get("error", [None])[0]
        body = b"<html><body><h2>Authorization received</h2><p>You can close this tab.</p></body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *_): pass

class CallbackServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    def __init__(self):
        super().__init__(("127.0.0.1", 8787), Handler)
        self.code = None
        self.error = None

class Spotify:
    def __init__(self, client_id):
        self.client_id = client_id
        self.access_token = None
        self.refresh_token = None

    def authorize(self):
        verifier, challenge = pkce_pair()
        server = CallbackServer()
        threading.Thread(target=server.handle_request, daemon=True).start()
        params = {
            "client_id": self.client_id, "response_type": "code",
            "redirect_uri": REDIRECT_URI, "scope": SCOPES,
            "code_challenge_method": "S256", "code_challenge": challenge
        }
        webbrowser.open(SPOTIFY_AUTHORIZE + "?" + urllib.parse.urlencode(params))
        deadline = time.time() + 180
        while time.time() < deadline and not (server.code or server.error):
            time.sleep(.2)
        server.server_close()
        if server.error:
            raise RuntimeError(f"Spotify authorization failed: {server.error}")
        if not server.code:
            raise RuntimeError("Spotify authorization timed out.")

        data = urllib.parse.urlencode({
            "client_id": self.client_id, "grant_type": "authorization_code",
            "code": server.code, "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier
        }).encode()
        req = urllib.request.Request(SPOTIFY_TOKEN, data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                token = json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Spotify token request failed ({e.code}): {e.read().decode(errors='replace')}") from e
        except Exception as e:
            raise RuntimeError(
                "HTTPS connection to Spotify failed.\n\n"
                "This app uses the Windows certificate store through truststore.\n\n"
                f"Original error: {e}"
            ) from e
        self.access_token = token["access_token"]
        self.refresh_token = token.get("refresh_token", self.refresh_token)

    def current(self):
        for attempt in range(2):
            req = urllib.request.Request(SPOTIFY_NOW_PLAYING,
                headers={"Authorization": f"Bearer {self.access_token}"})
            try:
                with urllib.request.urlopen(req, timeout=10) as response:
                    if response.status == 204:
                        return None
                    raw = response.read()
                    return json.loads(raw.decode()) if raw else None
            except urllib.error.HTTPError as error:
                if error.code != 401 or attempt or not self.refresh_token:
                    raise
                error.close()
                data = urllib.parse.urlencode({"grant_type": "refresh_token",
                    "refresh_token": self.refresh_token, "client_id": self.client_id}).encode()
                refresh = urllib.request.Request(SPOTIFY_TOKEN, data=data,
                    headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
                with urllib.request.urlopen(refresh, timeout=15) as response:
                    token = json.loads(response.read().decode())
                self.access_token = token["access_token"]
                self.refresh_token = token.get("refresh_token", self.refresh_token)


class PlaybackClock:
    def __init__(self):
        self.update(0, False, 0)

    def update(self, position, playing, duration, received=None):
        self.position = max(0, position or 0)
        self.playing = bool(playing) and position is not None
        self.duration = max(0, duration or 0)
        self.received = time.monotonic() if received is None else received

    def current(self, now=None):
        now = time.monotonic() if now is None else now
        # Stop extrapolating after five seconds without a fresh Spotify sample.
        elapsed = min(5, max(0, now - self.received)) * 1000 if self.playing else 0
        return min(self.duration, self.position + elapsed) if self.duration else 0

    def freeze(self):
        self.update(self.current(), False, self.duration)


def active_line(cues, position):
    return bisect_right(cues, position, key=lambda cue: cue[0]) - 1


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Spotify Original Lyrics")
        self.geometry("800x660")
        self.minsize(650, 450)
        self.spotify = None
        self.stop = threading.Event()
        self.events = queue.Queue()
        self.requests = queue.Queue(maxsize=1)
        self.last_id = None
        self.generation = 0
        self.cache = {}
        self.clock = PlaybackClock()
        self.cues = []
        self.cue_rows = []
        self.highlighted = -1
        self.status = tk.StringVar(value="Not connected")
        self.track = tk.StringVar(value="No track playing")
        self.artist = tk.StringVar()
        self.source = tk.StringVar(value="Sources: LRCLIB / NetEase / QQ Music")
        self.position = tk.StringVar(value="00:00 / 00:00")
        self.follow = tk.BooleanVar(value=True)
        self.build()
        threading.Thread(target=self.lyrics_worker, daemon=True).start()
        self.timer = self.after(100, self.tick)

    def build(self):
        frame = ttk.Frame(self, padding=14)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Spotify Original Lyrics", font=("Segoe UI", 18, "bold")).pack(anchor="w")
        ttk.Label(frame, text="Original lyrics with timed-line following when available.").pack(anchor="w", pady=(2, 10))
        bar = ttk.Frame(frame)
        bar.pack(fill="x", pady=(0, 12))
        self.connect_button = ttk.Button(bar, text="Connect Spotify", command=self.connect)
        self.connect_button.pack(side="left")
        ttk.Button(bar, text="Reload Lyrics", command=self.clear).pack(side="left", padx=8)
        ttk.Checkbutton(bar, text="Follow lyrics", variable=self.follow, command=self.follow_changed).pack(side="left")
        ttk.Label(bar, textvariable=self.status).pack(side="right")
        now = ttk.LabelFrame(frame, text="Now Playing", padding=10)
        now.pack(fill="x", pady=(0, 12))
        ttk.Label(now, textvariable=self.track, font=("Segoe UI", 14, "bold")).pack(anchor="w")
        ttk.Label(now, textvariable=self.artist, font=("Segoe UI", 11)).pack(anchor="w", pady=(3, 0))
        ttk.Label(now, textvariable=self.position).pack(anchor="e")
        lyrics_frame = ttk.LabelFrame(frame, text="Lyrics", padding=8)
        lyrics_frame.pack(fill="both", expand=True)
        self.text = tk.Text(lyrics_frame, wrap="word", font=("Segoe UI", 12), padx=12, pady=12, spacing3=8, state="disabled")
        self.text.tag_configure("current", background="#d8f5e4", foreground="#123c28")
        scrollbar = ttk.Scrollbar(lyrics_frame, orient="vertical", command=self.text.yview)
        self.text.configure(yscrollcommand=scrollbar.set)
        self.text.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")
        ttk.Label(frame, textvariable=self.source, wraplength=740).pack(anchor="w", pady=(7, 0))

    def set_text(self, text):
        self.text.config(state="normal")
        self.text.delete("1.0", "end")
        self.text.insert("1.0", text)
        self.text.config(state="disabled")
        self.highlighted = -1

    def connect(self):
        if not TRUSTSTORE_AVAILABLE:
            messagebox.showerror("Missing dependency", "The app is missing its HTTPS support. Please reinstall the complete app.")
            return
        try:
            client_id = read_client_id()
        except (ValueError, UnicodeError) as error:
            messagebox.showerror("Client ID configuration", str(error), parent=self)
            return
        self.connect_button.config(state="disabled")
        self.status.set("Opening Spotify authorization...")
        threading.Thread(target=self.auth, args=(client_id,), daemon=True).start()

    def auth(self, client_id):
        try:
            spotify = Spotify(client_id)
            spotify.authorize()
            self.events.put(("authorized", spotify))
        except Exception as error:
            self.events.put(("auth_error", str(error)))

    def poll(self):
        while not self.stop.is_set():
            delay = POLL_SECONDS
            try:
                data = self.spotify.current()
                self.events.put(("playback", data, time.monotonic()))
            except Exception as error:
                if isinstance(error, urllib.error.HTTPError) and error.code == 429:
                    try:
                        delay = max(POLL_SECONDS, float(error.headers.get("Retry-After", 10)))
                    except (ValueError, TypeError):
                        delay = 10
                    message = "Spotify rate limit; waiting before retry"
                else:
                    message = "Spotify unavailable; retrying (restart to reconnect if needed)"
                self.events.put(("playback_error", message))
            self.stop.wait(delay)

    def lyrics_worker(self):
        while not self.stop.is_set():
            try:
                generation, track_id, metadata = self.requests.get(timeout=.5)
            except queue.Empty:
                continue
            try:
                result = fetch_lyrics(*metadata)
            except Exception:
                result = LyricsResult(text="", source="", cues=[], errors=("Lyrics lookup failed",))
            self.events.put(("lyrics", generation, track_id, result))

    def apply_playback(self, data, received):
        item = (data or {}).get("item")
        if not item or item.get("type", "track") != "track":
            self.clock.update(0, False, 0, received)
            if self.last_id is not None:
                self.generation += 1
                self.last_id = None
                self.cues = []
                self.set_text("")
                self.source.set("Sources: LRCLIB / NetEase / QQ Music")
            self.track.set("No track playing")
            self.artist.set("")
            self.status.set("Connected / no track")
            return
        name = item.get("name", "")
        artists = [artist.get("name", "") for artist in item.get("artists", [])]
        album = (item.get("album") or {}).get("name", "")
        duration = item.get("duration_ms", 0)
        track_id = item.get("id") or item.get("uri") or (name, tuple(artists), duration)
        self.clock.update(data.get("progress_ms"), data.get("is_playing", False), duration, received)
        self.track.set(name)
        self.artist.set(", ".join(artists))
        self.status.set("Playing" if data.get("is_playing") else "Connected / paused")
        if track_id != self.last_id:
            self.last_id = track_id
            self.generation += 1
            self.cues = []
            self.set_text("Loading lyrics...")
            self.source.set("Searching LRCLIB / NetEase / QQ Music...")
            if track_id in self.cache:
                self.show_lyrics(self.generation, track_id, self.cache[track_id])
            else:
                # Only keep the newest pending song while the previous lookup finishes.
                try:
                    self.requests.get_nowait()
                except queue.Empty:
                    pass
                self.requests.put_nowait((self.generation, track_id, (name, artists, album, duration)))

    def show_lyrics(self, generation, track_id, result):
        if generation != self.generation or track_id != self.last_id:
            return
        if result.text or result.cues:
            if len(self.cache) >= 100:
                self.cache.pop(next(iter(self.cache)))
            self.cache[track_id] = result
        self.cues = result.cues
        self.cue_rows = []
        row = 1
        for _, text in self.cues:
            self.cue_rows.append((row, row + text.count("\n") + 1))
            row += text.count("\n") + 1
        self.set_text("\n".join(text for _, text in self.cues) if self.cues else (result.text or "Lyrics not found. Use Reload Lyrics to try again."))
        mode = "Synced lyrics" if self.cues else "Plain lyrics (no timeline)"
        label = f"Source: {result.source} | {mode}" if result.text or self.cues else "No matching lyrics found"
        if result.errors:
            label += " | Some sources unavailable"
        self.source.set(label)

    def follow_changed(self):
        self.highlighted = -1

    def tick(self):
        while True:
            try:
                event = self.events.get_nowait()
            except queue.Empty:
                break
            kind, *args = event
            if kind == "authorized":
                self.spotify = args[0]
                self.status.set("Connected")
                threading.Thread(target=self.poll, daemon=True).start()
            elif kind == "auth_error":
                self.connect_button.config(state="normal")
                self.status.set("Connection failed")
                messagebox.showerror("Spotify connection failed", args[0], parent=self)
            elif kind == "playback":
                self.apply_playback(*args)
            elif kind == "playback_error":
                self.clock.freeze()
                self.status.set(args[0])
            elif kind == "lyrics":
                self.show_lyrics(*args)
        position = self.clock.current()
        def stamp(ms):
            seconds = int(ms // 1000)
            return f"{seconds // 60:02d}:{seconds % 60:02d}"
        self.position.set(f"{stamp(position)} / {stamp(self.clock.duration)}")
        index = active_line(self.cues, position)
        if index != self.highlighted:
            self.text.tag_remove("current", "1.0", "end")
            if index >= 0:
                first, end = self.cue_rows[index]
                self.text.tag_add("current", f"{first}.0", f"{end}.0")
                if self.follow.get():
                    self.text.see(f"{first}.0")
            self.highlighted = index
        self.timer = self.after(100, self.tick)

    def clear(self):
        self.cache.pop(self.last_id, None)
        self.last_id = None
        self.generation += 1
        self.cues = []
        self.set_text("")
        self.source.set("Waiting for the next playback update...")

    def close(self):
        self.stop.set()
        self.after_cancel(self.timer)
        self.destroy()


if __name__ == "__main__":
    app = App()
    app.protocol("WM_DELETE_WINDOW", app.close)
    app.mainloop()
