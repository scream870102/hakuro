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
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));

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
const candidate = { source: "lrclib", id: "123", title: "別名 <b>Song</b>", artists: ["Singer"], album: "Record", duration_ms: 123000 };
const preview = { source: "LRCLIB", matched_title: candidate.title, text: "Original", cues: [
  { time_ms: 1000, text: "Original", translation: "翻譯" },
], errors: [] };
function submitSearch(query = "別名") {
  el<HTMLInputElement>("lyrics-query").value = query;
  el("lyrics-search-form").dispatchEvent(new Event("submit", { cancelable: true }));
}
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
  } });
}
function lyrics(generation: number, text: string, matchedTitle = "") {
  bridge.listeners.get("lyrics")!({ payload: {
    generation, trackId: generation === 1 ? "song-a" : "song-b", source: "LRCLIB",
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
  appWindow.onFocusChanged.mockImplementation(async (cb: (e: { payload: boolean }) => void) => {
    bridge.focus.push(cb);
    return () => {};
  });
  document.documentElement.innerHTML = html;
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  HTMLElement.prototype.scrollTo = vi.fn();
  bridge.invoke.mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return initial();
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
});

it("searches enabled providers, safely previews metadata and saves the chosen match", async () => {
  await import("./main");
  await flush();
  playback();
  el("lyrics-search-open").click();
  expect(document.activeElement).toBe(el("lyrics-query"));
  expect(Array.from(el<HTMLSelectElement>("lyrics-search-source").options).map((option) => option.value)).toEqual(["lrclib"]);
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch("  別名  ");
  expect(el("lyrics-search-status").textContent).toBe("Searching…");
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("search_lyrics", { trackId: "song-a", query: "別名", source: "lrclib" });
  expect(el("lyrics-candidates").textContent).toContain("Singer · Record · 02:03 · lrclib");
  expect(el("lyrics-candidates").querySelector("b")).toBeNull();
  bridge.invoke.mockResolvedValueOnce(preview);
  el("lyrics-candidates").querySelector("button")!.click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("preview_lyric_candidate", { trackId: "song-a", candidate });
  expect(el("lyrics-preview").textContent).toContain("00:01  Original\n    翻譯");
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(false);
  el("lyrics-match-apply").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("apply_lyric_match", { trackId: "song-a", candidate });
  expect(el<HTMLDialogElement>("lyrics-search-dialog").open).toBe(false);
  expect(document.activeElement).toBe(el("lyrics-search-open"));
});

it("ignores superseded searches, preview responses after editing, and results after a track change", async () => {
  await import("./main");
  await flush();
  playback();
  el("lyrics-search-open").click();
  let oldSearch!: (value: unknown) => void;
  bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { oldSearch = resolve; }));
  submitSearch("first");
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch("second");
  await flush();
  oldSearch([{ ...candidate, title: "Stale" }]);
  await flush();
  expect(el("lyrics-candidates").textContent).not.toContain("Stale");
  let oldPreview!: (value: unknown) => void;
  bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { oldPreview = resolve; }));
  el("lyrics-candidates").querySelector("button")!.click();
  el("lyrics-query").dispatchEvent(new Event("input"));
  oldPreview(preview);
  await flush();
  expect(el("lyrics-preview-panel").hidden).toBe(true);
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(true);
  bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { oldSearch = resolve; }));
  submitSearch();
  playback("song-b", 2);
  oldSearch([candidate]);
  await flush();
  expect(el<HTMLDialogElement>("lyrics-search-dialog").open).toBe(false);
  expect(el("lyrics-candidates").children).toHaveLength(0);
  el("lyrics-match-apply").click();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "apply_lyric_match")).toBe(false);
});

it("shows empty/error states, rejects empty previews and restores an existing manual match", async () => {
  await import("./main");
  await flush();
  playback();
  bridge.listeners.get("lyrics")!({ payload: { generation: 1, trackId: "song-a", source: "LRCLIB", synced: false, cues: [], text: "saved", partial: false, requested: "", manual: true } });
  expect(el("source-badge").textContent).toContain("Manual");
  el("lyrics-search-open").click();
  expect(el<HTMLButtonElement>("lyrics-match-clear").disabled).toBe(false);
  bridge.invoke.mockResolvedValueOnce([]);
  submitSearch();
  await flush();
  expect(el("lyrics-search-status").textContent).toContain("No results");
  bridge.invoke.mockRejectedValueOnce("Source unavailable");
  submitSearch();
  await flush();
  expect(el("lyrics-search-status").textContent).toBe("Source unavailable");
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch();
  await flush();
  bridge.invoke.mockResolvedValueOnce({ ...preview, cues: [], text: "" });
  el("lyrics-candidates").querySelector("button")!.click();
  await flush();
  expect(el("lyrics-search-status").textContent).toContain("no lyrics");
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(true);
  el("lyrics-match-clear").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("clear_lyric_match", { trackId: "song-a" });
});

it("dismisses search with Escape and invalidates an in-flight preview", async () => {
  await import("./main");
  await flush();
  playback();
  el("lyrics-search-open").click();
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch();
  await flush();
  let finish!: (value: unknown) => void;
  bridge.invoke.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  el("lyrics-candidates").querySelector("button")!.click();
  el("lyrics-search-dialog").dispatchEvent(new Event("cancel"));
  finish(preview);
  await flush();
  expect(el<HTMLDialogElement>("lyrics-search-dialog").open).toBe(false);
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(true);
});

it("highlights words from the playback clock across pause and seeks, displays translations, and accepts old cues", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 1500);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "song-a", source: "NetEase", synced: true, text: "", partial: false, requested: "",
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
  el<HTMLInputElement>("show-translations").checked = false;
  el("show-translations").dispatchEvent(new Event("change"));
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
  el<HTMLSelectElement>("settings-player").value = "ytmusic";
  el("settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
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
    player: "spotify",
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

it("hides the Spotify setup when the player is switched to YouTube Music, and saves the choice", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  // Spotify is the stored choice, so its setup starts visible.
  expect(el("spotify-settings").hidden).toBe(false);

  const player = el<HTMLSelectElement>("settings-player");
  player.value = "ytmusic";
  player.dispatchEvent(new Event("change"));
  // YouTube Music has nothing to sign in to, so the Client ID stops being asked for.
  expect(el("spotify-settings").hidden).toBe(true);

  el("settings-form").dispatchEvent(new Event("submit", { cancelable: true }));
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  expect((saved[1] as { incoming: { player: string } }).incoming.player).toBe("ytmusic");
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
  expect(el<HTMLDialogElement>("settings-dialog").open).toBe(false);
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

/** jsdom gives every element a zero-sized box, so the panel needs a real one. */
function boxed(dialog: HTMLDialogElement) {
  dialog.getBoundingClientRect = () =>
    ({ left: 100, right: 400, top: 100, bottom: 400, x: 100, y: 100, width: 300, height: 300 }) as DOMRect;
  return dialog;
}

const at = (clientX: number, clientY: number) => ({ clientX, clientY, bubbles: true });

it("treats a click away from the settings panel as cancelling it", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  const dialog = boxed(el<HTMLDialogElement>("settings-dialog"));
  el<HTMLInputElement>("color-accent").value = "#abcdef";

  dialog.dispatchEvent(new MouseEvent("pointerdown", at(20, 20)));
  dialog.dispatchEvent(new MouseEvent("click", at(20, 20)));
  await flush();
  expect(dialog.open).toBe(false);
  // Cancelling, not saving: the edit is dropped and the stored colour comes back.
  expect(bridge.invoke).not.toHaveBeenCalledWith("save_settings", expect.anything());
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
});

it("keeps the settings panel open when a click merely starts or ends inside it", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  const dialog = boxed(el<HTMLDialogElement>("settings-dialog"));

  // Dragging a slider or selecting text often releases past the edge.
  dialog.dispatchEvent(new MouseEvent("pointerdown", at(200, 200)));
  dialog.dispatchEvent(new MouseEvent("click", at(20, 20)));
  expect(dialog.open).toBe(true);

  // The dialog is padded, so a click inside its box is never "away" even when
  // it lands on the dialog element rather than on a control.
  dialog.dispatchEvent(new MouseEvent("pointerdown", at(110, 110)));
  dialog.dispatchEvent(new MouseEvent("click", at(110, 110)));
  expect(dialog.open).toBe(true);
});

it("treats a click away from the source picker as cancelling it", async () => {
  await import("./main");
  await flush();
  playback();
  el("source-badge").click();
  const dialog = boxed(el<HTMLDialogElement>("source-dialog"));
  expect(dialog.open).toBe(true);

  dialog.dispatchEvent(new MouseEvent("pointerdown", at(20, 20)));
  dialog.dispatchEvent(new MouseEvent("click", at(20, 20)));
  await flush();
  expect(dialog.open).toBe(false);
  expect(bridge.invoke).not.toHaveBeenCalledWith("set_track_source", expect.anything());
});

it("puts back a previewed setting when Escape dismisses the panel", async () => {
  await import("./main");
  await flush();
  el("settings-open").click();
  await flush();
  const dialog = el<HTMLDialogElement>("settings-dialog");
  const size = el<HTMLInputElement>("settings-lyric-size");
  size.value = "40";
  size.dispatchEvent(new Event("input"));
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("40px");

  // Escape never reaches either button, so without this the preview would stay.
  dialog.dispatchEvent(new Event("cancel"));
  dialog.close();
  expect(document.documentElement.style.getPropertyValue("--lyric-size")).toBe("26px");
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
    generation: 1, trackId: "song-a", source: "NetEase", synced: true,
    text: "Original", partial: false, requested: "",
    cues: [{ time_ms: 1000, text: "Original", translation: "譯文" }],
  } });
  await flush();
  // Reserve the translated line-height AND its 4px top margin for each row.
  expect(lastSize(appWindow.setMinSize)).toEqual({ width: 340, height: Math.ceil(3 * (30 * (1.32 + 0.65 * 1.4) + 18 + 4)) + CHROME });
  el<HTMLInputElement>("show-translations").checked = false;
  el("show-translations").dispatchEvent(new Event("change"));
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
function typeInPalette(text: string) {
  const input = el<HTMLInputElement>("pal-input");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  return input;
}

it("opens the command palette with Ctrl+K and runs the best match on Enter", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, true);
  key(window, { key: "k", ctrlKey: true });
  expect(el<HTMLDialogElement>("palette").open).toBe(true);

  key(typeInPalette("next"), { key: "Enter" });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("next_track", undefined);
  expect(el<HTMLDialogElement>("palette").open).toBe(false);

  // Chinese names find commands too.
  key(window, { key: "k", ctrlKey: true });
  key(typeInPalette("精簡"), { key: "Enter" });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: { ...initial().settings, compact: true } });
});

it("jumps to a lyric line found by its words, and refuses commands that cannot run", async () => {
  await import("./main");
  await flush();
  key(window, { key: "k", ctrlKey: true });
  key(typeInPalette("next track"), { key: "Enter" });
  // No track: the command is listed but does nothing, and the palette stays open.
  expect(bridge.invoke.mock.calls.some(([command]) => command === "next_track")).toBe(false);
  expect(el<HTMLDialogElement>("palette").open).toBe(true);
  el<HTMLDialogElement>("palette").close();

  playback("song-a", 1, 0, true);
  bridge.listeners.get("lyrics")!({ payload: {
    generation: 1, trackId: "song-a", source: "LRCLIB", synced: true, text: "", partial: false, requested: "",
    matchedTitle: "", cues: [{ time_ms: 1000, text: "Hello <b>world</b>" }, { time_ms: 42000, text: "止まらない鼓動" }],
  } });
  key(window, { key: "k", ctrlKey: true });
  typeInPalette("鼓動");
  const row = el("pal-list").querySelector(".pal__item.is-sel")!;
  expect(row.textContent).toContain("止まらない鼓動");
  expect(row.querySelector("mark")?.textContent).toBe("鼓動");
  key(el("pal-input"), { key: "Enter" });
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("seek", { positionMs: 42000 });

  // Lyric text is shown as text, never parsed as markup.
  key(window, { key: "k", ctrlKey: true });
  typeInPalette("world");
  expect(el("pal-list").querySelector("b")).toBeNull();
  expect(el("pal-list").textContent).toContain("Hello <b>world</b>");
});

it("leaves Enter alone while an input method is still composing", async () => {
  await import("./main");
  await flush();
  playback("song-a", 1, 0, true);
  key(window, { key: "k", ctrlKey: true });
  key(typeInPalette("next"), { key: "Enter", isComposing: true });
  await flush();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "next_track")).toBe(false);
});

it("shows the app version in settings and the palette", async () => {
  await import("./main");
  await flush();
  await flush();
  expect(el("app-version").textContent).toBe("v1.3.0");
  expect(el("pal-version").textContent).toBe("HAKURO v1.3.0");
});
