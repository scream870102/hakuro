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
  requested: string;
}

interface Settings {
  clientId: string;
  sources: { id: string; enabled: boolean }[];
  theme: { accent: string; activeLine: string; pastLine: string };
  followLyrics: boolean;
}

interface Config {
  settings: Settings;
  providers: { id: string; label: string }[];
  dataDir: string;
  storedTracks: number;
  storageWarning: string;
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
  sourceBadge: element<HTMLButtonElement>("source-badge"),
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
  trackId: "",
  requestedSource: "",
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
  ui.sourceBadge.textContent = "Lyrics source ▾";
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
  state.requestedSource = event.requested;
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

let config: Config | undefined;
let draft: Settings;
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const sourceDialog = element<HTMLDialogElement>("source-dialog");
const sourceSelect = element<HTMLSelectElement>("track-source");
let sourceTrackId = "";
const settingsError = element("settings-error");

function applyConfig(value: Config) {
  config = value;
  const { theme } = value.settings;
  document.documentElement.style.setProperty("--accent", theme.accent);
  document.documentElement.style.setProperty("--active-line", theme.activeLine);
  document.documentElement.style.setProperty("--past-line", theme.pastLine);
  ui.follow.checked = value.settings.followLyrics;
}

function renderSourceOrder() {
  const list = element("source-order");
  list.replaceChildren();
  draft.sources.forEach((source, index) => {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = source.enabled;
    checkbox.addEventListener("change", () => { source.enabled = checkbox.checked; });
    const name = config?.providers.find((provider) => provider.id === source.id)?.label ?? source.id;
    label.append(checkbox, document.createTextNode(name));
    row.append(label);
    for (const [direction, text] of [[-1, "↑"], [1, "↓"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button";
      button.textContent = text;
      button.setAttribute("aria-label", `Move ${name} ${direction < 0 ? "up" : "down"}`);
      const target = index + direction;
      button.disabled = target < 0 || target >= draft.sources.length;
      button.addEventListener("click", () => {
        [draft.sources[index], draft.sources[target]] = [draft.sources[target], draft.sources[index]];
        renderSourceOrder();
        (list.children[target]?.querySelectorAll("button")[direction < 0 ? 0 : 1] as HTMLButtonElement)?.focus();
      });
      row.append(button);
    }
    list.append(row);
  });
}

async function openSettings() {
  try {
    const value = await invoke<Config>("get_config");
    config = value;
    draft = structuredClone(value.settings);
    element<HTMLInputElement>("client-id").value = draft.clientId;
    element<HTMLInputElement>("color-accent").value = draft.theme.accent;
    element<HTMLInputElement>("color-active").value = draft.theme.activeLine;
    element<HTMLInputElement>("color-past").value = draft.theme.pastLine;
    element<HTMLInputElement>("settings-follow").checked = draft.followLyrics;
    element("storage-info").textContent = `Data folder: ${value.dataDir} · Cached songs: ${value.storedTracks}`;
    settingsError.textContent = value.storageWarning;
    renderSourceOrder();
    if (!settingsDialog.open) settingsDialog.showModal();
  } catch (error) { setNotice(String(error)); }
}

element("settings-open").addEventListener("click", () => void openSettings());
element("settings-cancel").addEventListener("click", () => settingsDialog.close());
element("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element<HTMLButtonElement>("settings-save");
  button.disabled = true;
  settingsError.textContent = "";
  draft.clientId = element<HTMLInputElement>("client-id").value.trim();
  draft.theme = {
    accent: element<HTMLInputElement>("color-accent").value,
    activeLine: element<HTMLInputElement>("color-active").value,
    pastLine: element<HTMLInputElement>("color-past").value,
  };
  draft.followLyrics = element<HTMLInputElement>("settings-follow").checked;
  try {
    applyConfig(await invoke<Config>("save_settings", { incoming: draft }));
    settingsDialog.close();
  } catch (error) { settingsError.textContent = String(error); }
  finally { button.disabled = false; }
});

ui.sourceBadge.addEventListener("click", () => {
  if (!config || !state.trackId) return;
  sourceTrackId = state.trackId;
  element("source-track").textContent = ui.trackName.textContent;
  element("source-error").textContent = "";
  sourceSelect.replaceChildren(new Option("Automatic (global preferences)", ""));
  config.providers.forEach((provider) => sourceSelect.add(new Option(provider.label, provider.id)));
  sourceSelect.value = state.requestedSource;
  sourceDialog.showModal();
});
element("source-cancel").addEventListener("click", () => sourceDialog.close());
element("source-save").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("source-save");
  button.disabled = true;
  try {
    await invoke("set_track_source", { source: sourceSelect.value || null, trackId: sourceTrackId });
    sourceDialog.close();
  } catch (error) { element("source-error").textContent = String(error); }
  finally { button.disabled = false; }
});

ui.scrubber.addEventListener("pointerdown", (event) => {
  ui.scrubber.setPointerCapture(event.pointerId);
  seekToFraction(event.clientX);
});
ui.scrubber.addEventListener("pointermove", (event) => {
  if (event.buttons === 1) seekToFraction(event.clientX);
});
ui.scrubber.addEventListener("keydown", (event) => {
  if (!state.canSeek) return;
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
  if (config) {
    ui.follow.disabled = true;
    const incoming = { ...config.settings, followLyrics: ui.follow.checked };
    void invoke<Config>("save_settings", { incoming }).then(applyConfig).catch((error) => {
      ui.follow.checked = config!.settings.followLyrics;
      setNotice(String(error));
    }).finally(() => { ui.follow.disabled = false; });
  }
});

// ------------------------------------------------------------------- events

const playbackReady = listen<PlaybackEvent>("playback", ({ payload }) => {
  const trackId = payload.hasTrack ? payload.trackId || `${payload.name}|${payload.durationMs}` : "";
  if (state.trackId !== trackId) {
    sourceDialog.close();
    state.requestedSource = "";
  }
  state.trackId = trackId;
  ui.sourceBadge.disabled = !payload.hasTrack || !config;
  ui.reload.disabled = !payload.hasTrack;
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
  ui.scrubber.setAttribute("aria-disabled", String(!state.canSeek));

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

const lyricsReady = listen<LyricsEvent>("lyrics", ({ payload }) => {
  // A late answer for a song that already changed is not shown.
  if (payload.generation !== state.generation) return;
  renderLyrics(payload);
});

const statusReady = listen<StatusEvent>("status", ({ payload }) => {
  ui.statusText.textContent = payload.message;
  state.statusNotice = payload.notice;
  setNotice(state.notice);
  ui.reconnect.hidden = payload.state !== "error" && payload.state !== "needs-auth";
});

requestAnimationFrame(frame);

// Connect only once the listeners above exist, so no status is emitted into the
// void. A saved session resumes without the user pressing anything.
async function start() {
  try {
    await Promise.all([playbackReady, lyricsReady, statusReady]);
    applyConfig(await invoke<Config>("get_config"));
    if (!config!.settings.clientId) {
      ui.statusText.textContent = "Set up Spotify in Settings";
      await openSettings();
    }
    else await send("connect");
  } catch (error) { setNotice(String(error)); }
}
void start();
