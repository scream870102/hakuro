// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../search.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  emitTo: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: bridge.emitTo,
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const initial = () => ({
  settings: {
    theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" },
    sources: [{ id: "lrclib", enabled: true }, { id: "musixmatch", enabled: true }, { id: "netease", enabled: false }],
  },
  providers: [{ id: "lrclib", label: "LRCLIB" }, { id: "musixmatch", label: "Musixmatch" }, { id: "netease", label: "NetEase" }],
});
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const candidate = { source: "lrclib", id: "123", title: "別名 <b>Song</b>", artists: ["Singer"], album: "Record", duration_ms: 123000 };
const preview = { source: "LRCLIB", matched_title: candidate.title, text: "Original", cues: [
  { time_ms: 1000, text: "Original", translation: "翻譯" },
], errors: [] };

function submitSearch(query = "別名") {
  el<HTMLInputElement>("lyrics-query").value = query;
  el("lyrics-search-form").dispatchEvent(new Event("submit", { cancelable: true }));
}

/** Open the window the way the main window does: the song goes in the URL. */
async function open(song: Record<string, string> = {}) {
  const params = new URLSearchParams({
    track: "spotify:song-a", title: "Song A · Artist", query: "Song A Artist", manual: "", translations: "1", ...song,
  });
  history.replaceState(null, "", `/search.html?${params}`);
  await import("./search");
  await flush();
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  bridge.listeners.clear();
  bridge.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "get_config") return initial();
  });
  bridge.emitTo.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  document.documentElement.innerHTML = html;
});

it("fills in the song it was opened for, then shows itself with the query selected", async () => {
  await open();
  expect(el("lyrics-search-track").textContent).toBe("Song A · Artist");
  expect(el<HTMLInputElement>("lyrics-query").value).toBe("Song A Artist");
  expect(document.activeElement).toBe(el("lyrics-query"));
  // Only enabled sources that can search by title.
  expect(Array.from(el<HTMLSelectElement>("lyrics-search-source").options).map((option) => option.value)).toEqual(["lrclib"]);
  expect(el<HTMLInputElement>("show-translations").checked).toBe(true);
  expect(el<HTMLButtonElement>("lyrics-match-clear").disabled).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(win.show).toHaveBeenCalled();
  expect(win.setFocus).toHaveBeenCalled();
});

it("searches, safely previews metadata and saves the chosen match, then closes", async () => {
  await open();
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch("  別名  ");
  expect(el("lyrics-search-status").textContent).toBe("Searching…");
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("search_lyrics", { trackId: "spotify:song-a", query: "別名", source: "lrclib" });
  expect(el("lyrics-candidates").textContent).toContain("Singer · Record · 02:03 · lrclib");
  expect(el("lyrics-candidates").querySelector("b")).toBeNull();
  bridge.invoke.mockResolvedValueOnce(preview);
  el("lyrics-candidates").querySelector("button")!.click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("preview_lyric_candidate", { trackId: "spotify:song-a", candidate });
  expect(el("lyrics-preview").textContent).toContain("00:01  Original\n    翻譯");
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(false);
  el("lyrics-match-apply").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("apply_lyric_match", { trackId: "spotify:song-a", candidate });
  expect(win.close).toHaveBeenCalled();
});

it("ignores superseded searches and preview responses after the query is edited", async () => {
  await open();
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
  el("lyrics-match-apply").click();
  expect(bridge.invoke.mock.calls.some(([command]) => command === "apply_lyric_match")).toBe(false);
});

it("shows empty/error states, rejects empty previews and restores an existing manual match", async () => {
  await open({ manual: "1" });
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
  expect(bridge.invoke).toHaveBeenCalledWith("clear_lyric_match", { trackId: "spotify:song-a" });
  expect(win.close).toHaveBeenCalled();
});

it("stays open and usable when saving the match fails", async () => {
  await open();
  bridge.invoke.mockResolvedValueOnce([candidate]);
  submitSearch();
  await flush();
  bridge.invoke.mockResolvedValueOnce(preview);
  el("lyrics-candidates").querySelector("button")!.click();
  await flush();
  bridge.invoke.mockRejectedValueOnce("Disk full");
  el("lyrics-match-apply").click();
  expect(el<HTMLInputElement>("lyrics-query").disabled).toBe(true);
  await flush();
  expect(win.close).not.toHaveBeenCalled();
  expect(el("lyrics-search-status").textContent).toBe("Disk full");
  expect(el<HTMLInputElement>("lyrics-query").disabled).toBe(false);
  expect(el<HTMLButtonElement>("lyrics-match-apply").disabled).toBe(false);
});

it("says how to search when no source that searches by title is enabled", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") return { ...initial(), settings: { ...initial().settings, sources: [{ id: "musixmatch", enabled: true }] } };
  });
  await open();
  expect(el<HTMLSelectElement>("lyrics-search-source").options).toHaveLength(0);
  expect(el<HTMLButtonElement>("lyrics-search-submit").disabled).toBe(true);
  expect(el("lyrics-search-status").textContent).toContain("Enable LRCLIB, NetEase or QQ Music");
});

it("closes when its song stops playing, but not for another poll of the same song", async () => {
  await open();
  const playback = bridge.listeners.get("playback")!;
  playback({ payload: { hasTrack: true, trackKey: "spotify:song-a" } });
  expect(win.close).not.toHaveBeenCalled();
  playback({ payload: { hasTrack: true, trackKey: "spotify:song-b" } });
  expect(win.close).toHaveBeenCalledTimes(1);
  playback({ payload: { hasTrack: false, trackKey: "" } });
  expect(win.close).toHaveBeenCalledTimes(2);
});

it("closes from Close, the close button or Escape without saving", async () => {
  await open();
  el("lyrics-search-close").click();
  el("panel-close").click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  // Escape that ends an IME composition is the composition's, not the window's.
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
  expect(win.close).toHaveBeenCalledTimes(3);
  expect(bridge.invoke.mock.calls.some(([command]) => String(command).includes("lyric_match"))).toBe(false);
});

it("tells the main window when translations are switched", async () => {
  await open({ translations: "" });
  const translations = el<HTMLInputElement>("show-translations");
  expect(translations.checked).toBe(false);
  translations.checked = true;
  translations.dispatchEvent(new Event("change"));
  expect(bridge.emitTo).toHaveBeenCalledWith("main", "search:translations", true);
});
