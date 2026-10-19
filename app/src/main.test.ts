// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitTo: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  focus: [] as ((event: { payload: boolean }) => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
const appWindow = vi.hoisted(() => ({
  setAlwaysOnTop: vi.fn(),
  setIgnoreCursorEvents: vi.fn(),
  minimize: vi.fn(),
  toggleMaximize: vi.fn(),
  close: vi.fn(),
  isMaximized: vi.fn(),
  onFocusChanged: vi.fn(),
  setMinSize: vi.fn(),
  setSize: vi.fn(),
  innerSize: vi.fn(),
  scaleFactor: vi.fn(),
  outerPosition: vi.fn(),
  outerSize: vi.fn(),
  setFocus: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow, currentMonitor: async () => null }));
/** Every child window main.ts opens, by label, with the options it was given. */
const children = vi.hoisted(() => new Map<string, {
  options: Record<string, unknown>;
  events: Map<string, (event: { payload: unknown }) => void>;
  setFocus: ReturnType<typeof vi.fn>;
  setSize: ReturnType<typeof vi.fn>;
  setPosition: ReturnType<typeof vi.fn>;
}>());
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    options: Record<string, unknown>;
    events = new Map<string, (event: { payload: unknown }) => void>();
    setFocus = vi.fn();
    setSize = vi.fn();
    setPosition = vi.fn();
    constructor(label: string, options: Record<string, unknown>) {
      this.options = options;
      children.set(label, this);
      queueMicrotask(() => this.events.get("tauri://created")?.({ payload: null }));
    }
    async once(name: string, callback: (event: { payload: unknown }) => void) {
      this.events.set(name, callback);
      return () => {};
    }
    static async getByLabel(label: string) { return children.get(label) ?? null; }
  },
}));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));
vi.mock("@tauri-apps/api/event", () => {
  const listen = vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  });
  return { listen, once: listen, emitTo: bridge.emitTo };
});

const initial = () => ({
  settings: {
    player: "spotify",
    clientId: "a".repeat(32),
    sources: [{ id: "lrclib", enabled: true }, { id: "musixmatch", enabled: true }],
    theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" },
    followLyrics: true,
    alwaysOnTop: false,
    opacity: 100,
    clickThrough: "off",
    compact: false,
    compactOpacity: 85,
    lyricSize: 26,
    compactLyricSize: 18,
  },
  providers: [{ id: "lrclib", label: "LRCLIB" }, { id: "musixmatch", label: "Musixmatch" }],
  dataDir: "C:/Hakuro", storedTracks: 2, storageWarning: "",
});
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
function runFrame() {
  const callbacks = vi.mocked(requestAnimationFrame).mock.calls;
  callbacks[callbacks.length - 1][0](performance.now());
}
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function playback(trackId = "song-a", generation = 1, progressMs = 0, isPlaying = false, volume: { volumePercent?: number | null; canSetVolume?: boolean; deviceName?: string | null; deviceId?: string | null } = {}) {
  bridge.listeners.get("playback")!({ payload: {
    trackId, generation, name: trackId, artists: ["Artist"], album: "Album", albumArt: null,
    durationMs: 100000, progressMs, isPlaying, hasTrack: true,
    canSkipNext: true, canSkipPrevious: true, canSeek: true, deviceName: null, ...volume,
    // As the backend builds it: source-prefixed, falling back to name and length.
    trackKey: `spotify:${trackId || `${trackId}|100000`}`,
  } });
}
function lyrics(generation: number, text: string, matchedTitle = "") {
  bridge.listeners.get("lyrics")!({ payload: {
    generation, trackId: generation === 1 ? "spotify:song-a" : "spotify:song-b", source: "LRCLIB",
    synced: false, cues: [], text, matchedTitle, partial: false, requested: "",
  } });
}

beforeEach(async () => {
  vi.resetModules();
  bridge.listeners.clear();
  bridge.invoke.mockReset();
  bridge.focus.length = 0;
  for (const fn of Object.values(appWindow)) fn.mockReset().mockResolvedValue(undefined);
  appWindow.isMaximized.mockResolvedValue(false);
  appWindow.scaleFactor.mockResolvedValue(1);
  appWindow.innerSize.mockResolvedValue({ toLogical: () => ({ width: 940, height: 760 }) });
  appWindow.outerPosition.mockResolvedValue({ x: 100, y: 50 });
  appWindow.outerSize.mockResolvedValue({ width: 940, height: 760 });
  bridge.emitTo.mockReset().mockResolvedValue(undefined);
  children.clear();
  appWindow.onFocusChanged.mockImplementation(async (cb: (e: { payload: boolean }) => void) => {
    bridge.focus.push(cb);
    return () => {};
  });
  document.documentElement.innerHTML = html;
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  HTMLElement.prototype.scrollTo = vi.fn();
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return initial();
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
});

it("highlights words from the playback clock across pause and seeks, displays translations, and accepts old cues", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 1500);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "NetEase", synced: true, text: "", partial: false, requested: "",
    cues: [
      { time_ms: 1000, text: "Hello world", translation: "你好世界", words: [
        { start_ms: 1000, end_ms: 2000, text: "Hello " }, { start_ms: 2000, end_ms: 3000, text: "world" },
      ] },
      { time_ms: 4000, text: "Old cue" },
    ],
  } });
  runFrame();
  const spans = el("lyrics-list").querySelectorAll(".lyric-word");
  expect(spans[0].classList.contains("is-singing")).toBe(true);
  expect(spans[1].classList.contains("is-singing")).toBe(false);
  expect(el("lyrics-list").querySelector(".lyric-translation")?.textContent).toBe("你好世界");
  expect(document.body.classList.contains("has-translations")).toBe(true);
  runFrame(); // paused playback keeps the same word
  expect(spans[0].classList.contains("is-singing")).toBe(true);
  playback("song-a", 1, 2500);
  runFrame();
  expect(spans[0].classList.contains("is-sung")).toBe(true);
  expect(spans[1].classList.contains("is-singing")).toBe(true);
  playback("song-a", 1, 5000);
  runFrame();
  expect(spans[1].classList.contains("is-singing")).toBe(false);
  expect(el("lyrics-list").children[1].classList.contains("is-active")).toBe(true);
  playback("song-a", 1, 1500);
  runFrame();
  expect(spans[0].classList.contains("is-singing")).toBe(true);
  expect(spans[1].classList.contains("is-sung")).toBe(false);
  bridge.listeners.get("search:translations")!({ payload: false });
  expect(document.body.classList.contains("hide-translations")).toBe(true);
  expect(document.body.classList.contains("has-translations")).toBe(false);
  lyrics(1, "Old plain text");
  expect(el("lyrics-list").textContent).toBe("Old plain text");
  expect(el("source-badge").textContent).not.toContain("Manual");
});

it("commits volume only on change, accepts keyboard changes and the 0/100 endpoints", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, false, { volumePercent: 50, canSetVolume: true });
  const volume = el<HTMLInputElement>("volume");
  expect(volume.disabled).toBe(false);
  expect(el("volume-value").textContent).toBe("50%");
  expect(volume.min).toBe("0");
  expect(volume.max).toBe("100");
  volume.focus();
  volume.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
  // jsdom does not implement native range key handling; simulate its resulting
  // value/input/change sequence, which is the same sequence in a browser.
  volume.value = "51";
  volume.dispatchEvent(new Event("input"));
  expect(el("volume-value").textContent).toBe("51%");
  expect(bridge.invoke.mock.calls.some(([command]) => command === "set_volume")).toBe(false);
  volume.dispatchEvent(new Event("change"));
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_volume", { volumePercent: 51 });
  for (const value of [0, 100]) {
    volume.value = String(value);
    volume.dispatchEvent(new Event("input"));
    volume.dispatchEvent(new Event("change"));
    await flush();
    expect(bridge.invoke).toHaveBeenCalledWith("set_volume", { volumePercent: value });
    expect(el("volume-value").textContent).toBe(`${value}%`);
  }
});

it("keeps a volume drag stable across polls and restores the latest confirmed volume on failure", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, false, { volumePercent: 30, canSetVolume: true });
  const volume = el<HTMLInputElement>("volume");
  volume.dispatchEvent(new Event("pointerdown"));
  volume.value = "70";
  volume.dispatchEvent(new Event("input"));
  playback("song-a", 1, 0, false, { volumePercent: 35, canSetVolume: true });
  expect(volume.value).toBe("70");
  expect(el("volume-value").textContent).toBe("70%");
  let reject!: (reason: string) => void;
  bridge.invoke.mockImplementationOnce(() => new Promise((_, rejectPromise) => { reject = rejectPromise; }));
  volume.dispatchEvent(new Event("change"));
  expect(volume.disabled).toBe(true);
  playback("song-a", 1, 0, false, { volumePercent: 40, canSetVolume: true });
  expect(volume.value).toBe("70");
  volume.dispatchEvent(new Event("change"));
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "set_volume")).toHaveLength(1);
  reject("Volume refused");
  await flush();
  expect(volume.disabled).toBe(false);
  expect(volume.value).toBe("40");
  expect(el("volume-value").textContent).toBe("40%");
  expect(el("notice").textContent).toBe("Volume refused");
});

it("disables unsupported volume and discards pending replies when the player changes", async () => {
  await import("./main");
  await flush();
  const volume = el<HTMLInputElement>("volume");
  playback(); // Older playback events have no volume capability.
  expect(volume.disabled).toBe(true);
  volume.dispatchEvent(new Event("change"));
  expect(bridge.invoke.mock.calls.some(([command]) => command === "set_volume")).toBe(false);
  playback("song-a", 1, 0, false, { volumePercent: 25, canSetVolume: true });
  let reject!: (reason: string) => void;
  bridge.invoke.mockImplementationOnce(() => new Promise((_, rejectPromise) => { reject = rejectPromise; }));
  volume.value = "80";
  volume.dispatchEvent(new Event("change"));
  el("settings-open").click();
  await flush();
  await flush();
  // YouTube Music is saved in the settings window, which then closes.
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, player: "ytmusic" } };
  });
  children.get("settings")!.events.get("tauri://destroyed")!({ payload: null });
  await flush();
  playback("ytmusic:song-b", 2, 0, false, { volumePercent: null, canSetVolume: false });
  reject("Old Spotify error");
  await flush();
  expect(volume.disabled).toBe(true);
  expect(el("volume-value").textContent).toBe("—");
  expect(el("volume-control").title).toContain("YouTube Music");
  expect(el("notice").textContent).not.toContain("Old Spotify error");
});

it("does not apply an old volume reply to a different device with the same name", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, false, { volumePercent: 25, canSetVolume: true, deviceName: "Speaker", deviceId: "first" });
  const volume = el<HTMLInputElement>("volume");
  let finish!: () => void;
  bridge.invoke.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
  volume.value = "80";
  volume.dispatchEvent(new Event("change"));
  playback("song-a", 1, 0, false, { volumePercent: 10, canSetVolume: true, deviceName: "Speaker", deviceId: "second" });
  finish();
  await flush();
  expect(volume.disabled).toBe(false);
  expect(volume.value).toBe("10");
  expect(el("volume-value").textContent).toBe("10%");
});

it("opens settings instead of connecting on first run", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, clientId: "" } };
  });
  await import("./main");
  await flush();
  await flush();
  expect(children.get("settings")?.options).toMatchObject({ url: "settings.html", parent: "main", visible: false });
  expect(bridge.invoke).not.toHaveBeenCalledWith("connect", undefined);
});

it("registers all event listeners before connecting an existing identity", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return initial();
    if (command === "connect") expect([...bridge.listeners.keys()].sort()).toEqual([
      "lyrics", "palette:closed", "palette:run", "playback", "search:translations", "settings:preview", "status",
      "toggle-click-through",
    ]);
  });
  await import("./main");
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("connect", undefined);
});

it("opens settings as a window of its own, previews its dials and re-reads what is stored when it closes", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  await flush();
  const settings = children.get("settings")!;
  expect(settings.options).toMatchObject({ url: "settings.html", parent: "main", decorations: false });
  // Centred over the 940x760 main window at (100, 50).
  expect(settings.options).toMatchObject({ x: 250, y: 50, width: 640, height: 780 });

  // A second press brings the open window forward instead of making another.
  el("settings-open").click();
  await flush();
  expect(settings.setFocus).toHaveBeenCalled();

  bridge.listeners.get("settings:preview")!({ payload: { opacity: 60, compactOpacity: 85, lyricSize: 40, compactLyricSize: 18 } });
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("40px");
  expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.6");

  // Closed (saved elsewhere): what is stored now comes back, preview or not.
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, theme: { ...initial().settings.theme, accent: "#abcdef" } } };
  });
  settings.events.get("tauri://destroyed")!({ payload: null });
  await flush();
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#abcdef");
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("26px");
});

it("connects straight away on first run when the player needs no Client ID", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") {
      return { ...initial(), settings: { ...initial().settings, player: "ytmusic", clientId: "" } };
    }
  });
  await import("./main");
  await flush();
  // An empty Client ID is only a blocker for Spotify.
  expect(children.has("settings")).toBe(false);
  expect(bridge.invoke).toHaveBeenCalledWith("connect", undefined);
});

it("shows the matched title beside the player title and keeps it through playback polls", async () => {
  await import("./main");
  await flush();
  playback();
  lyrics(1, "Lyrics", "丽都假日");
  expect(el("track-name").textContent).toBe("song-a (丽都假日)");
  playback();
  expect(el("track-name").textContent).toBe("song-a (丽都假日)");
  lyrics(1, "Lyrics", "song-a");
  expect(el("track-name").textContent).toBe("song-a");
  lyrics(1, "Lyrics");
  expect(el("track-name").textContent).toBe("song-a");
});

it("clears matched titles on empty results, refreshes and track changes, ignoring stale answers", async () => {
  await import("./main");
  await flush();
  playback();
  lyrics(1, "Lyrics", "Alternate A");
  lyrics(1, "", "Unmatched");
  expect(el("track-name").textContent).toBe("song-a");
  lyrics(1, "Lyrics", "Alternate A");
  playback("song-a", 2);
  expect(el("track-name").textContent).toBe("song-a");
  lyrics(2, "Lyrics", "Alternate A");
  playback("song-b", 3);
  expect(el("track-name").textContent).toBe("song-b");
  lyrics(2, "Old lyrics", "Alternate A");
  expect(el("track-name").textContent).toBe("song-b");
});

/** The song a panel window was opened for, as the main window put it in the URL. */
const song = (label: string) =>
  Object.fromEntries(new URLSearchParams(String(children.get(label)!.options.url).split("?")[1]));

it("opens the lyrics source picker as a window for the current song, apart from refresh", async () => {
  await import("./main");
  await flush();
  playback();
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "Musixmatch", synced: false, cues: [], text: "Words",
    matchedTitle: "", partial: false, requested: "musixmatch",
  } });
  el("source-badge").click();
  await flush();
  await flush();
  const source = children.get("source")!;
  expect(source.options).toMatchObject({ parent: "main", visible: false, decorations: false, width: 480, height: 380 });
  expect(song("source")).toEqual({ track: "spotify:song-a", title: "song-a", source: "musixmatch" });
  // A second press brings the open window forward instead of making another.
  el("source-badge").click();
  await flush();
  expect(source.setFocus).toHaveBeenCalled();

  el("reload").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("reload_lyrics", undefined);
  expect(bridge.invoke.mock.calls.some(([command]) => command === "set_track_source")).toBe(false);
  playback("song-b", 2);
  lyrics(2, "Current song lyrics");
  lyrics(1, "Old song lyrics");
  expect(el("lyrics-list").textContent).toBe("Current song lyrics");
});

it("opens Find lyrics as a window for the current song and follows its translation switch", async () => {
  await import("./main");
  await flush();
  el("lyrics-search-open").click();
  await flush();
  // No song yet, so nothing to find lyrics for.
  expect(children.has("search")).toBe(false);

  playback();
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "LRCLIB", synced: false, cues: [], text: "Saved",
    matchedTitle: "", partial: false, requested: "", manual: true,
  } });
  el("lyrics-search-open").click();
  await flush();
  await flush();
  expect(children.get("search")!.options).toMatchObject({ parent: "main", visible: false, decorations: false, width: 600, height: 680 });
  expect(song("search")).toEqual({
    track: "spotify:song-a", title: "song-a · Artist", query: "song-a Artist", manual: "1", translations: "1",
  });

  bridge.listeners.get("search:translations")!({ payload: false });
  expect(document.body.classList.contains("hide-translations")).toBe(true);
  // The palette's switch shows, and flips, the same setting.
  const snapshot = await openPalette();
  const translations = snapshot.commands.find((command) => command.label === "Show translations")!;
  expect(translations.state).toEqual({ text: "OFF", on: false });
  bridge.listeners.get("palette:run")!({ payload: { command: translations.id } });
  expect(document.body.classList.contains("hide-translations")).toBe(false);
});

it("uses the durable fallback key for a track without a Spotify ID", async () => {
  await import("./main");
  await flush();
  playback("");
  el("source-badge").click();
  el("lyrics-search-open").click();
  await flush();
  await flush();
  expect(song("source").track).toBe("spotify:|100000");
  expect(song("search").track).toBe("spotify:|100000");
});

it("pins the window on top and stores the choice", async () => {
  await import("./main");
  await flush();
  // The stored value is applied at startup, not only when the button is used.
  expect(appWindow.setAlwaysOnTop).toHaveBeenCalledWith(false);

  el("pin").click();
  await flush();
  expect(appWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(true);
  expect(el("pin").getAttribute("aria-pressed")).toBe("true");
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", {
    incoming: { ...initial().settings, alwaysOnTop: true },
  });
});

it("keeps the window pinned as it was when the save fails", async () => {
  await import("./main");
  await flush();
  bridge.invoke.mockRejectedValueOnce("Settings folder is read-only");

  el("pin").click();
  await flush();
  expect(appWindow.setAlwaysOnTop).toHaveBeenLastCalledWith(false);
  expect(el("pin").getAttribute("aria-pressed")).toBe("false");
  expect(el("notice").textContent).toContain("read-only");
});

it("drives the window buttons and tracks the maximized glyph", async () => {
  await import("./main");
  await flush();

  el("win-minimize").click();
  el("win-maximize").click();
  el("win-close").click();
  expect(appWindow.minimize).toHaveBeenCalled();
  expect(appWindow.toggleMaximize).toHaveBeenCalled();
  expect(appWindow.close).toHaveBeenCalled();

  // Every re-import of the module leaves its own resize listener on jsdom's
  // shared window, so the answer has to be stable rather than one-shot.
  appWindow.isMaximized.mockResolvedValue(true);
  window.dispatchEvent(new Event("resize"));
  await flush();
  expect(document.body.classList.contains("is-maximized")).toBe(true);
});

const focusChanged = (focused: boolean) => {
  for (const handler of bridge.focus) handler({ payload: focused });
};

it("passes clicks through only while the window is pinned", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") {
      return { ...initial(), settings: { ...initial().settings, clickThrough: "always" } };
    }
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();
  // Unpinned, "always" must still leave the window usable.
  expect(appWindow.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);

  el("pin").click();
  await flush();
  expect(appWindow.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
});

it("follows focus while click-through is on auto", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") {
      return { ...initial(), settings: { ...initial().settings, alwaysOnTop: true, clickThrough: "auto" } };
    }
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();

  focusChanged(false);
  expect(appWindow.setIgnoreCursorEvents).toHaveBeenLastCalledWith(true);
  focusChanged(true);
  expect(appWindow.setIgnoreCursorEvents).toHaveBeenLastCalledWith(false);
});

it("flips between off and always when the global chord fires", async () => {
  await import("./main");
  await flush();

  bridge.listeners.get("toggle-click-through")!({ payload: null });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", {
    incoming: { ...initial().settings, clickThrough: "always" },
  });

  bridge.listeners.get("toggle-click-through")!({ payload: null });
  await flush();
  expect(bridge.invoke).toHaveBeenLastCalledWith("save_settings", {
    incoming: { ...initial().settings, clickThrough: "off" },
  });
});

it("thins only the background, never the lyrics", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, opacity: 45 } };
  });
  await import("./main");
  await flush();
  expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.45");
});

it("keeps play and pause in the bar, named for what a press does", async () => {
  await import("./main");
  await flush();
  const button = el<HTMLButtonElement>("bar-play");
  expect(button.disabled).toBe(true);

  playback("song-a", 1, 0, false);
  expect(button.disabled).toBe(false);
  expect(button.getAttribute("aria-label")).toBe("Play");
  button.click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("play", undefined);

  playback("song-a", 1, 0, true);
  expect(button.getAttribute("aria-label")).toBe("Pause");
  button.click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("pause", undefined);
});

/** Compact's chrome and bar rows with their hairlines; mirrors COMPACT_CHROME. */
const CHROME = 72;

const lastSize = (fn: { mock: { calls: unknown[][] } }) => {
  const calls = fn.mock.calls;
  const call = calls[calls.length - 1][0] as { width: number; height: number };
  return { width: call.width, height: call.height };
};

it("lets a warning be dismissed by clicking it", async () => {
  await import("./main");
  await flush();
  bridge.listeners.get("status")!({ payload: { state: "error", message: "x", notice: "Sign-in was not cached" } });
  expect(el("notice").hidden).toBe(false);

  el("notice").click();
  expect(el("notice").hidden).toBe(true);
});

it("retires a warning on its own after a while", async () => {
  vi.useFakeTimers();
  try {
    await import("./main");
    bridge.listeners.get("status")!({ payload: { state: "error", message: "x", notice: "Sign-in was not cached" } });
    expect(el("notice").hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(8100);
    expect(el("notice").hidden).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("switches to compact mode with its own opacity and type size", async () => {
  await import("./main");
  await flush();
  expect(document.body.classList.contains("is-compact")).toBe(false);
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("26px");

  el("mode-toggle").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", {
    incoming: { ...initial().settings, compact: true },
  });
  expect(document.body.classList.contains("is-compact")).toBe(true);
  // The compact pair, not the full one.
  expect(document.documentElement.style.getPropertyValue("--ui-opacity")).toBe("0.85");
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("18px");
});

it("never lets compact be dragged below three lines of lyrics", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") {
      return { ...initial(), settings: { ...initial().settings, compact: true, compactLyricSize: 30 } };
    }
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();

  // Three lines of (30px * 1.32 line-height + 18px padding), plus the chrome
  // and bar rows.
  const lines = Math.ceil(3 * (30 * 1.32 + 18));
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 340, height: lines + CHROME });
  // Nothing remembers the window size between launches, so a stored compact
  // mode has to shrink the window itself or it reopens at full size.
  expect(lastSize(appWindow.setSize)).toEqual({ width: 460, height: lines + CHROME });
  playback("song-a", 1, 1500);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "NetEase", synced: true,
    text: "Original", partial: false, requested: "",
    cues: [{ time_ms: 1000, text: "Original", translation: "譯文" }],
  } });
  await flush();
  // Reserve the translated line-height AND its 4px top margin for each row.
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 340, height: Math.ceil(3 * (30 * (1.32 + 0.65 * 1.4) + 18 + 4)) + CHROME });
  bridge.listeners.get("search:translations")!({ payload: false });
  await flush();
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 340, height: lines + CHROME });
});

it("gives the roomy size back when compact is switched off", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return initial();
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();

  el("mode-toggle").click();
  await flush();
  const shrunk = lastSize(appWindow.setSize);
  expect(shrunk.height).toBeLessThan(760);

  el("mode-toggle").click();
  await flush();
  expect(lastSize(appWindow.setSize)).toEqual({ width: 940, height: 760 });
});

// ---------------------------------------------------------------- cube deck

const press = (target: Element, type: string, x = 0, y = 0) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

it("toggles playback from a tap on the cover, but not from a drag that turns the cube", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, false);
  const cover = document.querySelector(".cover-shade")!;

  press(cover, "pointerdown", 100, 100);
  press(cover, "pointerup", 102, 101);
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("play", undefined);

  bridge.invoke.mockClear();
  press(cover, "pointerdown", 100, 100);
  press(cover, "pointermove", 160, 110);
  press(cover, "pointerup", 160, 110);
  await flush();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "play" || command === "pause")).toBe(false);
});

it("colours the cover while playing and leaves a tap without a track doing nothing", async () => {
  await import("./main");
  await flush();
  const cover = document.querySelector(".cover-shade")!;
  press(cover, "pointerdown", 100, 100);
  press(cover, "pointerup", 100, 100);
  await flush();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "play")).toBe(false);

  playback("song-a", 1, 0, true);
  // The first state is shown as it is; later changes flood in over a frame or two.
  expect(el("cover-face").classList.contains("is-color")).toBe(true);
});

it("turns the volume dial into input and one change, like dragging the slider", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, false, { volumePercent: 40, canSetVolume: true });
  const dial = el("volume-control");
  // jsdom lays nothing out, so the dial's centre is the origin: a quarter turn
  // clockwise from the right-hand side is a quarter of the 133-point sweep.
  press(dial, "pointerdown", 10, 0);
  press(dial, "pointermove", 0, 10);
  expect(el("volume-value").textContent).toBe("73%");
  expect(bridge.invoke.mock.calls.some(([command]) => command === "set_volume")).toBe(false);
  press(dial, "pointerup", 0, 10);
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_volume", { volumePercent: 73 });
});

it("mirrors the skip buttons into the bar for compact mode", async () => {
  await import("./main");
  await flush();
  expect(el<HTMLButtonElement>("bar-next").disabled).toBe(true);
  playback("song-a", 1, 0, true);
  expect(el<HTMLButtonElement>("bar-next").disabled).toBe(false);
  el("bar-next").click();
  el("bar-prev").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("next_track", undefined);
  expect(bridge.invoke).toHaveBeenCalledWith("previous_track", undefined);
});

it("lets the tool faces stand in for the controls they name", async () => {
  await import("./main");
  await flush();
  const tool = (proxy: string) => document.querySelector<HTMLButtonElement>(`.tool[data-proxy="${proxy}"]`)!;
  tool("pin").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: { ...initial().settings, alwaysOnTop: true } });
  runFrame();
  expect(tool("pin").getAttribute("aria-pressed")).toBe("true");
  expect(tool("reload").disabled).toBe(true);
});

// ------------------------------------------------------------ command palette

const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

/** Ctrl+K, the palette window loading, and the snapshot main.ts sends it. */
async function openPalette() {
  key(window, { key: "k", ctrlKey: true });
  await flush();
  bridge.listeners.get("palette:ready")?.({ payload: null });
  await flush();
  await flush();
  const call = [...bridge.emitTo.mock.calls].reverse().find(([, event]) => event === "palette:show");
  return call?.[2] as { commands: { id: number; label: string; enabled: boolean; state: unknown }[]; lines: unknown[]; trackKey: string; accent: string };
}
const runInPalette = (payload: unknown) => bridge.listeners.get("palette:run")!({ payload });

it("opens the palette as a window of its own with Ctrl+K and sends it what the window looks like now", async () => {
  await import("./main");
  await flush();
  const snapshot = await openPalette();
  expect(children.get("palette")?.options).toMatchObject({ url: "palette.html", parent: "main", transparent: true, visible: false });
  expect(children.get("palette")!.setPosition).toHaveBeenCalled();
  expect(snapshot.accent).toBe("#123456");
  // No track yet: listed, but not runnable.
  expect(snapshot.commands.find((command) => command.label === "Next track")?.enabled).toBe(false);
  expect(snapshot.commands.find((command) => command.label === "Compact mode")?.state).toEqual({ text: "OFF", on: false });
  // Retry only appears when the connection needs it.
  expect(snapshot.commands.some((command) => command.label === "Retry connection")).toBe(false);

  // The window is made once and reused.
  await openPalette();
  el("cmdk-open").click();
  await flush();
  expect(bridge.emitTo.mock.calls.filter(([, event]) => event === "palette:show")).toHaveLength(3);
});

it("runs what the palette picked, checking again that it still can", async () => {
  await import("./main");
  await flush();
  const snapshot = await openPalette();
  const id = (label: string) => snapshot.commands.find((command) => command.label === label)!.id;

  runInPalette({ command: id("Next track") });
  await flush();
  // Still no track: nothing is sent, whatever the palette believed.
  expect(bridge.invoke.mock.calls.some(([command]) => command === "next_track")).toBe(false);

  playback("song-a", 1, 0, true);
  runInPalette({ command: id("Next track") });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("next_track", undefined);
  expect(appWindow.setFocus).toHaveBeenCalled();

  runInPalette({ command: id("Compact mode") });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: { ...initial().settings, compact: true } });
});

it("sends the timed lines and seeks to the one picked, but never into a song that has changed", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, true);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "LRCLIB", synced: true, text: "", partial: false, requested: "",
    matchedTitle: "", cues: [{ time_ms: 1000, text: "Hello <b>world</b>" }, { time_ms: 2000, text: "  " }, { time_ms: 42000, text: "止まらない鼓動" }],
  } });
  const snapshot = await openPalette();
  expect(snapshot.trackKey).toBe("spotify:song-a");
  // Blank lines have no words to find.
  expect(snapshot.lines).toEqual([
    { index: 0, text: "Hello <b>world</b>", translation: "", time: "00:01" },
    { index: 2, text: "止まらない鼓動", translation: "", time: "00:42" },
  ]);

  runInPalette({ line: 2, trackKey: "spotify:song-a" });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("seek", { positionMs: 42000 });

  bridge.invoke.mockClear();
  runInPalette({ line: 2, trackKey: "spotify:song-b" });
  await flush();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "seek")).toBe(false);
});

it("matches lyrics and commands to the backend's track key, whatever its source prefix", async () => {
  await import("./main");
  await flush();
  // YouTube Music reports no track id; the backend keys the song by name and length.
  bridge.listeners.get("playback")!({ payload: {
    trackId: "", trackKey: "ytm:Video|1105000", generation: 4, name: "Video", artists: ["Channel"], album: "", albumArt: null,
    durationMs: 1105000, progressMs: 0, isPlaying: true, hasTrack: true,
    canSkipNext: true, canSkipPrevious: true, canSeek: true, deviceName: null,
  } });
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 4, trackId: "ytm:Video|1105000", source: "LRCLIB", synced: false, cues: [],
    text: "Sung words", matchedTitle: "", partial: false, requested: "",
  } });
  expect(el("lyrics-list").textContent).toBe("Sung words");

  el("source-badge").click();
  await flush();
  await flush();
  expect(song("source").track).toBe("ytm:Video|1105000");
});
