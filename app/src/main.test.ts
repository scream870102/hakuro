// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
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
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => appWindow }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));

const initial = () => ({
  settings: {
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
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
function playback(trackId = "song-a", generation = 1) {
  bridge.listeners.get("playback")!({ payload: {
    trackId, generation, name: trackId, artists: ["Artist"], album: "Album", albumArt: null,
    durationMs: 100000, progressMs: 0, isPlaying: false, hasTrack: true,
    canSkipNext: true, canSkipPrevious: true, canSeek: true, deviceName: null,
  } });
}
function lyrics(generation: number, text: string) {
  bridge.listeners.get("lyrics")!({ payload: {
    generation, trackId: generation === 1 ? "song-a" : "song-b", source: "LRCLIB",
    synced: false, cues: [], text, partial: false, requested: "",
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
  appWindow.onFocusChanged.mockImplementation(async (cb: (e: { payload: boolean }) => void) => {
    bridge.focus.push(cb);
    return () => {};
  });
  document.documentElement.innerHTML = html;
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return initial();
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
});

it("opens settings instead of connecting on first run", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, clientId: "" } };
    if (command === "connect") expect(bridge.listeners.size).toBe(4);
  });
  await import("./main");
  await flush();
  expect(bridge.listeners.size).toBe(4);
  expect(el<HTMLDialogElement>("settings-dialog").open).toBe(true);
  expect(bridge.invoke).not.toHaveBeenCalledWith("connect", undefined);
});

it("registers all event listeners before connecting an existing identity", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return initial();
    if (command === "connect") expect([...bridge.listeners.keys()].sort())
      .toEqual(["lyrics", "playback", "status", "toggle-click-through"]);
  });
  await import("./main");
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("connect", undefined);
});

it("saves Client ID, provider order/enabled state, colors and follow as one settings update", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  el<HTMLInputElement>("client-id").value = `  ${"b".repeat(32)}  `;
  el<HTMLInputElement>("color-accent").value = "#abcdef";
  el<HTMLInputElement>("color-active").value = "#fedcba";
  el<HTMLInputElement>("color-past").value = "#112233";
  el<HTMLInputElement>("settings-follow").checked = false;
  const enabled = el("source-order").querySelector("input")!;
  enabled.checked = false;
  enabled.dispatchEvent(new Event("change"));
  el("source-order").querySelectorAll("button")[1].click();
  el("settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: {
    clientId: "b".repeat(32),
    sources: [{ id: "musixmatch", enabled: true }, { id: "lrclib", enabled: false }],
    theme: { accent: "#abcdef", activeLine: "#fedcba", pastLine: "#112233" },
    followLyrics: false,
    alwaysOnTop: false,
    opacity: 100,
    clickThrough: "off",
    compact: false,
    compactOpacity: 85,
    lyricSize: 26,
    compactLyricSize: 18,
  } });
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#abcdef");
  expect(el<HTMLInputElement>("follow").checked).toBe(false);
  expect(el<HTMLDialogElement>("settings-dialog").open).toBe(false);
});

it("keeps refresh separate from source selection and closes the picker when tracks change", async () => {
  await import("./main");
  await flush();
  playback();
  el("source-badge").click();
  expect(el<HTMLDialogElement>("source-dialog").open).toBe(true);
  expect(el<HTMLSelectElement>("track-source").options.length).toBe(3);
  el<HTMLSelectElement>("track-source").value = "musixmatch";
  el("source-save").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_track_source", { source: "musixmatch", trackId: "song-a" });
  el("reload").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("reload_lyrics", undefined);
  el("source-badge").click();
  playback("song-b", 2);
  expect(el<HTMLDialogElement>("source-dialog").open).toBe(false);
  lyrics(2, "Current song lyrics");
  lyrics(1, "Old song lyrics");
  expect(el("lyrics-list").textContent).toBe("Current song lyrics");
});

it("keeps the settings dialog and entered values when saving fails", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  bridge.invoke.mockRejectedValueOnce("Settings folder is read-only");
  el<HTMLInputElement>("client-id").value = "invalid";
  el("settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  expect(el<HTMLDialogElement>("settings-dialog").open).toBe(true);
  expect(el<HTMLInputElement>("client-id").value).toBe("invalid");
  expect(el("settings-error").textContent).toContain("read-only");
  expect(el<HTMLButtonElement>("settings-save").disabled).toBe(false);
});

it("uses the durable fallback key for a track without a Spotify ID", async () => {
  await import("./main");
  await flush();
  playback("");
  el("source-badge").click();
  expect(el<HTMLDialogElement>("source-dialog").open).toBe(true);
  el("source-save").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_track_source", { source: null, trackId: "|100000" });
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

it("steps the secondary controls aside once nothing is happening", async () => {
  vi.useFakeTimers();
  try {
    await import("./main");
    await vi.advanceTimersByTimeAsync(3100);
    expect(document.body.classList.contains("is-idle")).toBe(true);

    window.dispatchEvent(new Event("pointermove"));
    expect(document.body.classList.contains("is-idle")).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

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

  // Three lines of (30px * 1.32 line-height + 18px padding), plus the header.
  const lines = Math.ceil(3 * (30 * 1.32 + 18));
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 340, height: lines + 80 });
  // Nothing remembers the window size between launches, so a stored compact
  // mode has to shrink the window itself or it reopens at full size.
  expect(lastSize(appWindow.setSize)).toEqual({ width: 460, height: lines + 80 });
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
