/**
 * Presentation layer. Every network call lives in Rust; this file renders what
 * the backend emits and extrapolates the position between polls so the current
 * line moves smoothly instead of stepping once every 1.5 s.
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, once } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { activeLine, emptySample, formatTime, positionAt, type Sample } from "./clock";
import { applyTheme, SEARCH_TRANSLATIONS, SETTINGS_PREVIEW, type ClickThrough, type Config, type Settings, type WindowStylePreview } from "./config";
import { createDeck, restPoses, stretchedHeight, type CubeFace } from "./deck";
import { floorExtent } from "./floor";
import { createModes, nextRepeat, REPEAT_NAMES, repeatLabel, shuffleLabel, type Modes, type Repeat } from "./modes";
import {
  describeCommands, PALETTE_CLOSED, PALETTE_READY, PALETTE_RUN, PALETTE_SHOW,
  type Command, type PaletteAction, type PaletteSnapshot,
} from "./palette";
import { CHILD_WINDOW, created, openPanel, placeBesideMain, placeOverMain } from "./windows";
import { DEFAULT_SHORTCUTS, shortcutFromEvent, shortcutLabel } from "./shortcuts";
import { createWave } from "./wave";

interface Cue {
  time_ms: number;
  text: string;
  translation?: string | null;
  words?: { start_ms: number; end_ms: number; text: string }[];
}

interface PlaybackEvent {
  trackId: string;
  /** The backend's key for this song (source-prefixed); lyric events and commands use it. */
  trackKey: string;
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
  volumePercent?: number | null;
  canSetVolume?: boolean;
  deviceName: string | null;
  deviceId?: string | null;
  /** Null when the player cannot report them (ytmdesktop2). */
  shuffle?: boolean | null;
  repeat?: Repeat | null;
  canShuffle?: boolean;
  canRepeatContext?: boolean;
  canRepeatTrack?: boolean;
  generation: number;
}

interface LyricsEvent {
  generation: number;
  trackId: string;
  source: string;
  matchedTitle: string;
  synced: boolean;
  cues: Cue[];
  text: string;
  partial: boolean;
  requested: string;
  manual?: boolean;
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
  barPlay: element<HTMLButtonElement>("bar-play"),
  shuffle: element<HTMLButtonElement>("shuffle"),
  repeat: element<HTMLButtonElement>("repeat"),
  queueOpen: element<HTMLButtonElement>("queue-open"),
  scene: element("scene"),
  lineNow: element("line-now"),
  lineTotal: element("line-total"),
  follow: element<HTMLInputElement>("follow"),
  pin: element<HTMLButtonElement>("pin"),
  mode: element<HTMLButtonElement>("mode-toggle"),
  reload: element<HTMLButtonElement>("reload"),
  reconnect: element<HTMLButtonElement>("reconnect"),
  search: element<HTMLButtonElement>("lyrics-search-open"),
  volume: element<HTMLInputElement>("volume"),
  volumeValue: element<HTMLOutputElement>("volume-value"),
  volumeControl: element("volume-control"),
  compactLyrics: element<HTMLInputElement>("compact-lyrics"),
  cubeLyrics: element("cube-lyrics"),
  lidTitle: element("lid-title"),
  lidArtist: element("lid-artist"),
  lidFill: element("lid-fill"),
  lidTime: element("lid-time"),
  lidTotal: element("lid-total"),
  spineTitle: element("spine-title"),
  spineArtist: element("spine-artist"),
};
/** Where the lyrics live in the full window; compact moves them onto the cube's front. */
const lyricsHome = { parent: ui.lyrics.parentElement!, before: ui.lyrics.nextElementSibling };

const state = {
  trackId: "",
  trackName: "No track playing",
  matchedTitle: "",
  requestedSource: "",
  sample: emptySample(performance.now()),
  generation: -1,
  cues: [] as Cue[],
  cueTimes: [] as number[],
  lines: [] as HTMLLIElement[],
  wordSpans: [] as HTMLSpanElement[][],
  manual: false,
  /** Shown under each line when the song has them; Find lyrics and the palette toggle it. */
  showTranslations: true,
  highlighted: -1,
  synced: false,
  canSeek: false,
  isPlaying: false,
  albumArt: null as string | null,
  /** Suppresses auto-scroll briefly after the reader scrolls by hand. */
  manualScrollUntil: 0,
  notice: "",
  statusNotice: "",
};

let seekPreview: { start: number; position: number } | null = null;
const deck = createDeck({ beginSeek, previewSeek, endSeek, dragWindow: () => void appWindow.startDragging() });
/** The cube's column: the floor is drawn across it, and compact's glass is all of it. */
const objectZone = ui.scene.parentElement!;
const wave = createWave({
  zone: objectZone,
  scene: ui.scene,
  cube: element("cube"),
  pose: () => deck.pose(),
  fitted: () => !document.body.classList.contains("is-compact"),
});
const lineNumber = (index: number) => String(index + 1).padStart(2, "0");

// ---------------------------------------------------------------- rendering

/** Long enough to read a player's refusal, short enough not to become furniture. */
const NOTICE_LIFETIME_MS = 8000;
let noticeTimer = 0;

function setNotice(text: string) {
  state.notice = text;
  const message = text || state.statusNotice;
  ui.notice.textContent = message;
  ui.notice.hidden = message === "";
  clearTimeout(noticeTimer);
  if (message) noticeTimer = window.setTimeout(dismissNotice, NOTICE_LIFETIME_MS);
}

/** Both sources are cleared: a warning dismissed by hand should stay dismissed. */
function dismissNotice() {
  clearTimeout(noticeTimer);
  state.notice = "";
  state.statusNotice = "";
  ui.notice.hidden = true;
}

function renderTrackName() {
  const alternate = state.matchedTitle && state.matchedTitle !== state.trackName;
  ui.trackName.textContent = state.trackName + (alternate ? ` (${state.matchedTitle})` : "");
  // Compact sets the same name down the cube's spine and on its lid.
  ui.spineTitle.textContent = ui.lidTitle.textContent = ui.trackName.textContent;
  deck.setTitle(state.trackName === "No track playing" ? "" : state.trackName);
}

function renderArtist(text: string) {
  ui.trackArtist.textContent = ui.spineArtist.textContent = ui.lidArtist.textContent = text;
}

function clearLyrics(placeholder: string) {
  state.matchedTitle = "";
  renderTrackName();
  ui.lyricsList.replaceChildren();
  state.lines = [];
  state.wordSpans = [];
  state.manual = false;
  state.cues = [];
  state.cueTimes = [];
  state.highlighted = -1;
  state.synced = false;
  ui.lineNow.textContent = "--";
  ui.lineTotal.textContent = "--";
  ui.sourceBadge.textContent = "Lyrics source ▾";
  ui.lyricsEmpty.textContent = placeholder;
  ui.lyricsEmpty.hidden = false;
  updateTranslationLayout();
}

function showAlbumArt(url: string | null) {
  if (url === state.albumArt) return;
  state.albumArt = url;
  // The cover is the cube's front face (and the record's label).
  deck.setCover(url);
}

/** New lyrics drop in line by line; the class goes again so later slams are not masked. */
let dropTimer = 0;
function dropIn() {
  ui.lyricsList.classList.remove("drop");
  void ui.lyricsList.offsetWidth;
  ui.lyricsList.classList.add("drop");
  clearTimeout(dropTimer);
  dropTimer = window.setTimeout(() => ui.lyricsList.classList.remove("drop"), 1200);
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
  state.matchedTitle = event.matchedTitle?.trim() || "";
  renderTrackName();
  ui.lyricsEmpty.hidden = true;
  state.cues = event.synced ? event.cues : [];
  state.cueTimes = state.cues.map((cue) => cue.time_ms);
  state.synced = event.synced;
  state.manual = event.manual ?? false;

  const rows = event.synced ? event.cues.map((cue) => cue.text) : event.text.split("\n");
  for (const [index, text] of rows.entries()) {
    const line = document.createElement("li");
    line.className = event.synced ? "line line--seekable" : "line line--plain";
    // A blank cue is a musical gap: keep its height, show nothing.
    const cue = state.cues[index];
    const words = cue?.words ?? [];
    const spans = words.map((word) => {
      const span = document.createElement("span");
      span.className = "lyric-word";
      span.textContent = word.text;
      // The highlighter wipe repeats the word over itself.
      span.dataset.t = word.text;
      return span;
    });
    line.style.setProperty("--i", String(index));
    if (spans.length) line.classList.add("line--words");
    if (spans.length) line.append(...spans);
    else line.textContent = text || " ";
    state.wordSpans.push(spans);
    if (cue?.translation) {
      const translation = document.createElement("span");
      translation.className = "lyric-translation";
      translation.textContent = cue.translation;
      line.append(translation);
    }
    if (event.synced) line.dataset.index = String(index);
    ui.lyricsList.append(line);
    state.lines.push(line);
  }

  ui.sourceBadge.textContent = `${event.source} · ${event.synced ? "Synced" : "Plain"}${state.manual ? " · Manual" : ""}`;
  ui.sourceBadge.className = event.synced ? "badge badge--synced" : "badge";
  ui.sourceBadge.hidden = false;
  if (event.synced) ui.lineTotal.textContent = String(rows.length).padStart(2, "0");
  dropIn();
  setNotice(event.partial ? "Some lyrics sources were unavailable." : "");
  updateTranslationLayout();
}

function highlight(index: number) {
  if (index === state.highlighted) return;

  state.lines[state.highlighted]?.classList.remove("is-active");
  state.lines.forEach((line, position) => {
    line.classList.toggle("is-past", position < index);
    line.classList.toggle("is-near", Math.abs(position - index) === 1);
  });

  const current = state.lines[index];
  ui.lineNow.textContent = current ? lineNumber(index) : "--";
  if (current) {
    current.classList.add("is-active");
    if (centre(current, "smooth") && !seekPreview && state.highlighted >= 0 && index === state.highlighted + 1) {
      // Only the song moving on by itself throws shards; seeks stay quiet.
      deck.lineChanged(current);
    }
  }
  state.highlighted = index;
}

/** Centre a line rather than merely bringing it into view, unless the reader has taken over. */
function centre(line: HTMLElement, behavior: ScrollBehavior) {
  if (!ui.follow.checked || performance.now() <= state.manualScrollUntil) return false;
  const target = line.offsetTop - ui.lyrics.clientHeight / 2 + line.clientHeight / 2;
  ui.lyrics.scrollTo({ top: Math.max(0, target), behavior });
  return true;
}

/** A mode switch or a resize moves every line; put the one being sung back in the middle. */
function recentre() {
  const current = state.lines[state.highlighted];
  if (current) centre(current, "instant");
}

function frame() {
  const now = performance.now();
  const position = seekPreview?.position ?? positionAt(state.sample, now);
  const duration = state.sample.durationMs;

  ui.timeCurrent.textContent = ui.lidTime.textContent = formatTime(position);
  ui.timeTotal.textContent = ui.lidTotal.textContent = formatTime(duration);
  const fraction = duration > 0 ? Math.min(1, position / duration) : 0;
  ui.scrubberFill.style.width = ui.lidFill.style.width = `${fraction * 100}%`;
  ui.scrubberKnob.style.left = `${fraction * 100}%`;
  ui.scrubber.setAttribute("aria-valuenow", String(Math.round(position)));
  ui.scrubber.setAttribute("aria-valuemax", String(Math.round(duration)));

  if (state.synced) {
    const index = activeLine(state.cueTimes, position);
    // Reset the old row on seeks and track changes; all timings use the same
    // playback clock as the line highlight, so pause needs no separate timer.
    if (index !== state.highlighted) {
      state.wordSpans[state.highlighted]?.forEach((span) => span.classList.remove("is-singing", "is-sung"));
    }
    highlight(index);
    state.wordSpans[index]?.forEach((span, wordIndex) => {
      const word = state.cues[index].words![wordIndex];
      const singing = position >= word.start_ms && position < word.end_ms;
      span.classList.toggle("is-singing", singing);
      span.classList.toggle("is-sung", position >= word.end_ms);
      if (singing) span.style.setProperty("--p", `${(((position - word.start_ms) / Math.max(1, word.end_ms - word.start_ms)) * 100).toFixed(1)}%`);
    });
    // Line-timed lyrics show how far through the line the song is.
    const line = state.lines[index];
    if (line) {
      const start = state.cueTimes[index];
      const end = state.cueTimes[index + 1] ?? duration;
      line.style.setProperty("--lp", (end > start ? Math.min(1, Math.max(0, (position - start) / (end - start))) : 0).toFixed(3));
    }
  }
  deck.tick(now);
  wave.draw(now);
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------- commands

async function send(command: string, args?: Record<string, unknown>) {
  try {
    await invoke(command, args);
    setNotice("");
  } catch (error) {
    // The player's own refusal text, e.g. Spotify's Premium or no-active-device
    // message, or ytmdesktop2 waiting for its page to load.
    setNotice(String(error));
  }
}

// Volume belongs to the active player/device, not the song. A serial discards
// pending replies after either changes; normal polls never interrupt a drag.
let volumeDevice = "";
let volumeSerial = 0;
let volumeConfirmed: number | null = null;
let volumeSupported = false;
let volumeEditing = false;
let volumeDirty = false;
let volumePending = false;

function renderVolume() {
  ui.volume.disabled = !volumeSupported || volumePending;
  const value = volumeConfirmed;
  ui.volume.value = String(value ?? 0);
  ui.volumeValue.textContent = value === null ? "—" : `${value}%`;
  ui.volume.setAttribute("aria-valuetext", value === null ? "Unavailable" : `${value}%`);
  ui.volumeControl.title = volumeSupported
    ? config?.settings.player === "ytmdesktop2" ? "ytmdesktop2 player volume" : "Spotify active device volume"
    : "Volume control is unavailable for this player or device";
}

function resetVolume() {
  volumeSerial++;
  volumeDevice = "";
  volumeConfirmed = null;
  volumeSupported = false;
  volumeEditing = false;
  volumeDirty = false;
  volumePending = false;
  renderVolume();
}

function receiveVolume(payload: PlaybackEvent) {
  const device = `${config?.settings.player ?? ""}|${payload.deviceId ?? payload.deviceName ?? ""}|${Boolean(payload.canSetVolume)}`;
  if (device !== volumeDevice) {
    resetVolume();
    volumeDevice = device;
  }
  const value = payload.volumePercent;
  volumeConfirmed = typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(100, Math.round(value))) : null;
  volumeSupported = payload.canSetVolume === true && volumeConfirmed !== null;
  if (!volumeSupported) {
    volumeSerial++;
    volumeEditing = false;
    volumePending = false;
  }
  if (!volumeEditing && !volumePending) renderVolume();
}

ui.volume.addEventListener("pointerdown", () => {
  if (ui.volume.disabled) return;
  volumeEditing = true;
  volumeDirty = false;
});
// This row sits inside the draggable titlebar; slider gestures stay controls.
for (const event of ["pointerdown", "mousedown"]) {
  ui.volumeControl.addEventListener(event, (event) => event.stopPropagation());
}
ui.volume.addEventListener("input", () => {
  if (ui.volume.disabled) return;
  volumeEditing = true;
  volumeDirty = true;
  ui.volumeValue.textContent = `${ui.volume.value}%`;
  ui.volume.setAttribute("aria-valuetext", `${ui.volume.value}%`);
});
ui.volume.addEventListener("pointerup", () => {
  if (!volumeDirty && !volumePending) {
    volumeEditing = false;
    renderVolume();
  }
});
for (const event of ["pointercancel", "blur"]) {
  ui.volume.addEventListener(event, () => {
    if (volumePending) return;
    volumeEditing = false;
    volumeDirty = false;
    renderVolume();
  });
}
ui.volume.addEventListener("change", async () => {
  if (!volumeSupported || volumePending) return;
  const volumePercent = Math.max(0, Math.min(100, Math.round(Number(ui.volume.value))));
  const serial = ++volumeSerial;
  const restoreFocus = document.activeElement === ui.volume;
  volumeEditing = false;
  volumeDirty = false;
  volumePending = true;
  ui.volume.disabled = true;
  ui.volumeValue.textContent = `${volumePercent}%`;
  ui.volume.setAttribute("aria-valuetext", `${volumePercent}%`);
  try {
    await invoke("set_volume", { volumePercent });
    if (serial !== volumeSerial) return;
    volumeConfirmed = volumePercent;
  } catch (error) {
    if (serial !== volumeSerial) return;
    setNotice(String(error));
  } finally {
    if (serial === volumeSerial) {
      volumePending = false;
      renderVolume();
      if (restoreFocus && document.activeElement === document.body) ui.volume.focus();
    }
  }
});

function seekToFraction(clientX: number) {
  if (!state.canSeek || state.sample.durationMs <= 0) return;
  const bounds = ui.scrubber.getBoundingClientRect();
  const fraction = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
  const positionMs = Math.round(fraction * state.sample.durationMs);
  // Move the highlight immediately; the next poll confirms it.
  state.sample = { ...state.sample, positionMs, receivedAt: performance.now() };
  void send("seek", { positionMs });
}

// ------------------------------------------------------------ window chrome

const appWindow = getCurrentWindow();
let windowFocused = true;

/** Persist one changed field, then apply whatever the backend hands back. */
async function patchSettings(patch: Partial<Settings>, control?: { disabled: boolean }) {
  const before = config;
  if (!before) return;
  if (control) control.disabled = true;
  try {
    const incoming = { ...before.settings, ...patch };
    applyConfig(await invoke<Config>("save_settings", { incoming }));
  } catch (error) {
    // Put the window and every control back the way the stored settings have them.
    applyConfig(before);
    setNotice(String(error));
  } finally {
    if (control) control.disabled = false;
  }
}

/** Reflect the pin in the button, the cube's edges and the window itself. */
function setPinned(pinned: boolean) {
  ui.pin.setAttribute("aria-pressed", String(pinned));
  document.body.classList.toggle("is-pinned", pinned);
  ui.pin.title = pinned ? "Stop keeping on top" : "Keep on top";
  void appWindow.setAlwaysOnTop(pinned);
  applyClickThrough();
}

/**
 * Clicks only fall through while the window is pinned. An unpinned window that
 * ignored the mouse would just look broken, and there would be no reason for it.
 */
function applyClickThrough() {
  const mode = config?.settings.clickThrough ?? "off";
  const pinned = ui.pin.getAttribute("aria-pressed") === "true";
  const through = pinned && (mode === "always" || (mode === "auto" && !windowFocused));
  void appWindow.setIgnoreCursorEvents(through);
}

void appWindow.onFocusChanged(({ payload: focused }) => {
  windowFocused = focused;
  applyClickThrough();
});

// Compact is the cube alone on clear glass. Its edge fits three lines of lyrics
// for when it stretches, and the window leaves the cube room to turn: as tall as
// the stretched cube stands end-on, stretched or not, so the lyrics only ever
// widen it. With the wave on it also holds the floor, which reaches further
// below the cube than above, so the cube moves up by --floor-shift. The
// stylesheet reads the edge and the stretch from --compact-s and --lw.
const COMPACT_MIN_EDGE = 150;
const FULL_MIN_WIDTH = 520;
const FULL_MIN_HEIGHT = 460;

/**
 * The cube's edge, how far the lyrics stretch it, and the window around both.
 * Sized for original-only rows. Translated rows take a third of the face each,
 * with type small enough to fit, so songs and the translation switch never
 * resize the window.
 */
function compactGeometry(lyricSize: number, stretched: boolean, floor: boolean) {
  const lines = 3 * (lyricSize * 1.32 + 18);
  const edge = Math.max(COMPACT_MIN_EDGE, Math.ceil(lines + 16));
  const stretch = Math.round(edge * 1.9);
  // The plain cube stands well under this at its own rest.
  const cube = stretchedHeight(edge, edge + stretch) / 2;
  let above = cube;
  let below = cube;
  let half = edge + (stretched ? stretch / 2 : 0);
  if (floor) {
    // The floor's height counts stretched or not, like the cube's.
    for (const long of [false, true]) {
      const extent = floorExtent(edge, long ? edge + stretch : edge, 1, restPoses(long));
      above = Math.max(above, extent.above);
      below = Math.max(below, extent.below);
      if (long === stretched) half = Math.max(half, extent.left, extent.right);
    }
  }
  // Plus the pin's glow round the edges, top and bottom.
  const height = Math.ceil(above + below) + 24;
  const width = Math.ceil(2 * half);
  return { edge, stretch, shift: Math.round(below - above), size: new LogicalSize(width, height) };
}

function updateTranslationLayout() {
  document.body.classList.toggle("hide-translations", !state.showTranslations);
}

/** The full-mode size to come back to, remembered at the moment of switching. */
let roomySize: LogicalSize | undefined;
/** Whether full mode filled the screen, so coming back fills it again. */
let roomyMaximized = false;
let appliedCompact: boolean | undefined;

async function applyWindowBounds(settings: Settings) {
  const { compact } = settings;
  const first = appliedCompact === undefined;
  const switched = !first && appliedCompact !== compact;
  appliedCompact = compact;

  if (compact) {
    const { edge, stretch, shift, size } = compactGeometry(settings.compactLyricSize, settings.compactLyrics, settings.waveCompact);
    const root = document.documentElement.style;
    root.setProperty("--compact-s", `${edge}px`);
    root.setProperty("--lw", `${stretch}px`);
    root.setProperty("--floor-shift", `${shift}px`);
    // Nothing remembers the window size between launches, so a stored compact
    // mode has to size the window itself, and full mode needs a size to return to.
    if (first || switched) {
      // A maximized window keeps its size whatever is asked of it, which would
      // leave the cube on a screenful of glass; let go of the screen first.
      roomyMaximized = await appWindow.isMaximized();
      if (roomyMaximized) await appWindow.unmaximize();
      roomySize = (await appWindow.innerSize()).toLogical(await appWindow.scaleFactor());
    }
    // An undecorated window's shadow comes with a border, which on clear glass
    // draws a frame round nothing.
    await appWindow.setShadow(false);
    // The cube decides the size; a window dragged bigger would only be more glass.
    await appWindow.setResizable(false);
    await appWindow.setMinSize(size);
    await appWindow.setSize(size);
    return;
  }

  await appWindow.setShadow(true);
  await appWindow.setResizable(true);
  await appWindow.setMinSize(new LogicalSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT));
  if (switched && roomySize) await appWindow.setSize(roomySize);
  if (switched && roomyMaximized) await appWindow.maximize();
}

ui.mode.addEventListener("click", () => {
  if (!config) return;
  void patchSettings({ compact: !config.settings.compact }, ui.mode);
});

ui.compactLyrics.addEventListener("change", () => {
  if (!config) return;
  void patchSettings({ compactLyrics: ui.compactLyrics.checked }, ui.compactLyrics);
});

// The floor below compact's cube lies outside the scene; its glass moves the window too.
objectZone.addEventListener("pointerdown", (event) => {
  if (event.button === 0 && event.target === objectZone && document.body.classList.contains("is-compact")) {
    void appWindow.startDragging();
  }
});

ui.pin.addEventListener("click", () => {
  if (!config) return;
  const alwaysOnTop = ui.pin.getAttribute("aria-pressed") !== "true";
  // Move the window first: the click should land even if the save then fails.
  setPinned(alwaysOnTop);
  void patchSettings({ alwaysOnTop }, ui.pin);
});

element("win-minimize").addEventListener("click", () => void appWindow.minimize());
element("win-maximize").addEventListener("click", () => void appWindow.toggleMaximize());
element("win-close").addEventListener("click", () => void appWindow.close());

// The glyph has to follow every route to maximized — the button, a double-click
// on the drag region, and Win+Up — so it tracks the resize rather than the click.
async function syncMaximized() {
  document.body.classList.toggle("is-maximized", await appWindow.isMaximized());
}
window.addEventListener("resize", () => {
  void syncMaximized();
  recentre();
});
// Compact's cube eases to its new size after the window has resized, and its
// face is the lyrics' viewport, so the sung line is centred again once it settles.
document.body.addEventListener("transitionend", (event) => {
  if (event.target === document.body && event.propertyName === "--s" && document.body.classList.contains("is-compact")) {
    recentre();
  }
});

// --------------------------------------------------------------- transport

ui.playPause.addEventListener("click", () => void send(state.isPlaying ? "pause" : "play"));
ui.next.addEventListener("click", () => void send("next_track"));
ui.previous.addEventListener("click", () => void send("previous_track"));
ui.reload.addEventListener("click", () => void send("reload_lyrics"));
element("refresh-playback").addEventListener("click", () => void send("refresh_playback"));
ui.reconnect.addEventListener("click", () => void send("connect"));
ui.barPlay.addEventListener("click", () => ui.playPause.click());

function beginSeek() {
  if (!state.canSeek || state.sample.durationMs <= 0) return;
  const start = positionAt(state.sample, performance.now());
  seekPreview = { start, position: start };
}

function previewSeek(deltaMs: number) {
  if (!seekPreview) return;
  seekPreview.position = Math.round(Math.min(state.sample.durationMs, Math.max(0, seekPreview.start + deltaMs)));
}

function endSeek(commit: boolean) {
  const preview = seekPreview;
  seekPreview = null;
  if (!commit || !preview || !state.canSeek) return;
  state.sample = { ...state.sample, positionMs: preview.position, receivedAt: performance.now() };
  void send("seek", { positionMs: preview.position });
}

// Shuffle and repeat, in the bar and (through it) on compact's lid.
const modes = createModes(renderModes, (error) => setNotice(error ?? ""));

function renderModes(current: Readonly<Modes>) {
  ui.shuffle.hidden = current.shuffle === null;
  ui.shuffle.disabled = !current.canShuffle;
  ui.shuffle.setAttribute("aria-pressed", String(current.shuffle === true));
  ui.shuffle.title = shuffleLabel(current.shuffle === true);
  ui.shuffle.setAttribute("aria-label", ui.shuffle.title);
  const repeat = current.repeat ?? "off";
  ui.repeat.hidden = current.repeat === null;
  ui.repeat.disabled = nextRepeat(current) === null;
  ui.repeat.dataset.mode = repeat;
  ui.repeat.setAttribute("aria-pressed", String(repeat !== "off"));
  ui.repeat.title = repeatLabel(repeat);
  ui.repeat.setAttribute("aria-label", ui.repeat.title);
}

ui.shuffle.addEventListener("click", () => modes.toggleShuffle());
ui.repeat.addEventListener("click", () => modes.cycleRepeat());

/** Seek relative to where the song is now, from the palette. */
function seekBy(deltaMs: number) {
  if (!state.canSeek || state.sample.durationMs <= 0) return;
  const now = performance.now();
  const positionMs = Math.round(Math.min(state.sample.durationMs, Math.max(0, positionAt(state.sample, now) + deltaMs)));
  state.sample = { ...state.sample, positionMs, receivedAt: now };
  void send("seek", { positionMs });
}

/** The same input/change pair a key press on the volume slider makes. */
function nudgeVolume(delta: number) {
  if (ui.volume.disabled) return;
  ui.volume.value = String(Math.max(0, Math.min(100, Number(ui.volume.value) + delta)));
  ui.volume.dispatchEvent(new Event("input"));
  ui.volume.dispatchEvent(new Event("change"));
}

let config: Config | undefined;
function applyConfig(value: Config) {
  const changedPlayer = config && config.settings.player !== value.settings.player;
  config = value;
  const commandBinding = (value.settings.shortcuts ?? DEFAULT_SHORTCUTS).find((item) => item.action === "commands");
  const commandHint = shortcutLabel(commandBinding?.accelerator ?? "");
  const commandButton = element("cmdk-open");
  const commandKeys = commandButton.querySelector("kbd");
  if (commandKeys) { commandKeys.textContent = commandHint; commandKeys.hidden = !commandHint; }
  commandButton.title = commandHint ? `Commands (${commandHint})` : "Commands";
  if (changedPlayer) resetVolume();
  applyTheme(value.settings.theme);
  wave.setAccent(value.settings.theme.accent);
  wave.setStrength(value.settings.waveStrength ?? 100);
  ui.follow.checked = value.settings.followLyrics;
  ui.queueOpen.disabled = false;

  const { compact } = value.settings;
  const stretched = compact && value.settings.compactLyrics;
  const switched = document.body.classList.contains("is-compact") !== compact;
  document.body.classList.toggle("is-compact", compact);
  document.body.classList.toggle("is-stretched", stretched);
  ui.compactLyrics.checked = value.settings.compactLyrics;
  deck.setLayout({ compact, stretched });
  if (compact && ui.lyrics.parentElement !== ui.cubeLyrics) ui.cubeLyrics.append(ui.lyrics);
  if (!compact && ui.lyrics.parentElement !== lyricsHome.parent) lyricsHome.parent.insertBefore(ui.lyrics, lyricsHome.before);
  ui.mode.setAttribute("aria-pressed", String(compact));
  ui.mode.title = compact ? "Full mode" : "Compact mode";
  setWindowStyle(
    compact ? value.settings.compactOpacity : value.settings.opacity,
    compact ? value.settings.compactLyricSize : value.settings.lyricSize,
  );
  if (switched) recentre();
  void applyWindowBounds(value.settings);
  setPinned(value.settings.alwaysOnTop);
  updateWave();
}

/** The floor shows in whichever mode has it on, and only while the window can be seen. */
let minimized = false;
function updateWave() {
  const settings = config?.settings;
  const wanted = settings ? (settings.compact ? settings.waveCompact : settings.waveFull) : false;
  wave.setActive(wanted && !minimized && document.visibilityState !== "hidden");
}
document.addEventListener("visibilitychange", updateWave);
void appWindow.onResized(async () => {
  minimized = await appWindow.isMinimized();
  updateWave();
});

/** The two per-mode dials, applied together because both come from one mode. */
function setWindowStyle(opacity: number, lyricSize: number) {
  const root = document.documentElement.style;
  root.setProperty("--ui-opacity", String(opacity / 100));
  root.setProperty("--lyric-size", `${lyricSize}px`);
}

// ------------------------------------------------------------- panel windows

/** Open the settings window, or bring it forward if it is already open. */
async function openSettings() {
  try {
    const settings = await openPanel("settings", {
      url: "settings.html", title: "Hakuro Settings",
      width: 640, height: 780, minWidth: 420, minHeight: 360, drop: 0.5,
    });
    // Saved, cancelled or closed some other way: show what is stored now, which
    // also takes back anything the dials previewed.
    void settings?.once("tauri://destroyed", async () => {
      try { applyConfig(await invoke<Config>("get_config")); }
      catch (error) { setNotice(String(error)); }
    });
  } catch (error) {
    setNotice(String(error));
  }
}

element("settings-open").addEventListener("click", () => void openSettings());

const previewReady = listen<WindowStylePreview>(SETTINGS_PREVIEW, ({ payload }) => {
  const compact = document.body.classList.contains("is-compact");
  setWindowStyle(
    compact ? payload.compactOpacity : payload.opacity,
    compact ? payload.compactLyricSize : payload.lyricSize,
  );
  // Compact's type size is also its cube's size, so the window follows the dial.
  if (compact && config) void applyWindowBounds({ ...config.settings, compactLyricSize: payload.compactLyricSize });
  wave.setStrength(payload.waveStrength);
});

// Find lyrics and the source picker work on the song playing when they open.
// It goes to them in the URL, with what they show of it; each closes itself if
// the song changes, so an open one is always about the current song.

function openSearch() {
  if (!config || !state.trackId) return;
  const artist = ui.trackArtist.textContent ?? "";
  const song = new URLSearchParams({
    track: state.trackId,
    title: `${state.trackName} · ${artist}`,
    query: `${state.trackName} ${artist}`.trim(),
    manual: state.manual ? "1" : "",
    translations: state.showTranslations ? "1" : "",
  });
  openPanel("search", {
    url: `search.html?${song}`, title: "Hakuro Find Lyrics",
    width: 600, height: 680, minWidth: 420, minHeight: 360, drop: 0.3,
  }).catch((error) => setNotice(String(error)));
}

function openSource() {
  if (!config || !state.trackId) return;
  const song = new URLSearchParams({
    track: state.trackId,
    title: ui.trackName.textContent ?? "",
    source: state.requestedSource,
  });
  openPanel("source", {
    url: `source.html?${song}`, title: "Hakuro Lyrics Source",
    width: 480, height: 380, minWidth: 380, minHeight: 300, drop: 0.4,
  }).catch((error) => setNotice(String(error)));
}

ui.search.addEventListener("click", openSearch);
ui.sourceBadge.addEventListener("click", openSource);

// The queue opens beside the window rather than over it, and the same button
// closes it again.
const QUEUE_WIDTH = 400;
const QUEUE_HEIGHT = 620;
let queueOpening = false;

async function toggleQueue() {
  if (queueOpening) return;
  queueOpening = true;
  try {
    const open = await WebviewWindow.getByLabel("queue");
    if (open) {
      await open.close();
      return;
    }
    const place = await placeBesideMain(QUEUE_WIDTH, QUEUE_HEIGHT);
    await created(new WebviewWindow("queue", {
      ...CHILD_WINDOW,
      ...place,
      url: "queue.html",
      title: "Hakuro Queue",
      resizable: false,
      // The sheet leans back in its own light; the window around it is clear.
      transparent: true,
      shadow: false,
    }));
  } catch (error) {
    setNotice(String(error));
  } finally {
    queueOpening = false;
  }
}

ui.queueOpen.addEventListener("click", () => void toggleQueue());

function setTranslations(visible: boolean) {
  state.showTranslations = visible;
  updateTranslationLayout();
  recentre();
}

const translationsReady = listen<boolean>(SEARCH_TRANSLATIONS, ({ payload }) => setTranslations(payload));

ui.notice.addEventListener("click", dismissNotice);

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
  void patchSettings({ followLyrics: ui.follow.checked }, ui.follow);
});

// ------------------------------------------------------------------- events

const playbackReady = listen<PlaybackEvent>("playback", ({ payload }) => {
  receiveVolume(payload);
  modes.receive(payload);
  // The backend's own key, verbatim: lyric events carry it and the source and
  // match commands check it, so a key rebuilt here would never match theirs.
  const trackId = payload.hasTrack ? payload.trackKey : "";
  if (state.trackId !== trackId) {
    seekPreview = null;
    state.requestedSource = "";
    // A new song spins the cube; its cover goes on while the front faces away.
    if (state.trackId && trackId) deck.trackChanged();
  }
  state.trackId = trackId;
  ui.sourceBadge.disabled = !payload.hasTrack || !config;
  ui.reload.disabled = !payload.hasTrack;
  ui.search.disabled = !payload.hasTrack || !config;
  state.sample = {
    positionMs: payload.progressMs,
    playing: payload.isPlaying,
    durationMs: payload.durationMs,
    receivedAt: performance.now(),
  } satisfies Sample;
  state.isPlaying = payload.isPlaying;
  state.canSeek = payload.hasTrack && payload.canSeek;
  if (!state.canSeek || payload.durationMs <= 0) seekPreview = null;
  document.body.classList.toggle("is-playing", payload.isPlaying);
  deck.setPlaying(payload.isPlaying);

  ui.playPause.disabled = !payload.hasTrack;
  ui.next.disabled = !payload.hasTrack || !payload.canSkipNext;
  ui.previous.disabled = !payload.hasTrack || !payload.canSkipPrevious;
  ui.barPlay.disabled = ui.playPause.disabled;
  // The icon swaps in CSS (body.is-playing); the name says what a press does.
  ui.barPlay.title = payload.isPlaying ? "Pause" : "Play";
  ui.barPlay.setAttribute("aria-label", ui.barPlay.title);
  ui.scrubber.classList.toggle("is-disabled", !state.canSeek);
  ui.scrubber.setAttribute("aria-disabled", String(!state.canSeek));

  const changed = state.generation !== payload.generation;
  if (changed) state.generation = payload.generation;

  if (!payload.hasTrack) {
    state.trackName = "No track playing";
    state.matchedTitle = "";
    renderTrackName();
    renderArtist("");
    showAlbumArt(null);
    if (changed) clearLyrics("Waiting for playback…");
    return;
  }

  state.trackName = payload.name;
  renderTrackName();
  renderArtist(payload.artists.join(", "));
  showAlbumArt(payload.albumArt);
  if (changed) clearLyrics("Looking for lyrics…");
});

const lyricsReady = listen<LyricsEvent>("lyrics", ({ payload }) => {
  // A late answer for a song that already changed is not shown.
  if (payload.generation !== state.generation || payload.trackId !== state.trackId) return;
  renderLyrics(payload);
});

// The recovery shortcut is the way back from a window that ignores the mouse, so it flips
// between the two absolute modes rather than cycling through "auto".
function toggleClickThrough() {
  if (!config) return;
  const clickThrough: ClickThrough = config.settings.clickThrough === "always" ? "off" : "always";
  void patchSettings({ clickThrough });
}

const statusReady = listen<StatusEvent>("status", ({ payload }) => {
  ui.statusText.textContent = payload.message;
  state.statusNotice = payload.notice;
  setNotice(state.notice);
  ui.reconnect.hidden = payload.state !== "error" && payload.state !== "needs-auth";
});

// ------------------------------------------------------------ command palette

/** Shown beside the palette's Settings command; Tauri reads it from the bundle. */
let appVersion = "";
const onOff = (on: boolean) => ({ text: on ? "ON" : "OFF", on });
const usable = (button: HTMLButtonElement) => () => !button.disabled;
const turn = (face: CubeFace, label: string, hint: string, words: string): Command => ({
  id: `turn${face[0].toUpperCase()}${face.slice(1)}`, group: "CUBE", icon: "■", label: `Turn cube: ${label}`, hint, words, run: () => deck.turnTo(face),
});

// Most commands click the control that already does the job, so the palette can
// never disagree with the window about what a command means.
const COMMANDS: Command[] = [
  {
    id: "playPause", group: "PLAYBACK", icon: () => (state.isPlaying ? "❚❚" : "▶"),
    label: () => (state.isPlaying ? "Pause" : "Play"), hint: () => (state.isPlaying ? "暫停" : "播放"),
    words: "toggle play pause", enabled: usable(ui.playPause), run: () => ui.playPause.click(),
  },
  { id: "next", group: "PLAYBACK", icon: "»", label: "Next track", hint: "下一首", words: "skip", enabled: usable(ui.next), run: () => ui.next.click() },
  { id: "previous", group: "PLAYBACK", icon: "«", label: "Previous track", hint: "上一首", words: "skip back", enabled: usable(ui.previous), run: () => ui.previous.click() },
  { id: "seekForward", group: "PLAYBACK", icon: "→", label: "Forward 10 seconds", hint: "快轉 10 秒", words: "seek", enabled: () => state.canSeek, run: () => seekBy(10_000) },
  { id: "seekBackward", group: "PLAYBACK", icon: "←", label: "Back 10 seconds", hint: "倒轉 10 秒", words: "seek rewind", enabled: () => state.canSeek, run: () => seekBy(-10_000) },
  { id: "volumeUp", group: "PLAYBACK", icon: "+", label: "Volume up", hint: "音量 +5", words: "louder", enabled: () => !ui.volume.disabled, run: () => nudgeVolume(5) },
  { id: "volumeDown", group: "PLAYBACK", icon: "−", label: "Volume down", hint: "音量 −5", words: "quieter", enabled: () => !ui.volume.disabled, run: () => nudgeVolume(-5) },
  { id: "queue", group: "PLAYBACK", icon: "≣", label: "Queue…", hint: "播放佇列", words: "up next queue list", enabled: usable(ui.queueOpen), run: () => ui.queueOpen.click() },
  {
    id: "shuffle", group: "PLAYBACK", icon: "⤨", label: "Shuffle", hint: "隨機播放", words: "random shuffle",
    state: () => onOff(modes.current.shuffle === true), visible: () => !ui.shuffle.hidden, enabled: usable(ui.shuffle), run: () => ui.shuffle.click(),
  },
  {
    id: "repeat", group: "PLAYBACK", icon: "⟲", label: "Repeat", hint: "循環播放", words: "repeat loop one all",
    state: () => ({ text: REPEAT_NAMES[modes.current.repeat ?? "off"].toUpperCase(), on: (modes.current.repeat ?? "off") !== "off" }),
    visible: () => !ui.repeat.hidden, enabled: usable(ui.repeat), run: () => ui.repeat.click(),
  },
  { id: "refreshPlayback", group: "PLAYBACK", icon: "↺", label: "Refresh playback", hint: "重新整理播放狀態", words: "sync", run: () => element("refresh-playback").click() },
  { id: "reconnect", group: "PLAYBACK", icon: "!", label: "Retry connection", hint: "重新連線", words: "reconnect", visible: () => !ui.reconnect.hidden, run: () => ui.reconnect.click() },
  { id: "followLyrics", group: "LYRICS", icon: "↧", label: "Follow lyrics", hint: "自動跟隨歌詞", words: "scroll auto", state: () => onOff(ui.follow.checked), enabled: () => !ui.follow.disabled, run: () => ui.follow.click() },
  {
    id: "translations", group: "LYRICS", icon: "文", label: "Show translations", hint: "顯示翻譯", words: "translation bilingual",
    state: () => onOff(state.showTranslations), run: () => setTranslations(!state.showTranslations),
  },
  { id: "findLyrics", group: "LYRICS", icon: "⌕", label: "Find lyrics…", hint: "搜尋歌詞", words: "search match", enabled: usable(ui.search), run: () => ui.search.click() },
  { id: "lyricsSource", group: "LYRICS", icon: "⇄", label: "Lyrics source…", hint: "歌詞來源", words: "provider", enabled: usable(ui.sourceBadge), run: () => ui.sourceBadge.click() },
  { id: "reloadLyrics", group: "LYRICS", icon: "↻", label: "Reload lyrics", hint: "重新載入歌詞", words: "refresh download", enabled: usable(ui.reload), run: () => ui.reload.click() },
  { id: "compact", group: "WINDOW", icon: "◱", label: "Compact mode", hint: "精簡模式", words: "mini small", state: () => onOff(document.body.classList.contains("is-compact")), enabled: usable(ui.mode), run: () => ui.mode.click() },
  {
    id: "compactLyrics", group: "WINDOW", icon: "☰", label: "Lyrics in compact mode", hint: "精簡模式顯示歌詞", words: "mini stretch lyrics show hide",
    state: () => onOff(ui.compactLyrics.checked), enabled: () => Boolean(config) && !ui.compactLyrics.disabled, run: () => ui.compactLyrics.click(),
  },
  { id: "alwaysOnTop", group: "WINDOW", icon: "▲", label: "Keep on top", hint: "置頂", words: "pin always", state: () => onOff(ui.pin.getAttribute("aria-pressed") === "true"), enabled: usable(ui.pin), run: () => ui.pin.click() },
  { id: "clickThrough", group: "WINDOW", icon: "◇", label: "Click-through", hint: "滑鼠穿透", words: "mouse ignore", state: () => onOff(config?.settings.clickThrough === "always"), run: toggleClickThrough },
  { id: "settings", group: "WINDOW", icon: "≡", label: "Settings…", hint: () => (appVersion ? `設定 · v${appVersion}` : "設定"), words: "preferences options version 版本", run: () => element("settings-open").click() },
  {
    id: "waveFull", group: "WINDOW", icon: "≈", label: "Sound wave in full mode", hint: "波動：完整模式", words: "wave visualizer floor ripple audio",
    state: () => onOff(config?.settings.waveFull ?? false), enabled: () => Boolean(config),
    run: () => void patchSettings({ waveFull: !config!.settings.waveFull }),
  },
  {
    id: "waveCompact", group: "WINDOW", icon: "≈", label: "Sound wave in compact mode", hint: "波動：精簡模式", words: "wave visualizer floor ripple audio mini",
    state: () => onOff(config?.settings.waveCompact ?? false), enabled: () => Boolean(config),
    run: () => void patchSettings({ waveCompact: !config!.settings.waveCompact }),
  },
  { id: "minimize", group: "WINDOW", icon: "_", label: "Minimize", hint: "最小化", words: "hide", run: () => element("win-minimize").click() },
  // Compact sizes its own window; filling the screen would leave the cube on a screenful of glass.
  {
    id: "maximize", group: "WINDOW", icon: "□", label: () => (document.body.classList.contains("is-maximized") ? "Restore" : "Maximize"), hint: "最大化", words: "maximize restore full",
    enabled: () => !document.body.classList.contains("is-compact"), run: () => element("win-maximize").click(),
  },
  turn("front", "Cover", "方塊轉到封面", "front"),
  turn("right", "Volume", "方塊轉到音量", "right dial"),
  turn("back", "Lyric tools", "方塊轉到歌詞工具", "back source find"),
  turn("left", "Window tools", "方塊轉到視窗工具", "left follow pin"),
];

/** The timed lines the palette can jump to by their words. */
function paletteLines() {
  if (!state.synced) return [];
  return state.cues.flatMap((cue, index) => {
    const text = cue.text.trim();
    return text ? [{ index, text, translation: cue.translation ?? "", time: formatTime(cue.time_ms) }] : [];
  });
}

const PALETTE_WIDTH = 600;
const PALETTE_HEIGHT = 540;
/** Settles once the palette window has loaded and is listening; made on first use. */
let paletteReady: Promise<WebviewWindow> | undefined;

function paletteWindow() {
  paletteReady ??= new Promise<WebviewWindow>((resolve, reject) => {
    const palette = new WebviewWindow("palette", {
      ...CHILD_WINDOW,
      url: "palette.html",
      title: "Hakuro Commands",
      width: PALETTE_WIDTH,
      height: PALETTE_HEIGHT,
      resizable: false,
      transparent: true,
      shadow: false,
    });
    void once(PALETTE_READY, () => resolve(palette));
    created(palette).catch(reject);
  }).catch((error) => {
    paletteReady = undefined;
    throw error;
  });
  return paletteReady;
}

async function openPalette() {
  try {
    const palette = await paletteWindow();
    const place = await placeOverMain(PALETTE_WIDTH, PALETTE_HEIGHT, 0.15);
    await palette.setSize(new LogicalSize(place.width, place.height));
    await palette.setPosition(new LogicalPosition(place.x, place.y));
    const bindings = config?.settings.shortcuts ?? DEFAULT_SHORTCUTS;
    const launcher = bindings.find((binding) => binding.action === "commands");
    const snapshot: PaletteSnapshot = {
      commands: describeCommands(COMMANDS, bindings),
      lines: paletteLines(),
      title: state.trackName,
      trackKey: state.trackId,
      accent: config?.settings.theme.accent,
      shortcut: launcher?.accelerator ?? "",
      shortcutGlobal: launcher?.global ?? false,
    };
    // The palette draws this, then shows itself and takes the focus.
    await emitTo("palette", PALETTE_SHOW, snapshot);
  } catch (error) {
    setNotice(String(error));
  }
}

element("cmdk-open").addEventListener("click", () => void openPalette());
function runShortcut(action: string) {
  if (action === "commands") { void openPalette(); return; }
  if (action === "clickThrough") { toggleClickThrough(); return; }
  const command = COMMANDS.find((item) => item.id === action);
  if (command && (command.enabled?.() ?? true) && (command.visible?.() ?? true)) command.run();
}
const shortcutReady = listen<string>("shortcut", ({ payload }) => runShortcut(payload));
window.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable=true]"))) return;
  const accelerator = shortcutFromEvent(event);
  if (!accelerator) return;
  const binding = (config?.settings.shortcuts ?? DEFAULT_SHORTCUTS).find((item) => !item.global && item.accelerator === accelerator);
  if (!binding) return;
  event.preventDefault();
  runShortcut(binding.action);
});

const paletteRunReady = listen<PaletteAction>(PALETTE_RUN, ({ payload }) => {
  void appWindow.setFocus();
  if ("command" in payload) {
    // Checked again here: the palette saw the window as it was when it opened.
    const command = COMMANDS[payload.command];
    if (command && (command.enabled?.() ?? true)) command.run();
    return;
  }
  // A line from a song that has since changed has nowhere to go.
  const cue = payload.trackKey === state.trackId ? state.cues[payload.line] : undefined;
  if (!cue || !state.canSeek) return;
  state.manualScrollUntil = 0;
  void send("seek", { positionMs: cue.time_ms });
});
const paletteClosedReady = listen(PALETTE_CLOSED, () => void appWindow.setFocus());

async function showVersion() {
  try {
    appVersion = await getVersion();
  } catch { /* outside Tauri there is no bundle to ask */ }
}

async function checkForUpdates() {
  if (!config?.settings.checkUpdates) return;
  try {
    const version = await invoke<string | null>("check_for_updates");
    if (!version || !config?.settings.checkUpdates) return;
    await openPanel("update", {
      url: `update.html?${new URLSearchParams({ version })}`, title: "Hakuro Update",
      width: 460, height: 320, minWidth: 360, minHeight: 260, drop: 0.5,
    });
  } catch { /* Offline or rate-limited: startup and playback continue normally. */ }
}

requestAnimationFrame(frame);

// Connect only once the listeners above exist, so no status is emitted into the
// void. A saved session resumes without the user pressing anything.
async function start() {
  try {
    await Promise.all([
      playbackReady, lyricsReady, statusReady, shortcutReady, previewReady, translationsReady,
      paletteRunReady, paletteClosedReady,
    ]);
    void syncMaximized();
    void showVersion();
    applyConfig(await invoke<Config>("get_config"));
    void checkForUpdates();
    // Only Spotify needs anything typed in before it can connect.
    if (config!.settings.player === "spotify" && !config!.settings.clientId) {
      ui.statusText.textContent = "Set up Spotify in Settings";
      await openSettings();
    }
    else await send("connect");
    if (config?.storageWarning && !state.notice) setNotice(config.storageWarning);
  } catch (error) { setNotice(String(error)); }
}
void start();
