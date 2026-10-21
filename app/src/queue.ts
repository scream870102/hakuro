/**
 * The queue window: the song playing now and what follows it, beside the main
 * window. Spotify and ytmdesktop offer playable rows, shuffle and repeat;
 * ytmdesktop2 lists its queue by title only, to read.
 *
 * Playback events reach every window, so this one follows the song on its own:
 * the progress runs from them, and the queue is read again when the song
 * changes, when shuffle reorders it, and whenever the window is focused.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { emptySample, formatTime, positionAt, type Sample } from "./clock";
import { applyTheme, type Config } from "./config";
import { createModes, nextRepeat, QUEUE_CHANGED, repeatLabel, shuffleLabel, type ModeReport, type Modes } from "./modes";
import { element, panel, reveal, wireClosing } from "./panel";

interface QueueItem {
  title: string;
  artists: string[];
  /** Zero when the player does not say. */
  durationMs: number;
  art: string | null;
  /** What jump_queue takes to reach it; empty when it cannot. */
  uri: string;
}

interface Queue {
  now: QueueItem | null;
  upcoming: QueueItem[];
  canJump: boolean;
}

interface PlaybackEvent extends ModeReport {
  trackKey: string;
  queueRevision?: string | null;
  hasTrack: boolean;
  progressMs: number | null;
  durationMs: number;
  isPlaying: boolean;
}

const ui = {
  lean: element("queue-lean"),
  shuffle: element<HTMLButtonElement>("queue-shuffle"),
  repeat: element<HTMLButtonElement>("queue-repeat"),
  now: element("queue-now"),
  nowArt: element("now-art"),
  nowTime: element("now-time"),
  nowTitle: element("now-title"),
  nowArtist: element("now-artist"),
  nowFill: element("now-fill"),
  label: element("queue-label"),
  list: element<HTMLOListElement>("queue-list"),
  empty: element("queue-empty"),
  emptyText: element("queue-empty-text"),
  status: element("queue-status"),
  refresh: element<HTMLButtonElement>("queue-refresh"),
};

/** The source's name, from the track key's prefix, or the stored player before any playback. */
const SOURCES: Record<string, string> = { sp: "SPOTIFY", spotify: "SPOTIFY", ytmd: "YTMDESKTOP", ytmdesktop: "YTMDESKTOP", ytmd2: "YTMDESKTOP2", ytmdesktop2: "YTMDESKTOP2" };
let source = "";
let queue: Queue | null = null;
let hint = "";
let sample: Sample = emptySample(performance.now());
let trackKey: string | null = null;
let reportedShuffle: boolean | null | undefined;
let queueRevision: string | null | undefined;
let serial = 0;
let jumping = false;

wireClosing();

function setStatus(text: string, error = false) {
  ui.status.textContent = text;
  ui.status.classList.toggle("is-error", error);
}

function setArt(target: HTMLElement, url: string | null) {
  target.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : "";
}

const artistLine = (item: QueueItem) => item.artists.join(", ");
const lengthText = (item: QueueItem) => (item.durationMs > 0 ? formatTime(item.durationMs) : "");

function render() {
  const upcoming = queue?.upcoming ?? [];
  const now = queue?.now ?? null;

  ui.now.hidden = !now;
  if (now) {
    ui.nowTitle.textContent = now.title;
    ui.nowArtist.textContent = artistLine(now) || "—";
    setArt(ui.nowArt, now.art);
  }

  ui.empty.hidden = Boolean(now || upcoming.length);
  ui.emptyText.textContent = "Nothing is playing.";
  ui.label.hidden = !ui.empty.hidden;
  ui.list.hidden = !ui.empty.hidden;
  ui.list.replaceChildren(...upcoming.map((item, index) => row(item, index)));
  if (now && !upcoming.length) {
    const none = document.createElement("li");
    none.className = "queue__none";
    none.textContent = "Nothing after this song.";
    ui.list.append(none);
  }
  // Only a queue that cannot be played from needs saying so.
  hint = !queue || queue.canJump ? "" : `${source || "THIS PLAYER"} · 僅能檢視`;
  setStatus(hint);
}

function row(item: QueueItem, index: number) {
  const li = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "qr";
  const playable = Boolean(queue?.canJump && item.uri);
  button.disabled = !playable;
  button.setAttribute("aria-label", playable ? `Play ${item.title}` : item.title);

  const number = document.createElement("span");
  number.className = "qr__num";
  number.textContent = String(index + 1).padStart(2, "0");
  const art = document.createElement("span");
  art.className = "art";
  setArt(art, item.art);
  const text = document.createElement("span");
  text.className = "qr__text";
  const title = document.createElement("span");
  title.className = "qr__title";
  title.textContent = item.title;
  const artist = document.createElement("span");
  artist.className = "qr__artist";
  artist.textContent = artistLine(item) || "—";
  text.append(title, artist);
  const time = document.createElement("span");
  time.className = "qr__time";
  time.textContent = lengthText(item);
  button.append(number, art, text, time);
  if (playable) button.addEventListener("click", () => void jump(item, index));
  li.append(button);
  return li;
}

/** Read the queue again; an answer overtaken by a newer read is dropped. */
async function load() {
  const mine = ++serial;
  ui.refresh.disabled = true;
  try {
    const fresh = await invoke<Queue>("get_queue");
    if (mine !== serial) return;
    queue = fresh;
    render();
  } catch (error) {
    if (mine !== serial) return;
    if (!queue) {
      ui.empty.hidden = false;
      ui.label.hidden = true;
      ui.list.hidden = true;
      ui.emptyText.textContent = String(error);
    }
    setStatus(String(error), true);
  } finally {
    if (mine === serial) ui.refresh.disabled = false;
  }
}

/** Spotify skips forward to the song, so the rows wait until it is there. */
async function jump(item: QueueItem, index: number) {
  // One skip run at a time: two would interleave and stop on the wrong song.
  if (jumping) return;
  jumping = true;
  ui.list.classList.add("is-busy");
  ui.list.setAttribute("aria-busy", "true");
  setStatus(`→ ${item.title}`);
  try {
    await invoke("jump_queue", { uri: item.uri, position: index });
    await load();
  } catch (error) {
    setStatus(String(error), true);
  } finally {
    jumping = false;
    ui.list.classList.remove("is-busy");
    ui.list.removeAttribute("aria-busy");
  }
}

const modes = createModes(renderModes, (error) => setStatus(error ?? hint, error !== null));

function renderModes(current: Readonly<Modes>) {
  ui.shuffle.hidden = current.shuffle === null && !current.canShuffle;
  ui.shuffle.disabled = !current.canShuffle;
  if (current.shuffle === null) ui.shuffle.removeAttribute("aria-pressed");
  else ui.shuffle.setAttribute("aria-pressed", String(current.shuffle));
  ui.shuffle.title = shuffleLabel(current.shuffle);
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
ui.refresh.addEventListener("click", () => void load());

function receive(payload: PlaybackEvent) {
  modes.receive(payload);
  sample = {
    positionMs: payload.progressMs,
    playing: payload.isPlaying,
    durationMs: payload.durationMs,
    receivedAt: performance.now(),
  };
  const prefix = payload.trackKey.split(":")[0];
  if (SOURCES[prefix] && SOURCES[prefix] !== source) {
    source = SOURCES[prefix];
    render();
  }
  const key = payload.hasTrack ? payload.trackKey : "";
  // A new song moves the queue on; Spotify reorders it when shuffle changes.
  const reshuffled = reportedShuffle !== undefined && payload.shuffle !== reportedShuffle;
  const queueChanged = queueRevision != null && payload.queueRevision != null && queueRevision !== payload.queueRevision;
  reportedShuffle = payload.shuffle;
  queueRevision = payload.queueRevision;
  if (trackKey !== null && (key !== trackKey || reshuffled || queueChanged)) void load();
  trackKey = key;
}

function frame(now: number) {
  if (queue?.now && sample.durationMs > 0) {
    const position = positionAt(sample, now);
    ui.nowTime.textContent = `${formatTime(position)} / ${formatTime(sample.durationMs)}`;
    ui.nowFill.style.width = `${(position / sample.durationMs) * 100}%`;
  } else if (queue?.now) {
    ui.nowTime.textContent = lengthText(queue.now);
    ui.nowFill.style.width = "0%";
  }
  requestAnimationFrame(frame);
}

async function start() {
  await listen<PlaybackEvent>("playback", ({ payload }) => receive(payload));
  await listen(QUEUE_CHANGED, () => void load());
  void panel.onFocusChanged(({ payload: focused }) => {
    if (focused) void load();
  });
  try {
    const config = await invoke<Config>("get_config");
    applyTheme(config.settings.theme);
    source ||= SOURCES[config.settings.player] ?? "";
  } catch {
    // The theme and the source name are only dressing; the queue still loads.
  }
  setStatus("READING…");
  const loading = load();
  // Ask for a playback sample now rather than at the next poll, for shuffle and repeat.
  void invoke("refresh_playback").catch(() => {});
  // Shown once filled in, unless the player is slow to answer.
  await Promise.race([loading, new Promise((resolve) => setTimeout(resolve, 600))]);
  requestAnimationFrame(frame);
  await reveal();
  ui.lean.classList.add("is-in");
}

void start();
