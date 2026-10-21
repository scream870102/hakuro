// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../palette.html?raw";
import type { PaletteCommand, PaletteSnapshot } from "./palette";
import { describeCommands } from "./palette";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({
  emitTo: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  focus: [] as ((event: { payload: boolean }) => void)[],
}));
const win = vi.hoisted(() => ({
  show: vi.fn(),
  hide: vi.fn(),
  setFocus: vi.fn(),
  isFocused: vi.fn(),
  onFocusChanged: vi.fn(),
}));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: bridge.emitTo,
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(name, callback);
    return () => {};
  }),
}));

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const command = (id: number, label: string, rest: Partial<PaletteCommand> = {}): PaletteCommand =>
  ({ id, group: "PLAYBACK", icon: "·", label, hint: "", words: "", state: null, enabled: true, ...rest });
const COMMANDS = [
  command(0, "Play", { hint: "播放", words: "toggle play pause" }),
  command(1, "Next track", { hint: "下一首", words: "skip" }),
  command(7, "Previous track", { hint: "上一首", words: "skip back", enabled: false }),
  command(14, "Compact mode", { group: "WINDOW", hint: "精簡模式", words: "mini small", state: { text: "OFF", on: false } }),
];

async function show(snapshot: Partial<PaletteSnapshot> = {}) {
  bridge.listeners.get("palette:show")!({ payload: {
    commands: COMMANDS, lines: [], title: "Song", trackKey: "spotify:song-a", accent: "#123456", ...snapshot,
  } });
  await flush();
}
const key = (target: EventTarget, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
function type(text: string) {
  const input = el<HTMLInputElement>("pal-input");
  input.value = text;
  input.dispatchEvent(new Event("input"));
  return input;
}
const sent = (event: string) => bridge.emitTo.mock.calls.filter(([, name]) => name === event).map(([, , payload]) => payload);

beforeEach(async () => {
  vi.resetModules();
  bridge.listeners.clear();
  bridge.emitTo.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  win.onFocusChanged.mockImplementation(async (cb: (e: { payload: boolean }) => void) => {
    bridge.focus.push(cb);
    return () => {};
  });
  bridge.focus.length = 0;
  document.documentElement.innerHTML = html;
  await import("./palette-window");
  await flush();
});

it("tells the main window it is ready, then draws a snapshot, shows itself and takes the focus", async () => {
  expect(sent("palette:ready")).toHaveLength(1);
  await show();
  expect(win.show).toHaveBeenCalled();
  expect(win.setFocus).toHaveBeenCalled();
  expect(document.activeElement).toBe(el("pal-input"));
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(el("pal-list").textContent).toContain("Compact mode");
  expect(el("pal-version").textContent).toBe("HAKURO v1.3.0");
});

it("renders bundled action SVGs while treating unknown icon markup as text", async () => {
  const untrusted = '<img src=x onerror="alert(1)">';
  await show({ commands: [command(0, "Compact lyrics", { icon: "compactLyrics" }), command(1, "Unknown", { icon: untrusted })] });
  const rows = el("pal-list").querySelectorAll(".pal__item");
  expect(rows[0].querySelector('svg[data-icon="compactLyrics"] path')).not.toBeNull();
  expect(rows[1].querySelector("i")?.textContent).toBe(untrusted);
  expect(rows[1].querySelector("img")).toBeNull();
});

it("shows saved shortcut keys and global scope, including search results, and removes stale bindings", async () => {
  const commands = [{ id: "compact", group: "WINDOW", label: "Compact mode", icon: "◱", run: () => {}, state: () => ({ text: "ON", on: true }) }];
  await show({ commands: describeCommands(commands, [{ action: "compact", accelerator: "Ctrl+Alt+KeyC", global: true }]), shortcut: "Ctrl+KeyJ" });
  const badges = () => [...el("pal-list").querySelectorAll("kbd")].map((node) => node.textContent);
  expect(badges()).toEqual(["Ctrl", "Alt", "C"]);
  expect(el("pal-list").textContent).toContain("GLOBAL");
  expect(el("pal-list").textContent).toContain("ON");
  expect(el("pal-binding").textContent).toBe("Ctrl+J OPEN / CLOSE");
  type("compact");
  expect(badges()).toEqual(["Ctrl", "Alt", "C"]);
  await show({ commands: describeCommands(commands, [{ action: "compact", accelerator: "F8", global: false }]), shortcut: "F9", shortcutGlobal: true });
  expect(badges()).toEqual(["F8"]);
  expect(el("pal-list").textContent).not.toContain("GLOBAL");
  expect(el("pal-binding").textContent).toBe("F9 GLOBAL OPEN");
  await show({ commands: describeCommands(commands, []), shortcut: "" });
  expect(badges()).toEqual([]);
  expect(el("pal-binding").textContent).toBe("");
});

it("runs the best match on Enter, finding commands by their Chinese names too, and hides", async () => {
  await show();
  key(type("next"), { key: "Enter" });
  await flush();
  expect(win.hide).toHaveBeenCalled();
  expect(sent("palette:run")).toEqual([{ command: 1 }]);

  await show();
  key(type("精簡"), { key: "Enter" });
  await flush();
  expect(sent("palette:run")).toEqual([{ command: 1 }, { command: 14 }]);
});

it("refuses a command that cannot run and stays open", async () => {
  await show();
  key(type("previous"), { key: "Enter" });
  await flush();
  expect(sent("palette:run")).toEqual([]);
  expect(win.hide).not.toHaveBeenCalled();
});

it("jumps to a lyric line found by its words, shown as text and never as markup", async () => {
  await show({ lines: [
    { index: 0, text: "Hello <b>world</b>", translation: "", time: "00:01" },
    { index: 2, text: "止まらない鼓動", translation: "", time: "00:42" },
  ] });
  type("鼓動");
  const row = el("pal-list").querySelector(".pal__item.is-sel")!;
  expect(row.textContent).toContain("止まらない鼓動");
  expect(row.textContent).toContain("03");
  expect(row.querySelector("mark")?.textContent).toBe("鼓動");
  key(el("pal-input"), { key: "Enter" });
  await flush();
  expect(sent("palette:run")).toEqual([{ line: 2, trackKey: "spotify:song-a" }]);

  await show({ lines: [{ index: 0, text: "Hello <b>world</b>", translation: "", time: "00:01" }] });
  type("world");
  expect(el("pal-list").querySelector("b")).toBeNull();
  expect(el("pal-list").textContent).toContain("Hello <b>world</b>");
});

it("leaves Enter alone while an input method is still composing", async () => {
  await show();
  key(type("next"), { key: "Enter", isComposing: true });
  await flush();
  expect(sent("palette:run")).toEqual([]);
});

it("hides on Escape or Ctrl+K and hands the focus back, but keeps the focus where it went on a blur", async () => {
  await show();
  key(el("pal-input"), { key: "Escape" });
  await flush();
  expect(win.hide).toHaveBeenCalledTimes(1);
  expect(sent("palette:closed")).toHaveLength(1);

  await show();
  key(window, { key: "k", ctrlKey: true });
  await flush();
  expect(win.hide).toHaveBeenCalledTimes(2);
  expect(sent("palette:closed")).toHaveLength(2);

  await show();
  win.isFocused.mockResolvedValue(false);
  bridge.focus.forEach((cb) => cb({ payload: false }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(win.hide).toHaveBeenCalledTimes(3);
  expect(sent("palette:closed")).toHaveLength(2);
});

it("ignores a blur that the focus comes straight back from", async () => {
  await show();
  // Showing hands the focus to the webview and back; that is not a click elsewhere.
  win.isFocused.mockResolvedValue(true);
  bridge.focus.forEach((cb) => cb({ payload: false }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(win.hide).not.toHaveBeenCalled();
});

it("treats a click beside the palette as dismissing it, but not one that only ends there", async () => {
  await show();
  const at = (target: EventTarget, type: string) => target.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  // Selecting text in the field and releasing past the edge.
  at(el("pal-input"), "pointerdown");
  at(document.body, "click");
  expect(win.hide).not.toHaveBeenCalled();

  at(document.body, "pointerdown");
  at(document.body, "click");
  await flush();
  expect(win.hide).toHaveBeenCalled();
  expect(sent("palette:closed")).toHaveLength(1);
});
