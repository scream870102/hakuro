/**
 * Presentation layer. Every network call lives in Rust; this file renders what
 * the backend emits and extrapolates the position between polls so the current
 * line moves smoothly instead of stepping once every 1.5 s.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { activeLine, emptySample, formatTime, positionAt, type Sample } from "./clock";

interface Cue {
  time_ms: number;
  text: string;
}

interface PlaybackEvent {
  trackId: string;
  name: string;
  artists: string[];
  album: string;
  albumArt: string | null;
  durationMs: number;
  progressMs: number | null;
  isPlaying: boolean;
  hasTrack: boolean;
  canSkipNext: boolean;
  canSkipPrevious: boolean;
  canSeek: boolean;
  deviceName: string | null;
  generation: number;
}

interface LyricsEvent {
  generation: number;
  trackId: string;
  source: string;
  synced: boolean;
  cues: Cue[];
  text: string;
  partial: boolean;
}

interface StatusEvent {
  state: string;
  message: string;
  notice: string;
}

const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
};

const ui = {
  trackName: element("track-name"),
  trackArtist: element("track-artist"),
  albumArt: element<HTMLImageElement>("album-art"),
  backdropA: element("backdrop-a"),
  backdropB: element("backdrop-b"),
  sourceBadge: element("source-badge"),
  statusText: element("status-text"),
  lyrics: element("lyrics"),
  lyricsList: element<HTMLOListElement>("lyrics-list"),
  lyricsEmpty: element("lyrics-empty"),
  notice: element("notice"),
  scrubber: element("scrubber"),
  scrubberFill: element("scrubber-fill"),
  scrubberKnob: element("scrubber-knob"),
  timeCurrent: element("time-current"),
  timeTotal: element("time-total"),
  previous: element<HTMLButtonElement>("previous"),
  playPause: element<HTMLButtonElement>("play-pause"),
  next: element<HTMLButtonElement>("next"),
  follow: element<HTMLInputElement>("follow"),
  reload: element<HTMLButtonElement>("reload"),
  reconnect: element<HTMLButtonElement>("reconnect"),
};

const state = {
  sample: emptySample(performance.now()),
  generation: -1,
  cues: [] as Cue[],
  cueTimes: [] as number[],
  lines: [] as HTMLLIElement[],
  highlighted: -1,
  synced: false,
  canSeek: false,
  isPlaying: false,
  albumArt: null as string | null,
  /** Which backdrop layer currently shows the artwork. */
  frontLayer: ui.backdropA,
  /** Suppresses auto-scroll briefly after the reader scrolls by hand. */
  manualScrollUntil: 0,
  notice: "",
  statusNotice: "",
};

// ---------------------------------------------------------------- rendering

function setNotice(text: string) {
  state.notice = text;
  const message = text || state.statusNotice;
  ui.notice.textContent = message;
  ui.notice.hidden = message === "";
}

function clearLyrics(placeholder: string) {
  ui.lyricsList.replaceChildren();
  state.lines = [];
  state.cues = [];
  state.cueTimes = [];
  state.highlighted = -1;
  state.synced = false;
  ui.sourceBadge.hidden = true;
  ui.lyricsEmpty.textContent = placeholder;
  ui.lyricsEmpty.hidden = false;
}

function showAlbumArt(url: string | null) {
  if (url === state.albumArt) return;
  state.albumArt = url;

  ui.albumArt.classList.toggle("is-loaded", Boolean(url));
  if (url) ui.albumArt.src = url;
  else ui.albumArt.removeAttribute("src");

  // Cross-fade between the two layers so the background never flashes black.
  const incoming = state.frontLayer === ui.backdropA ? ui.backdropB : ui.backdropA;
  incoming.style.backgroundImage = url ? `url("${url}")` : "none";
  incoming.classList.toggle("is-visible", Boolean(url));
  state.frontLayer.classList.remove("is-visible");
  state.frontLayer = incoming;
}

function renderLyrics(event: LyricsEvent) {
  const hasContent = event.synced ? event.cues.length > 0 : event.text.length > 0;
  if (!hasContent) {
    clearLyrics("No matching lyrics found.");
    setNotice(event.partial ? "Some lyrics sources were unavailable." : "");
    return;
  }

  clearLyrics("");
  ui.lyricsEmpty.hidden = true;
  state.cues = event.synced ? event.cues : [];
  state.cueTimes = state.cues.map((cue) => cue.time_ms);
  state.synced = event.synced;

  const rows = event.synced ? event.cues.map((cue) => cue.text) : event.text.split("\n");
  for (const [index, text] of rows.entries()) {
    const line = document.createElement("li");
    line.className = event.synced ? "line line--seekable" : "line line--plain";
    // A blank cue is a musical gap: keep its height, show nothing.
    line.textContent = text || " ";
    if (event.synced) line.dataset.index = String(index);
    ui.lyricsList.append(line);
    state.lines.push(line);
  }

  ui.sourceBadge.textContent = `${event.source} · ${event.synced ? "Synced" : "Plain"}`;
  ui.sourceBadge.className = event.synced ? "badge badge--synced" : "badge";
  ui.sourceBadge.hidden = false;
  setNotice(event.partial ? "Some lyrics sources were unavailable." : "");
}

function highlight(index: number) {
  if (index === state.highlighted) return;

  state.lines[state.highlighted]?.classList.remove("is-active");
  state.lines.forEach((line, position) => {
    line.classList.toggle("is-past", position < index);
    line.classList.toggle("is-near", Math.abs(position - index) === 1);
  });

  const current = state.lines[index];
  if (current) {
    current.classList.add("is-active");
    if (ui.follow.checked && performance.now() > state.manualScrollUntil) {
      // Centre the line rather than merely bringing it into view.
      const target = current.offsetTop - ui.lyrics.clientHeight / 2 + current.clientHeight / 2;
      ui.lyrics.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
    }
  }
  state.highlighted = index;
}

function frame() {
  const now = performance.now();
  const position = positionAt(state.sample, now);
  const duration = state.sample.durationMs;

  ui.timeCurrent.textContent = formatTime(position);
  ui.timeTotal.textContent = formatTime(duration);
  const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
  ui.scrubberFill.style.width = `${fraction * 100}%`;
  ui.scrubberKnob.style.left = `${fraction * 100}%`;
  ui.scrubber.setAttribute("aria-valuenow", String(Math.round(position)));
  ui.scrubber.setAttribute("aria-valuemax", String(Math.round(duration)));

  if (state.synced) highlight(activeLine(state.cueTimes, position));
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------- commands

async function send(command: string, args?: Record<string, unknown>) {
  try {
    await invoke(command, args);
    setNotice("");
  } catch (error) {
    // Spotify's own refusal text, e.g. the Premium or no-active-device message.
    setNotice(String(error));
  }
}

function seekToFraction(clientX: number) {
  if (!state.canSeek || state.sample.durationMs <= 0) return;
  const bounds = ui.scrubber.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const positionMs = Math.round(fraction * state.sample.durationMs);
  // Move the highlight immediately; the next poll confirms it.
  state.sample = { ...state.sample, positionMs, receivedAt: performance.now() };
  void send("seek", { positionMs });
}

ui.playPause.addEventListener("click", () => void send(state.isPlaying ? "pause" : "play"));
ui.next.addEventListener("click", () => void send("next_track"));
ui.previous.addEventListener("click", () => void send("previous_track"));
ui.reload.addEventListener("click", () => void send("reload_lyrics"));
ui.reconnect.addEventListener("click", () => void send("connect"));

ui.scrubber.addEventListener("pointerdown", (event) => {
  ui.scrubber.setPointerCapture(event.pointerId);
  seekToFraction(event.clientX);
});
ui.scrubber.addEventListener("pointermove", (event) => {
  if (event.buttons === 1) seekToFraction(event.clientX);
});
ui.scrubber.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  event.preventDefault();
  const step = (event.shiftKey ? 30_000 : 5_000) * (event.key === "ArrowRight" ? 1 : -1);
  const target = positionAt(state.sample, performance.now()) + step;
  void send("seek", { positionMs: Math.max(0, Math.round(target)) });
});

// Clicking a timed line jumps the player to it.
ui.lyricsList.addEventListener("click", (event) => {
  const line = (event.target as HTMLElement).closest("li");
  const index = line?.dataset.index;
  if (index === undefined || !state.canSeek) return;
  const cue = state.cues[Number(index)];
  if (cue) void send("seek", { positionMs: cue.time_ms });
});

// Reading by hand should not fight the auto-scroll.
ui.lyrics.addEventListener("wheel", () => {
  state.manualScrollUntil = performance.now() + 4000;
});
ui.follow.addEventListener("change", () => {
  state.manualScrollUntil = 0;
  state.highlighted = -1;
});

// ------------------------------------------------------------------- events

void listen<PlaybackEvent>("playback", ({ payload }) => {
  state.sample = {
    positionMs: payload.progressMs,
    playing: payload.isPlaying,
    durationMs: payload.durationMs,
    receivedAt: performance.now(),
  } satisfies Sample;
  state.isPlaying = payload.isPlaying;
  state.canSeek = payload.hasTrack && payload.canSeek;
  document.body.classList.toggle("is-playing", payload.isPlaying);

  ui.playPause.disabled = !payload.hasTrack;
  ui.next.disabled = !payload.hasTrack || !payload.canSkipNext;
  ui.previous.disabled = !payload.hasTrack || !payload.canSkipPrevious;
  ui.scrubber.classList.toggle("is-disabled", !state.canSeek);

  const changed = state.generation !== payload.generation;
  if (changed) state.generation = payload.generation;

  if (!payload.hasTrack) {
    ui.trackName.textContent = "No track playing";
    ui.trackArtist.textContent = "";
    showAlbumArt(null);
    if (changed) clearLyrics("Waiting for playback…");
    return;
  }

  ui.trackName.textContent = payload.name;
  ui.trackArtist.textContent = payload.artists.join(", ");
  showAlbumArt(payload.albumArt);
  if (changed) clearLyrics("Looking for lyrics…");
});

void listen<LyricsEvent>("lyrics", ({ payload }) => {
  // A late answer for a song that already changed is not shown.
  if (payload.generation !== state.generation) return;
  renderLyrics(payload);
});

void listen<StatusEvent>("status", ({ payload }) => {
  ui.statusText.textContent = payload.message;
  state.statusNotice = payload.notice;
  setNotice(state.notice);
  ui.reconnect.hidden = payload.state !== "error" && payload.state !== "needs-auth";
});

requestAnimationFrame(frame);

// Connect only once the listeners above exist, so no status is emitted into the
// void. A saved session resumes without the user pressing anything.
void send("connect");
