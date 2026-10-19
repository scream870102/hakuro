/**
 * Presentation layer. Every network call lives in Rust; this file renders what
 * the backend emits and extrapolates the position between polls so the current
 * line moves smoothly instead of stepping once every 1.5 s.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { activeLine, emptySample, formatTime, positionAt, type Sample } from "./clock";

interface Cue {
  time_ms: number;
  text: string;
  translation?: string | null;
  words?: { start_ms: number; end_ms: number; text: string }[];
}

interface LyricCandidate {
  source: string;
  id: string;
  title: string;
  artists: string[];
  album: string;
  duration_ms: number;
}

interface LyricsResult {
  text: string;
  source: string;
  matched_title: string;
  cues: Cue[];
  errors: unknown[];
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
  volumePercent?: number | null;
  canSetVolume?: boolean;
  deviceName: string | null;
  deviceId?: string | null;
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

type ClickThrough = "off" | "auto" | "always";
/** Which player Hakuro follows. Exactly one is live at a time. */
type PlayerKind = "spotify" | "ytmusic";

interface Settings {
  player: PlayerKind;
  clientId: string;
  sources: { id: string; enabled: boolean }[];
  theme: { accent: string; activeLine: string; pastLine: string };
  followLyrics: boolean;
  alwaysOnTop: boolean;
  /** Background opacity as a percentage; the lyrics stay opaque regardless. */
  opacity: number;
  clickThrough: ClickThrough;
  compact: boolean;
  compactOpacity: number;
  lyricSize: number;
  compactLyricSize: number;
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
  pin: element<HTMLButtonElement>("pin"),
  mode: element<HTMLButtonElement>("mode-toggle"),
  reload: element<HTMLButtonElement>("reload"),
  reconnect: element<HTMLButtonElement>("reconnect"),
  search: element<HTMLButtonElement>("lyrics-search-open"),
  volume: element<HTMLInputElement>("volume"),
  volumeValue: element<HTMLOutputElement>("volume-value"),
  volumeControl: element("volume-control"),
};

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
  ui.sourceBadge.textContent = "Lyrics source ▾";
  ui.lyricsEmpty.textContent = placeholder;
  ui.lyricsEmpty.hidden = false;
  updateTranslationLayout();
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
      return span;
    });
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
      span.classList.toggle("is-singing", position >= word.start_ms && position < word.end_ms);
      span.classList.toggle("is-sung", position >= word.end_ms);
    });
  }
  requestAnimationFrame(frame);
}

// ----------------------------------------------------------------- commands

async function send(command: string, args?: Record<string, unknown>) {
  try {
    await invoke(command, args);
    setNotice("");
  } catch (error) {
    // The player's own refusal text, e.g. Spotify's Premium or no-active-device
    // message, or a transport button the media session does not offer.
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
    ? "Spotify active device volume"
    : config?.settings.player === "ytmusic"
      ? "YouTube Music does not expose volume control through Windows media sessions"
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

/** Reflect the pin in the button and in the window itself. */
function setPinned(pinned: boolean) {
  ui.pin.setAttribute("aria-pressed", String(pinned));
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

// Compact keeps the header, three lines and the scrubber. These numbers mirror
// `body.is-compact` in the stylesheet, so the window can never be dragged
// smaller than the three lines the mode promises.
const COMPACT_MIN_WIDTH = 340;
// Header only: chrome (32px), art (34px), volume (24px), two gaps (8px)
// and bottom padding (6px), with a little slack. The scrubber costs nothing extra
// because compact lifts it into the chrome row.
const COMPACT_CHROME = 108;
const FULL_MIN_WIDTH = 520;
const FULL_MIN_HEIGHT = 460;

const compactMinHeight = (lyricSize: number) =>
  Math.ceil(3 * (document.body.classList.contains("has-translations") ? lyricSize * 2.23 + 22 : lyricSize * 1.32 + 18)) + COMPACT_CHROME;

function updateTranslationLayout() {
  const visible = element<HTMLInputElement>("show-translations").checked;
  document.body.classList.toggle("hide-translations", !visible);
  document.body.classList.toggle("has-translations", visible && state.cues.some((cue) => Boolean(cue.translation)));
  if (config?.settings.compact) void applyWindowBounds(config.settings);
}

/** The full-mode size to come back to, remembered at the moment of switching. */
let roomySize: LogicalSize | undefined;
let appliedCompact: boolean | undefined;

async function applyWindowBounds(settings: Settings) {
  const { compact, compactLyricSize } = settings;
  const minHeight = compactMinHeight(compactLyricSize);
  await appWindow.setMinSize(
    compact
      ? new LogicalSize(COMPACT_MIN_WIDTH, minHeight)
      : new LogicalSize(FULL_MIN_WIDTH, FULL_MIN_HEIGHT),
  );

  const first = appliedCompact === undefined;
  const switched = !first && appliedCompact !== compact;
  appliedCompact = compact;
  // Full mode opens at the size the configuration asks for. Compact has to
  // shrink even on the first run: nothing remembers the window size between
  // launches, so otherwise a stored compact mode would reopen at full size.
  if (!switched && !(first && compact)) return;

  if (compact) {
    roomySize = (await appWindow.innerSize()).toLogical(await appWindow.scaleFactor());
    await appWindow.setSize(new LogicalSize(Math.max(COMPACT_MIN_WIDTH, 460), minHeight));
  } else if (roomySize) {
    await appWindow.setSize(roomySize);
  }
}

ui.mode.addEventListener("click", () => {
  if (!config) return;
  void patchSettings({ compact: !config.settings.compact }, ui.mode);
});

ui.pin.addEventListener("click", () => {
  if (!config) return;
  const alwaysOnTop = ui.pin.getAttribute("aria-pressed") !== "true";
  // Move the window first: the click should land even if the save then fails.
  setPinned(alwaysOnTop);
  void patchSettings({ alwaysOnTop }, ui.pin);
});

/** How long the follow toggle and refresh button wait before stepping aside. */
const IDLE_AFTER_MS = 3000;
let idleTimer = 0;

function wake() {
  document.body.classList.remove("is-idle");
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => document.body.classList.add("is-idle"), IDLE_AFTER_MS);
}

for (const name of ["pointermove", "pointerdown", "keydown", "wheel"]) {
  window.addEventListener(name, wake, { passive: true });
}

// Start the clock at launch: "nothing has happened yet" is also idle.
wake();

element("win-minimize").addEventListener("click", () => void appWindow.minimize());
element("win-maximize").addEventListener("click", () => void appWindow.toggleMaximize());
element("win-close").addEventListener("click", () => void appWindow.close());

// The glyph has to follow every route to maximized — the button, a double-click
// on the drag region, and Win+Up — so it tracks the resize rather than the click.
async function syncMaximized() {
  document.body.classList.toggle("is-maximized", await appWindow.isMaximized());
}
window.addEventListener("resize", () => void syncMaximized());

// --------------------------------------------------------------- transport

ui.playPause.addEventListener("click", () => void send(state.isPlaying ? "pause" : "play"));
ui.next.addEventListener("click", () => void send("next_track"));
ui.previous.addEventListener("click", () => void send("previous_track"));
ui.reload.addEventListener("click", () => void send("reload_lyrics"));
element("refresh-playback").addEventListener("click", () => void send("refresh_playback"));
ui.reconnect.addEventListener("click", () => void send("connect"));

let config: Config | undefined;
let draft: Settings;
/** The four per-mode dials in the panel, each with its own readout. */
const DIALS = [
  { input: "settings-opacity", output: "opacity-value", unit: "%", key: "opacity" },
  { input: "settings-compact-opacity", output: "compact-opacity-value", unit: "%", key: "compactOpacity" },
  { input: "settings-lyric-size", output: "lyric-size-value", unit: "px", key: "lyricSize" },
  { input: "settings-compact-lyric-size", output: "compact-lyric-size-value", unit: "px", key: "compactLyricSize" },
] as const;

const dialValue = (id: string) => Number(element<HTMLInputElement>(id).value);

/**
 * Show the panel's numbers on the window behind it, for whichever mode is on.
 * Judging an opacity or a type size from a number alone is guesswork; Cancel
 * puts the stored values back.
 */
function previewWindowStyle() {
  const compact = document.body.classList.contains("is-compact");
  setWindowStyle(
    dialValue(compact ? "settings-compact-opacity" : "settings-opacity"),
    dialValue(compact ? "settings-compact-lyric-size" : "settings-lyric-size"),
  );
}

for (const dial of DIALS) {
  const input = element<HTMLInputElement>(dial.input);
  input.addEventListener("input", () => {
    element(dial.output).textContent = `${input.value}${dial.unit}`;
    previewWindowStyle();
  });
}
const settingsDialog = element<HTMLDialogElement>("settings-dialog");
const sourceDialog = element<HTMLDialogElement>("source-dialog");
const sourceSelect = element<HTMLSelectElement>("track-source");
let sourceTrackId = "";
const settingsError = element("settings-error");

/**
 * Dismiss a modal dialog by clicking away from it, or by pressing Escape.
 *
 * A modal dialog's backdrop is the dialog element itself, and the dialog is
 * padded, so the target of the event cannot say whether the click landed
 * outside — a click in the padding targets the dialog too. The box it occupies
 * can say, so that is what is measured.
 *
 * Both the press and the release have to land outside. Selecting text or
 * dragging a slider often ends beyond the edge, and throwing away the panel
 * because a drag overshot would be its own bug.
 */
function dismissOnClickAway(dialog: HTMLDialogElement, dismiss: () => void) {
  const outside = (event: MouseEvent) => {
    const box = dialog.getBoundingClientRect();
    return (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    );
  };
  let pressedOutside = false;
  dialog.addEventListener("pointerdown", (event) => { pressedOutside = outside(event); });
  dialog.addEventListener("click", (event) => {
    const away = pressedOutside && outside(event);
    pressedOutside = false;
    if (away) dismiss();
  });
  // Escape dismisses a dialog without reaching either button, which would
  // otherwise leave a preview applied that was never saved.
  dialog.addEventListener("cancel", dismiss);
}

function applyConfig(value: Config) {
  const changedPlayer = config && config.settings.player !== value.settings.player;
  config = value;
  if (changedPlayer) resetVolume();
  const { theme } = value.settings;
  document.documentElement.style.setProperty("--accent", theme.accent);
  document.documentElement.style.setProperty("--active-line", theme.activeLine);
  document.documentElement.style.setProperty("--past-line", theme.pastLine);
  ui.follow.checked = value.settings.followLyrics;

  const { compact } = value.settings;
  document.body.classList.toggle("is-compact", compact);
  ui.mode.setAttribute("aria-pressed", String(compact));
  ui.mode.title = compact ? "Full mode" : "Compact mode";
  setWindowStyle(
    compact ? value.settings.compactOpacity : value.settings.opacity,
    compact ? value.settings.compactLyricSize : value.settings.lyricSize,
  );
  void applyWindowBounds(value.settings);
  setPinned(value.settings.alwaysOnTop);
}

/** The two per-mode dials, applied together because both come from one mode. */
function setWindowStyle(opacity: number, lyricSize: number) {
  const root = document.documentElement.style;
  root.setProperty("--ui-opacity", String(opacity / 100));
  root.setProperty("--lyric-size", `${lyricSize}px`);
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

/** Only Spotify has anything to configure, so the rest of the panel is hidden. */
function showPlayerSettings(player: PlayerKind) {
  element("spotify-settings").hidden = player !== "spotify";
}

element<HTMLSelectElement>("settings-player").addEventListener("change", (event) => {
  showPlayerSettings((event.target as HTMLSelectElement).value as PlayerKind);
});

async function openSettings() {
  try {
    const value = await invoke<Config>("get_config");
    config = value;
    draft = structuredClone(value.settings);
    element<HTMLSelectElement>("settings-player").value = draft.player;
    showPlayerSettings(draft.player);
    element<HTMLInputElement>("client-id").value = draft.clientId;
    element<HTMLInputElement>("color-accent").value = draft.theme.accent;
    element<HTMLInputElement>("color-active").value = draft.theme.activeLine;
    element<HTMLInputElement>("color-past").value = draft.theme.pastLine;
    element<HTMLInputElement>("settings-follow").checked = draft.followLyrics;
    for (const dial of DIALS) {
      element<HTMLInputElement>(dial.input).value = String(draft[dial.key]);
      element(dial.output).textContent = `${draft[dial.key]}${dial.unit}`;
    }
    element<HTMLSelectElement>("settings-click-through").value = draft.clickThrough;
    element("storage-info").textContent = `Data folder: ${value.dataDir} · Cached songs: ${value.storedTracks}`;
    settingsError.textContent = value.storageWarning;
    renderSourceOrder();
    if (!settingsDialog.open) settingsDialog.showModal();
  } catch (error) { setNotice(String(error)); }
}

element("settings-open").addEventListener("click", () => void openSettings());

/**
 * Leaving without saving puts back what was stored, because the size and
 * opacity dials preview themselves on the live window as they move.
 */
function cancelSettings() {
  settingsDialog.close();
  if (config) applyConfig(config);
}
element("settings-cancel").addEventListener("click", cancelSettings);
dismissOnClickAway(settingsDialog, cancelSettings);
element("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element<HTMLButtonElement>("settings-save");
  button.disabled = true;
  settingsError.textContent = "";
  draft.player = element<HTMLSelectElement>("settings-player").value as PlayerKind;
  draft.clientId = element<HTMLInputElement>("client-id").value.trim();
  draft.theme = {
    accent: element<HTMLInputElement>("color-accent").value,
    activeLine: element<HTMLInputElement>("color-active").value,
    pastLine: element<HTMLInputElement>("color-past").value,
  };
  draft.followLyrics = element<HTMLInputElement>("settings-follow").checked;
  for (const dial of DIALS) draft[dial.key] = dialValue(dial.input);
  draft.clickThrough = element<HTMLSelectElement>("settings-click-through").value as ClickThrough;
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
dismissOnClickAway(sourceDialog, () => sourceDialog.close());
element("source-save").addEventListener("click", async () => {
  const button = element<HTMLButtonElement>("source-save");
  button.disabled = true;
  try {
    await invoke("set_track_source", { source: sourceSelect.value || null, trackId: sourceTrackId });
    sourceDialog.close();
  } catch (error) { element("source-error").textContent = String(error); }
  finally { button.disabled = false; }
});

// Manual matching has one request serial shared by search and preview. Editing
// a query, closing, or changing tracks invalidates any outstanding response.
const searchDialog = element<HTMLDialogElement>("lyrics-search-dialog");
const searchQuery = element<HTMLInputElement>("lyrics-query");
const searchSource = element<HTMLSelectElement>("lyrics-search-source");
const searchStatus = element("lyrics-search-status");
const candidatesList = element("lyrics-candidates");
const previewPanel = element("lyrics-preview-panel");
const previewText = element("lyrics-preview");
const matchApply = element<HTMLButtonElement>("lyrics-match-apply");
const matchClear = element<HTMLButtonElement>("lyrics-match-clear");
let searchTrackId = "";
let searchSerial = 0;
let selectedCandidate: LyricCandidate | undefined;
let matchSaving = false;

function resetSearch() {
  searchSerial++;
  selectedCandidate = undefined;
  matchApply.disabled = true;
  previewPanel.hidden = true;
  previewText.textContent = "";
  candidatesList.replaceChildren();
  searchStatus.textContent = "";
}

function closeSearch() {
  resetSearch();
  searchDialog.close();
  ui.search.focus();
}

const searchIsCurrent = (serial: number, trackId: string) =>
  searchDialog.open && serial === searchSerial && trackId === state.trackId && trackId === searchTrackId;

ui.search.addEventListener("click", () => {
  if (!config || !state.trackId || matchSaving) return;
  resetSearch();
  searchTrackId = state.trackId;
  element("lyrics-search-track").textContent = `${state.trackName} · ${ui.trackArtist.textContent}`;
  searchQuery.value = `${state.trackName} ${ui.trackArtist.textContent}`.trim();
  searchSource.replaceChildren();
  for (const source of config.settings.sources) {
    if (!source.enabled || !["lrclib", "netease", "qqmusic"].includes(source.id)) continue;
    const label = config.providers.find((provider) => provider.id === source.id)?.label ?? source.id;
    searchSource.add(new Option(label, source.id));
  }
  element<HTMLButtonElement>("lyrics-search-submit").disabled = !searchSource.options.length;
  if (!searchSource.options.length) searchStatus.textContent = "Enable LRCLIB, NetEase or QQ Music in Settings to search.";
  matchClear.disabled = !state.manual || matchSaving;
  searchDialog.showModal();
  searchQuery.focus();
  searchQuery.select();
});

element("lyrics-search-close").addEventListener("click", closeSearch);
dismissOnClickAway(searchDialog, closeSearch);
searchDialog.addEventListener("close", () => { searchSerial++; });
searchQuery.addEventListener("input", resetSearch);
searchSource.addEventListener("change", resetSearch);
element("show-translations").addEventListener("change", updateTranslationLayout);

async function previewCandidate(candidate: LyricCandidate, button: HTMLButtonElement) {
  const serial = ++searchSerial;
  const trackId = searchTrackId;
  selectedCandidate = undefined;
  matchApply.disabled = true;
  previewPanel.hidden = true;
  searchStatus.textContent = "Loading preview…";
  candidatesList.querySelectorAll("button").forEach((row) => row.setAttribute("aria-pressed", String(row === button)));
  try {
    const result = await invoke<LyricsResult>("preview_lyric_candidate", { trackId, candidate });
    if (!searchIsCurrent(serial, trackId)) return;
    const text = result.cues.length
      ? result.cues.map((cue) => `${formatTime(cue.time_ms)}  ${cue.text}${cue.translation ? `\n    ${cue.translation}` : ""}`).join("\n")
      : result.text;
    previewText.textContent = text;
    previewPanel.hidden = !text;
    searchStatus.textContent = text ? "Preview ready. Use these lyrics to remember this match for this song." : "This candidate has no lyrics. Try another result.";
    if (text) {
      selectedCandidate = candidate;
      matchApply.disabled = matchSaving;
    }
  } catch (error) {
    if (searchIsCurrent(serial, trackId)) searchStatus.textContent = String(error);
  }
}

element("lyrics-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (matchSaving || !searchQuery.value.trim() || !searchSource.value || searchTrackId !== state.trackId) return;
  resetSearch();
  const serial = searchSerial;
  const trackId = searchTrackId;
  searchStatus.textContent = "Searching…";
  try {
    const candidates = await invoke<LyricCandidate[]>("search_lyrics", {
      trackId, query: searchQuery.value.trim(), source: searchSource.value,
    });
    if (!searchIsCurrent(serial, trackId)) return;
    searchStatus.textContent = candidates.length ? `${candidates.length} results. Choose one to preview.` : "No results. Try another title, artist or source.";
    for (const candidate of candidates) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lyric-candidate";
      button.setAttribute("aria-pressed", "false");
      const title = document.createElement("strong");
      title.textContent = candidate.title;
      const detail = document.createElement("span");
      detail.textContent = [candidate.artists.join(", "), candidate.album, candidate.duration_ms > 0 ? formatTime(candidate.duration_ms) : "", candidate.source].filter(Boolean).join(" · ");
      button.append(title, detail);
      button.addEventListener("click", () => { if (!matchSaving) void previewCandidate(candidate, button); });
      row.append(button);
      candidatesList.append(row);
    }
  } catch (error) {
    if (searchIsCurrent(serial, trackId)) searchStatus.textContent = String(error);
  }
});

async function saveMatch(clear: boolean) {
  if (matchSaving || searchTrackId !== state.trackId || !searchDialog.open || (!clear && !selectedCandidate)) return;
  const serial = ++searchSerial;
  const trackId = searchTrackId;
  matchSaving = true;
  ui.search.disabled = true;
  searchQuery.disabled = true;
  searchSource.disabled = true;
  element<HTMLButtonElement>("lyrics-search-submit").disabled = true;
  matchApply.disabled = true;
  matchClear.disabled = true;
  searchStatus.textContent = clear ? "Restoring automatic search…" : "Saving match…";
  try {
    await invoke(clear ? "clear_lyric_match" : "apply_lyric_match", clear ? { trackId } : { trackId, candidate: selectedCandidate });
    if (searchIsCurrent(serial, trackId)) closeSearch();
  } catch (error) {
    if (searchIsCurrent(serial, trackId)) searchStatus.textContent = String(error);
  } finally {
    matchSaving = false;
    ui.search.disabled = !state.trackId || !config;
    if (!searchDialog.open) ui.search.focus();
    searchQuery.disabled = false;
    searchSource.disabled = false;
    element<HTMLButtonElement>("lyrics-search-submit").disabled = !searchSource.options.length;
    if (searchIsCurrent(serial, trackId)) {
      matchApply.disabled = !selectedCandidate;
      matchClear.disabled = !state.manual;
    }
  }
}
matchApply.addEventListener("click", () => void saveMatch(false));
matchClear.addEventListener("click", () => void saveMatch(true));

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
  const trackId = payload.hasTrack ? payload.trackId || `${payload.name}|${payload.durationMs}` : "";
  if (state.trackId !== trackId) {
    sourceDialog.close();
    if (searchDialog.open) closeSearch();
    state.requestedSource = "";
  }
  state.trackId = trackId;
  ui.sourceBadge.disabled = !payload.hasTrack || !config;
  ui.reload.disabled = !payload.hasTrack;
  ui.search.disabled = !payload.hasTrack || !config || matchSaving;
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
    state.trackName = "No track playing";
    state.matchedTitle = "";
    renderTrackName();
    ui.trackArtist.textContent = "";
    showAlbumArt(null);
    if (changed) clearLyrics("Waiting for playback…");
    return;
  }

  state.trackName = payload.name;
  renderTrackName();
  ui.trackArtist.textContent = payload.artists.join(", ");
  showAlbumArt(payload.albumArt);
  if (changed) clearLyrics("Looking for lyrics…");
});

const lyricsReady = listen<LyricsEvent>("lyrics", ({ payload }) => {
  // A late answer for a song that already changed is not shown.
  if (payload.generation !== state.generation || payload.trackId !== state.trackId) return;
  renderLyrics(payload);
});

// Ctrl+Alt+P is the way back from a window that ignores the mouse, so it flips
// between the two absolute modes rather than cycling through "auto".
const clickThroughReady = listen("toggle-click-through", () => {
  if (!config) return;
  const clickThrough: ClickThrough = config.settings.clickThrough === "always" ? "off" : "always";
  void patchSettings({ clickThrough });
});

const statusReady = listen<StatusEvent>("status", ({ payload }) => {
  ui.statusText.textContent = payload.message;
  state.statusNotice = payload.notice;
  setNotice(state.notice);
  ui.reconnect.hidden = payload.state !== "error" && payload.state !== "needs-auth";
  // A connection that needs attention should not be hidden by the idle fade.
  if (!ui.reconnect.hidden) wake();
});

requestAnimationFrame(frame);

// Connect only once the listeners above exist, so no status is emitted into the
// void. A saved session resumes without the user pressing anything.
async function start() {
  try {
    await Promise.all([playbackReady, lyricsReady, statusReady, clickThroughReady]);
    void syncMaximized();
    applyConfig(await invoke<Config>("get_config"));
    // Only Spotify needs anything typed in before it can connect.
    if (config!.settings.player === "spotify" && !config!.settings.clientId) {
      ui.statusText.textContent = "Set up Spotify in Settings";
      await openSettings();
    }
    else await send("connect");
  } catch (error) { setNotice(String(error)); }
}
void start();
