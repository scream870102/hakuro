// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../queue.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitTo: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  focus: [] as ((event: { payload: boolean }) => void)[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: bridge.emitTo,
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn(), onFocusChanged: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const config = (player = "spotify") => ({
  settings: { player, theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" } },
  providers: [],
});
const item = (title: string, extra: Record<string, unknown> = {}) => ({
  title, artists: ["Artist"], durationMs: 200000, art: `https://i.scdn.co/${title}`, uri: `spotify:track:${title}`, ...extra,
});
const spotifyQueue = () => ({
  now: item("Now"), upcoming: [item("One"), item("Two"), item("Three")], canJump: true,
});
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const rows = () => [...el("queue-list").querySelectorAll<HTMLButtonElement>(".qr")];
function playback(trackKey: string, extra: Record<string, unknown> = {}) {
  bridge.listeners.get("playback")!({ payload: {
    trackKey, hasTrack: true, progressMs: 50000, durationMs: 200000, isPlaying: false,
    shuffle: false, repeat: "off", canShuffle: true, canRepeatContext: true, canRepeatTrack: true, ...extra,
  } });
}

async function open(answers: Record<string, unknown>) {
  bridge.invoke.mockImplementation(async (command: string) => {
    const answer = answers[command];
    if (answer instanceof Error) throw answer.message;
    return typeof answer === "function" ? answer() : answer;
  });
  await import("./queue");
  await flush();
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  bridge.listeners.clear();
  bridge.focus.length = 0;
  bridge.invoke.mockReset();
  bridge.emitTo.mockReset().mockImplementation(async (_target: string, event: string) => {
    bridge.listeners.get(event)?.({ payload: null });
  });
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  win.onFocusChanged.mockImplementation(async (callback: (event: { payload: boolean }) => void) => {
    bridge.focus.push(callback);
    return () => {};
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn());
  document.documentElement.innerHTML = html;
});

it("lists Spotify's song now and what follows it, then shows itself", async () => {
  await open({ get_config: config(), get_queue: spotifyQueue() });
  expect(el("now-title").textContent).toBe("Now");
  expect(el("queue-now").hidden).toBe(false);
  expect(rows().map((row) => row.querySelector(".qr__title")!.textContent)).toEqual(["One", "Two", "Three"]);
  expect(rows()[0].querySelector(".qr__time")!.textContent).toBe("03:20");
  expect(rows()[0].querySelector<HTMLElement>(".art")!.style.backgroundImage).toContain("https://i.scdn.co/One");
  expect(rows().every((row) => !row.disabled)).toBe(true);
  // Spotify's rows say what they do by being buttons; no caption explains them.
  expect(document.getElementById("queue-sub")).toBeNull();
  expect(el("queue-status").textContent).toBe("");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(win.show).toHaveBeenCalled();
});

it("plays a picked row by where it was listed, then reads the queue again", async () => {
  await open({ get_config: config(), get_queue: spotifyQueue(), jump_queue: undefined });
  rows()[1].click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("jump_queue", { uri: "spotify:track:Two", position: 1 });
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "get_queue")).toHaveLength(2);

  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "jump_queue") throw "That song is no longer in the queue.";
    return spotifyQueue();
  });
  rows()[2].click();
  await flush();
  expect(el("queue-status").textContent).toBe("That song is no longer in the queue.");
  expect(el("queue-list").classList.contains("is-busy")).toBe(false);
});

it("runs one jump at a time, whatever else is pressed meanwhile", async () => {
  let finish!: () => void;
  await open({ get_config: config(), get_queue: spotifyQueue() });
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "jump_queue") return new Promise<void>((resolve) => { finish = resolve; });
    return spotifyQueue();
  });
  rows()[0].click();
  // The keyboard still reaches a row while the list waits.
  rows()[2].click();
  await flush();
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "jump_queue")).toHaveLength(1);
  expect(el("queue-list").getAttribute("aria-busy")).toBe("true");
  finish();
  await flush();
  expect(el("queue-list").hasAttribute("aria-busy")).toBe(false);
});

it("names the player it follows from the track key in a read-only note, and follows a switch", async () => {
  const readOnly = { now: item("Now", { uri: "" }), upcoming: [item("Next", { uri: "" })], canJump: false };
  await open({ get_config: config("spotify"), get_queue: readOnly });
  expect(el("queue-status").textContent).toContain("SPOTIFY");
  // The backend's own prefixes: sp for Spotify, ytmd2 for ytmdesktop2.
  playback("ytmd2:Now|200000");
  expect(el("queue-status").textContent).toContain("YTMDESKTOP2");
});

it("lists ytmdesktop2's queue to read only, without shuffle or repeat", async () => {
  await open({
    get_config: config("ytmdesktop2"),
    get_queue: { now: item("Now", { uri: "" }), upcoming: [item("Next", { artists: [], durationMs: 0, art: null, uri: "" })], canJump: false },
  });
  playback("ytmd2:Now|200000", { shuffle: null, repeat: null, canShuffle: false, canRepeatContext: false, canRepeatTrack: false });
  expect(rows()).toHaveLength(1);
  expect(rows()[0].disabled).toBe(true);
  expect(rows()[0].querySelector(".qr__artist")!.textContent).toBe("—");
  expect(rows()[0].querySelector(".qr__time")!.textContent).toBe("");
  expect(el("queue-status").textContent).toContain("YTMDESKTOP2");
  expect(el("queue-shuffle").hidden).toBe(true);
  expect(el("queue-repeat").hidden).toBe(true);
  rows()[0].click();
  await flush();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "jump_queue")).toBe(false);
});

it("sets Spotify's shuffle and repeat from the header", async () => {
  await open({ get_config: config(), get_queue: spotifyQueue(), set_shuffle: undefined, set_repeat: undefined });
  playback("sp:now");
  expect(el("queue-shuffle").hidden).toBe(false);
  el("queue-shuffle").click();
  el("queue-repeat").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_shuffle", { on: true });
  expect(bridge.invoke).toHaveBeenCalledWith("set_repeat", { repeat: "context" });
  expect(el("queue-shuffle").getAttribute("aria-pressed")).toBe("true");
  expect(el("queue-repeat").dataset.mode).toBe("context");
});

it("plays ytmdesktop queue items unchanged and exposes one-shot shuffle plus repeat", async () => {
  await open({
    get_config: config("ytmdesktop"),
    get_queue: { now: item("Now"), upcoming: [item("Next", { uri: "ytmd:7:video-id", artists: ["Singer", "Guest"], art: "https://i.ytimg.com/vi/video-id/default.jpg" })], canJump: true },
  });
  playback("ytmd:Now", { shuffle: null, repeat: "off" });
  expect(rows()[0].disabled).toBe(false);
  expect(rows()[0].querySelector(".qr__artist")!.textContent).toBe("Singer, Guest");
  expect(rows()[0].querySelector(".qr__time")!.textContent).toBe("03:20");
  expect(rows()[0].querySelector<HTMLElement>(".art")!.style.backgroundImage).toContain("i.ytimg.com");
  rows()[0].click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("jump_queue", { uri: "ytmd:7:video-id", position: 0 });
  const reads = () => bridge.invoke.mock.calls.filter(([command]) => command === "get_queue").length;
  const before = reads();
  expect(el("queue-shuffle").hidden).toBe(false);
  expect(el("queue-shuffle").title).toBe("Shuffle queue");
  expect(el("queue-shuffle").hasAttribute("aria-pressed")).toBe(false);
  el("queue-shuffle").click();
  await flush();
  el("queue-shuffle").click();
  await flush();
  expect(bridge.invoke.mock.calls.filter(([command]) => command === "set_shuffle").map(([, args]) => args)).toEqual([{ on: true }, { on: true }]);
  expect(reads()).toBe(before + 2);
  expect(el("queue-shuffle").hasAttribute("aria-pressed")).toBe(false);
  el("queue-repeat").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_repeat", { repeat: "context" });
});

it("refreshes for queue revisions and external shuffle notifications without a track or toggle change", async () => {
  await open({ get_config: config("ytmdesktop"), get_queue: spotifyQueue() });
  const report = { shuffle: null, queueRevision: "1" };
  playback("ytmd:Now", report);
  const reads = () => bridge.invoke.mock.calls.filter(([command]) => command === "get_queue").length;
  const before = reads();
  playback("ytmd:Now", report);
  expect(reads()).toBe(before);
  playback("ytmd:Now", { ...report, queueRevision: "2" });
  expect(reads()).toBe(before + 1);
  bridge.listeners.get("queue:changed")!({ payload: null });
  expect(reads()).toBe(before + 2);
});

it("reads the queue again when the song changes, when shuffle changes and when focused", async () => {
  await open({ get_config: config(), get_queue: spotifyQueue() });
  const reads = () => bridge.invoke.mock.calls.filter(([command]) => command === "get_queue").length;
  playback("sp:now");
  playback("sp:now");
  expect(reads()).toBe(1);
  playback("sp:one");
  expect(reads()).toBe(2);
  playback("sp:one", { shuffle: true });
  expect(reads()).toBe(3);
  bridge.focus.forEach((callback) => callback({ payload: true }));
  expect(reads()).toBe(4);
  // Refresh waits for the read already on its way.
  await flush();
  el("queue-refresh").click();
  expect(reads()).toBe(5);
});

it("says why there is no queue when the player cannot be reached", async () => {
  await open({ get_config: config(), get_queue: new Error("Not connected to a player") });
  expect(el("queue-empty").hidden).toBe(false);
  expect(el("queue-empty-text").textContent).toBe("Not connected to a player");
  expect(el("queue-list").hidden).toBe(true);
  expect(win.show).toHaveBeenCalled();
});

it("closes from its button and from Escape", async () => {
  await open({ get_config: config(), get_queue: spotifyQueue() });
  el("panel-close").click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(win.close).toHaveBeenCalledTimes(2);
});
