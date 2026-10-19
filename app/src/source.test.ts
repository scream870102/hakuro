// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../source.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));

const initial = () => ({
  settings: { theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" } },
  providers: [{ id: "lrclib", label: "LRCLIB" }, { id: "musixmatch", label: "Musixmatch" }],
});
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

/** Open the window the way the main window does: the song goes in the URL. */
async function open(song: Record<string, string> = {}) {
  const params = new URLSearchParams({ track: "spotify:song-a", title: "Song A", source: "", ...song });
  history.replaceState(null, "", `/source.html?${params}`);
  await import("./source");
  await flush();
  await flush();
}

beforeEach(() => {
  vi.resetModules();
  bridge.listeners.clear();
  bridge.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "get_config") return initial();
  });
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  document.documentElement.innerHTML = html;
});

it("offers Automatic and every provider with the song's requested source chosen, then shows itself", async () => {
  await open({ source: "musixmatch" });
  const select = el<HTMLSelectElement>("track-source");
  expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Automatic (global preferences)", "LRCLIB", "Musixmatch"]);
  expect(select.value).toBe("musixmatch");
  expect(el("source-track").textContent).toBe("Song A");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(win.show).toHaveBeenCalled();
  expect(document.activeElement).toBe(select);
});

it("applies the choice to the song it was opened for, then closes", async () => {
  await open({ track: "spotify:|100000" });
  el<HTMLSelectElement>("track-source").value = "lrclib";
  el("source-save").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_track_source", { source: "lrclib", trackId: "spotify:|100000" });
  expect(win.close).toHaveBeenCalledTimes(1);
});

it("sends no source for Automatic", async () => {
  await open({ source: "lrclib" });
  el<HTMLSelectElement>("track-source").value = "";
  el("source-save").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("set_track_source", { source: null, trackId: "spotify:song-a" });
});

it("stays open with the reason when applying fails", async () => {
  await open();
  bridge.invoke.mockRejectedValueOnce("Song changed");
  el("source-save").click();
  await flush();
  expect(win.close).not.toHaveBeenCalled();
  expect(el("source-error").textContent).toBe("Song changed");
  expect(el<HTMLButtonElement>("source-save").disabled).toBe(false);
});

it("closes from Cancel, the close button or Escape without applying", async () => {
  await open();
  el("source-cancel").click();
  el("panel-close").click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(win.close).toHaveBeenCalledTimes(3);
  expect(bridge.invoke).not.toHaveBeenCalledWith("set_track_source", expect.anything());
});

it("closes when its song stops playing", async () => {
  await open();
  const playback = bridge.listeners.get("playback")!;
  playback({ payload: { hasTrack: true, trackKey: "spotify:song-a" } });
  expect(win.close).not.toHaveBeenCalled();
  playback({ payload: { hasTrack: true, trackKey: "ytm:Video|1105000" } });
  expect(win.close).toHaveBeenCalled();
});
