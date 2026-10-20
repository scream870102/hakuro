// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import { stretchedHeight } from "./deck";
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
  maximize: vi.fn(),
  unmaximize: vi.fn(),
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
  setResizable: vi.fn(),
  setShadow: vi.fn(),
  startDragging: vi.fn(),
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
    compactLyrics: false,
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

it("connects to ytmdesktop2 without setup and lets its volume be set", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, player: "ytmdesktop2", clientId: "", ytmdPort: 13091 } };
  });
  await import("./main");
  await flush();
  await flush();
  // Unlike Spotify, an empty Client ID is no reason to stop and open Settings.
  expect(bridge.invoke.mock.calls.some(([command]) => command === "connect")).toBe(true);
  expect(children.has("settings")).toBe(false);
  playback("song-a", 1, 0, false, { volumePercent: 37, canSetVolume: true, deviceName: "ytmdesktop2" });
  const volume = el<HTMLInputElement>("volume");
  expect(volume.disabled).toBe(false);
  expect(el("volume-value").textContent).toBe("37%");
  expect(el("volume-control").title).toBe("ytmdesktop2 player volume");
  volume.value = "60";
  volume.dispatchEvent(new Event("change"));
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_volume", { volumePercent: 60 });
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
      "shortcut",
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

it("centres the sung line again once compact's cube has settled at its new size", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, compact: true } };
  });
  await import("./main");
  await flush();
  playback("song-a", 1, 1500);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "LRCLIB", synced: true,
    text: "", partial: false, requested: "",
    cues: [{ time_ms: 1000, text: "One" }, { time_ms: 5000, text: "Two" }],
  } });
  await flush();
  runFrame();
  const scrollTo = vi.mocked(HTMLElement.prototype.scrollTo);
  const settle = (target: HTMLElement, propertyName: string) => {
    const event = new Event("transitionend", { bubbles: true });
    Object.defineProperty(event, "propertyName", { value: propertyName });
    target.dispatchEvent(event);
  };

  // A button's own transition ending is not the cube settling.
  scrollTo.mockClear();
  settle(el("pin"), "--s");
  settle(document.body, "opacity");
  expect(scrollTo.mock.contexts).not.toContain(el("lyrics"));
  settle(document.body, "--s");
  expect(scrollTo.mock.contexts).toContain(el("lyrics"));
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

  bridge.listeners.get("shortcut")!({ payload: "clickThrough" });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", {
    incoming: { ...initial().settings, clickThrough: "always" },
  });

  bridge.listeners.get("shortcut")!({ payload: "clickThrough" });
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

/** Compact's cube edge for a lyric size: three lines plus slack, never under 150px. */
const edgeFor = (line: number) => Math.max(150, Math.ceil(3 * line + 16));
/** As tall as the cube stretched for the lyrics stands end-on, plus the pin's glow. */
const heightFor = (edge: number) => Math.ceil(stretchedHeight(edge, edge + Math.round(edge * 1.9))) + 24;

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

it("sizes compact's window around a cube whose face fits three lines of lyrics", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") {
      return { ...initial(), settings: { ...initial().settings, compact: true, compactLyricSize: 30 } };
    }
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();

  // Three lines of (30px * 1.32 line-height + 18px padding) set the edge; the
  // window is twice that wide, and tall enough for the stretched cube end-on.
  const edge = edgeFor(30 * 1.32 + 18);
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 2 * edge, height: heightFor(edge) });
  // Nothing remembers the window size between launches, so a stored compact
  // mode has to size the window itself, and it stays the size the cube sets.
  expect(lastSize(appWindow.setSize)).toEqual({ width: 2 * edge, height: heightFor(edge) });
  expect(appWindow.setResizable).toHaveBeenLastCalledWith(false);
  expect(document.documentElement.style.getPropertyValue("--compact-s")).toBe(`${edge}px`);
  expect(document.documentElement.style.getPropertyValue("--lw")).toBe(`${Math.round(edge * 1.9)}px`);

  playback("song-a", 1, 1500);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "NetEase", synced: true,
    text: "Original", partial: false, requested: "",
    cues: [{ time_ms: 1000, text: "Original", translation: "譯文" }],
  } });
  await flush();
  // Reserve the translated line-height AND its 4px top margin for each row.
  const translated = edgeFor(30 * (1.32 + 0.65 * 1.4) + 18 + 4);
  expect(lastSize(appWindow.setSize)).toEqual({ width: 2 * translated, height: heightFor(translated) });
  bridge.listeners.get("search:translations")!({ payload: false });
  await flush();
  expect(lastSize(appWindow.setSize)).toEqual({ width: 2 * edge, height: heightFor(edge) });
});

it("leaves the stretched cube room to stand end-on, where its near end looms", () => {
  // Computed apart from the app: rotateX(-24deg) rotateY(-14deg + quarter turns
  // +/- 1.6deg sway), a 1500px or 7-edge perspective, and 5px of bob each way.
  expect(stretchedHeight(150, 435)).toBeCloseTo(377.82, 1);
  expect(stretchedHeight(300, 870)).toBeCloseTo(791.08, 1);
  // The old window, twice the edge, was too short for it.
  expect(stretchedHeight(150, 435)).toBeGreaterThan(2 * 150);
});

it("stretches the compact cube for the lyrics, remembers it, and moves the lyrics onto its face", async () => {
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, compact: true } };
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  await import("./main");
  await flush();
  const edge = edgeFor(18 * 1.32 + 18);
  expect(document.body.classList.contains("is-stretched")).toBe(false);
  expect(el("lyrics").parentElement).toBe(el("cube-lyrics"));
  // The dial follows the cube's faces round: the spine has the right one.
  expect(el("volume-control").closest(".face--left")).not.toBeNull();

  document.querySelector<HTMLButtonElement>('.lid .tool[data-proxy="compact-lyrics"]')!.click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", {
    incoming: { ...initial().settings, compact: true, compactLyrics: true },
  });
  expect(document.body.classList.contains("is-stretched")).toBe(true);
  // The lyrics only widen the window; it was already tall enough for them.
  expect(lastSize(appWindow.setSize)).toEqual({ width: 2 * edge + Math.round(edge * 1.9), height: heightFor(edge) });
  runFrame();
  expect(document.querySelector('.lid .tool[data-proxy="compact-lyrics"]')!.getAttribute("aria-pressed")).toBe("true");
  // Compact's own switch is pressed, but the way back to full mode is not a state.
  expect(el("mode-toggle").getAttribute("aria-pressed")).toBe("true");
  expect(document.querySelector(".lid .tool--full")!.hasAttribute("aria-pressed")).toBe(false);

  // Back to the full window: the lyrics and the dial go home, the window can be resized again.
  el("mode-toggle").click();
  await flush();
  expect(document.body.classList.contains("is-stretched")).toBe(false);
  expect(el("lyrics").parentElement).toBe(document.querySelector(".lyrics-zone"));
  expect(el("lyrics").nextElementSibling).toBe(el("shards"));
  expect(el("volume-control").closest(".face--right")).not.toBeNull();
  expect(appWindow.setResizable).toHaveBeenLastCalledWith(true);
});

it("lets go of a maximized window before shrinking it to the cube, and fills the screen again after", async () => {
  await import("./main");
  await flush();
  appWindow.isMaximized.mockResolvedValue(true);
  el("mode-toggle").click();
  await flush();
  expect(appWindow.unmaximize).toHaveBeenCalledTimes(1);
  const sized = appWindow.setSize.mock.invocationCallOrder;
  expect(appWindow.unmaximize.mock.invocationCallOrder[0]).toBeLessThan(sized[sized.length - 1]);
  expect(appWindow.maximize).not.toHaveBeenCalled();

  appWindow.isMaximized.mockResolvedValue(false);
  el("mode-toggle").click();
  await flush();
  expect(appWindow.maximize).toHaveBeenCalledTimes(1);
});

it("drags the window from compact's empty glass, but turns the cube everywhere else", async () => {
  await import("./main");
  await flush();
  const scene = el("scene");
  scene.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  expect(appWindow.startDragging).not.toHaveBeenCalled();
  scene.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));

  el("mode-toggle").click();
  await flush();
  scene.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
  // On the cube itself a press still turns it rather than moving the window.
  document.querySelector(".cover-shade")!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  expect(appWindow.startDragging).toHaveBeenCalledTimes(1);
});

it("keeps compact metadata current across track changes and clears it when playback stops", async () => {
  await import("./main");
  await flush();
  el("mode-toggle").click();
  await flush();
  playback("A very long song name with 日本語 and 中文", 1);
  expect(el("track-name").textContent).toBe("A very long song name with 日本語 and 中文");
  expect(el("track-artist").textContent).toBe("Artist");
  // The cube carries the same name down its spine and on its lid.
  for (const id of ["spine-title", "lid-title"]) expect(el(id).textContent).toBe("A very long song name with 日本語 and 中文");
  for (const id of ["spine-artist", "lid-artist"]) expect(el(id).textContent).toBe("Artist");
  bridge.listeners.get("playback")!({ payload: {
    trackId: "next", trackKey: "spotify:next", generation: 2, name: "New song", artists: ["New artist", "Guest"], album: "", albumArt: null,
    durationMs: 100000, progressMs: 0, isPlaying: true, hasTrack: true,
    canSkipNext: true, canSkipPrevious: true, canSeek: true, deviceName: null,
  } });
  expect(el("track-name").textContent).toBe("New song");
  expect(el("track-artist").textContent).toBe("New artist, Guest");
  bridge.listeners.get("playback")!({ payload: {
    trackId: "", trackKey: "", generation: 3, name: "", artists: [], album: "", albumArt: null,
    durationMs: 0, progressMs: 0, isPlaying: false, hasTrack: false,
    canSkipNext: false, canSkipPrevious: false, canSeek: false, deviceName: null,
  } });
  expect(el("track-name").textContent).toBe("No track playing");
  expect(el("track-artist").textContent).toBe("");
  expect(el("spine-artist").textContent).toBe("");
  el("mode-toggle").click();
  await flush();
  playback("Full song", 4);
  expect(el("track-name").textContent).toBe("Full song");
  expect(el("track-artist").textContent).toBe("Artist");
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
  // No shadow on clear glass: its border would frame an empty window.
  expect(appWindow.setShadow).toHaveBeenLastCalledWith(false);

  el("mode-toggle").click();
  await flush();
  expect(lastSize(appWindow.setSize)).toEqual({ width: 940, height: 760 });
  expect(appWindow.setShadow).toHaveBeenLastCalledWith(true);
});

// ---------------------------------------------------------------- cube deck

const press = (target: Element, type: string, x = 0, y = 0) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));

it("previews turntable time and lyrics through playback polls, then seeks once on release", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 10000);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "spotify:song-a", source: "LRCLIB", synced: true, text: "", partial: false, requested: "",
    cues: [{ time_ms: 10000, text: "Before" }, { time_ms: 12000, text: "Preview" }],
  } });
  runFrame();
  expect(el("lyrics-list").children[0].classList.contains("is-active")).toBe(true);
  const vinyl = el("vinyl");
  // jsdom puts the centre at the origin; each clockwise quarter turn adds 2.5 seconds.
  press(vinyl, "pointerdown", 10, 0);
  playback("song-a", 1, 11000);
  press(vinyl, "pointermove", 0, 10);
  runFrame();
  expect(el("time-current").textContent).toBe("00:12");
  expect(el("lid-time").textContent).toBe("00:12");
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("12500");
  expect(el("scrubber-fill").style.width).toBe("12.5%");
  expect(el("lyrics-list").children[1].classList.contains("is-active")).toBe(true);
  playback("song-a", 1, 11500);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("12500");
  press(vinyl, "pointermove", -10, 0);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("15000");
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "seek")).toEqual([]);
  press(vinyl, "pointerup", -10, 0);
  press(vinyl, "lostpointercapture", -10, 0);
  await flush();
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "seek")).toEqual([["seek", { positionMs: 15000 }]]);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("15000");
});

it.each(["pointercancel", "lostpointercapture"])("cancels turntable preview on %s without seeking", async (event) => {
  await import("./main");
  await flush();
  playback("song-a", 1, 10000);
  const vinyl = el("vinyl");
  press(vinyl, "pointerdown", 10, 0);
  press(vinyl, "pointermove", 0, 10);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("12500");
  playback("song-a", 1, 11000);
  press(vinyl, event, 0, 10);
  press(vinyl, "pointerup", 0, 10);
  runFrame();
  expect(el("time-current").textContent).toBe("00:11");
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("11000");
  expect(vinyl.classList.contains("is-held")).toBe(false);
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "seek")).toEqual([]);
});

it("invalidates turntable preview when the track changes", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 10000);
  const vinyl = el("vinyl");
  press(vinyl, "pointerdown", 10, 0);
  press(vinyl, "pointermove", 0, 10);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("12500");
  playback("song-b", 2, 30000);
  press(vinyl, "pointermove", -10, 0);
  runFrame();
  expect(el("scrubber").getAttribute("aria-valuenow")).toBe("30000");
  press(vinyl, "pointerup", -10, 0);
  await flush();
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "seek")).toEqual([]);
});

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

it("puts the transport on compact's lid, with how far through the song is beside it", async () => {
  await import("./main");
  await flush();
  const lid = (proxy: string) => document.querySelector<HTMLButtonElement>(`.lid .tool[data-proxy="${proxy}"]`)!;
  runFrame();
  expect(lid("next").disabled).toBe(true);
  playback("song-a", 1, 50000, false);
  runFrame();
  expect(lid("next").disabled).toBe(false);
  expect(el("lid-fill").style.width).toBe("50%");
  expect(el("lid-time").textContent).toBe("00:50");
  expect(el("lid-total").textContent).toBe("01:40");
  lid("next").click();
  lid("previous").click();
  lid("play-pause").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("next_track", undefined);
  expect(bridge.invoke).toHaveBeenCalledWith("previous_track", undefined);
  expect(bridge.invoke).toHaveBeenCalledWith("play", undefined);

  lid("pin").click();
  await flush();
  expect(document.body.classList.contains("is-pinned")).toBe(true);
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
  return call?.[2] as { commands: { id: number; label: string; enabled: boolean; state: unknown; shortcut?: { action: string; accelerator: string; global: boolean } }[]; lines: unknown[]; trackKey: string; accent: string };
}
const runInPalette = (payload: unknown) => bridge.listeners.get("palette:run")!({ payload });

it("dispatches custom local and global bindings once with availability and typing guards", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, shortcuts: [
      { action: "next", accelerator: "Ctrl+KeyN", global: false },
      { action: "previous", accelerator: "Ctrl+KeyB", global: true },
    ] } };
  });
  await import("./main");
  await flush();
  key(window, { key: "n", code: "KeyN", ctrlKey: true });
  expect(bridge.invoke.mock.calls.some(([command]) => command === "next_track")).toBe(false);
  playback();
  bridge.invoke.mockClear();
  key(window, { key: "n", code: "KeyN", ctrlKey: true });
  key(window, { key: "n", code: "KeyN", ctrlKey: true, repeat: true });
  key(window, { key: "n", code: "KeyN", ctrlKey: true, isComposing: true });
  const input = document.createElement("input");
  document.body.append(input);
  key(input, { key: "n", code: "KeyN", ctrlKey: true });
  key(window, { key: "b", code: "KeyB", ctrlKey: true });
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "next_track")).toHaveLength(1);
  expect(bridge.invoke.mock.calls.some(([command]) => command === "previous_track")).toBe(false);
  bridge.listeners.get("shortcut")!({ payload: "previous" });
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "previous_track")).toHaveLength(1);
  key(window, { key: "k", ctrlKey: true });
  await flush();
  expect(children.has("palette")).toBe(false);
  expect(el("cmdk-open").querySelector("kbd")?.hidden).toBe(true);
});

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
  expect(snapshot.commands.find((command) => command.label === "Click-through")?.shortcut).toEqual({ action: "clickThrough", accelerator: "Ctrl+Alt+KeyP", global: true });
  // Retry only appears when the connection needs it.
  expect(snapshot.commands.some((command) => command.label === "Retry connection")).toBe(false);

  // The window is made once and reused.
  await openPalette();
  el("cmdk-open").click();
  await flush();
  expect(bridge.emitTo.mock.calls.filter(([, event]) => event === "palette:show")).toHaveLength(3);
});

it("refreshes palette binding hints from the saved settings after editing and clearing", async () => {
  let accelerator = "Ctrl+KeyN";
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, shortcuts: [
      { action: "commands", accelerator: "Ctrl+KeyK", global: false },
      { action: "next", accelerator, global: false },
    ] } };
  });
  await import("./main");
  await flush();
  const next = async () => (await openPalette()).commands.find((command) => command.label === "Next track")!;
  expect((await next()).shortcut?.accelerator).toBe("Ctrl+KeyN");
  for (const key of ["F8", ""]) {
    el("settings-open").click();
    await flush();
    accelerator = key;
    children.get("settings")!.events.get("tauri://destroyed")!({ payload: null });
    await flush();
    expect((await next()).shortcut?.accelerator ?? "").toBe(key);
  }
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
