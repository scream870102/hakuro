// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../settings.html?raw";
import { isolateListeners } from "./test-listeners";
import { SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS } from "./shortcuts";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn(), capture: undefined as undefined | ((event: { payload: string }) => void) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: bridge.emitTo, listen: vi.fn(async (_event, callback) => { bridge.capture = callback; }) }));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));

const initial = () => ({
  settings: {
    player: "spotify",
    clientId: "a".repeat(32),
    ytmdPort: 13091,
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
    shortcuts: SHORTCUT_ACTIONS.map(([action]) => ({ action, accelerator: "", global: false, ...DEFAULT_SHORTCUTS.find((item) => item.action === action) })),
  },
  providers: [{ id: "lrclib", label: "LRCLIB" }, { id: "musixmatch", label: "Musixmatch" }],
  dataDir: "C:/Hakuro", storedTracks: 2, storageWarning: "",
});
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const submit = () => el("settings-form").dispatchEvent(new Event("submit", { cancelable: true }));

beforeEach(async () => {
  vi.resetModules();
  bridge.invoke.mockReset().mockImplementation(async (command: string, args?: { incoming?: unknown }) => {
    if (command === "get_config") return initial();
    if (command === "save_settings") return { ...initial(), settings: args!.incoming };
  });
  bridge.emitTo.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  document.documentElement.innerHTML = html;
  await import("./settings");
  await flush();
  await flush();
});

it("fills in what is stored, then shows itself", async () => {
  expect(el<HTMLInputElement>("client-id").value).toBe("a".repeat(32));
  expect(el<HTMLInputElement>("settings-lyric-size").value).toBe("26");
  expect(el("lyric-size-value").textContent).toBe("26px");
  expect(el("source-order").textContent).toContain("Musixmatch");
  expect(el("storage-info").textContent).toBe("Data folder: C:/Hakuro · Cached songs: 2");
  expect(el("app-version").textContent).toBe("v1.3.0");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(win.show).toHaveBeenCalled();
  expect(win.setFocus).toHaveBeenCalled();
});

it("saves Client ID, provider order/enabled state, colors and follow as one settings update, then closes", async () => {
  el<HTMLInputElement>("client-id").value = `  ${"b".repeat(32)}  `;
  el<HTMLInputElement>("color-accent").value = "#abcdef";
  el<HTMLInputElement>("color-active").value = "#fedcba";
  el<HTMLInputElement>("color-past").value = "#112233";
  el<HTMLInputElement>("settings-follow").checked = false;
  const enabled = el("source-order").querySelector("input")!;
  enabled.checked = false;
  enabled.dispatchEvent(new Event("change"));
  el("source-order").querySelectorAll("button")[1].click();
  submit();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: {
    player: "spotify",
    clientId: "b".repeat(32),
    ytmdPort: 13091,
    sources: [{ id: "musixmatch", enabled: true }, { id: "lrclib", enabled: false }],
    theme: { accent: "#abcdef", activeLine: "#fedcba", pastLine: "#112233" },
    followLyrics: false,
    alwaysOnTop: false,
    opacity: 100,
    clickThrough: "off",
    compact: false,
    compactLyrics: false,
    compactOpacity: 85,
    lyricSize: 26,
    compactLyricSize: 18,
    shortcuts: initial().settings.shortcuts,
  } });
  expect(win.close).toHaveBeenCalled();
});

it("hides the Spotify setup when the player is switched to YouTube Music, and saves the choice", async () => {
  // Spotify is the stored choice, so its setup starts visible.
  expect(el("spotify-settings").hidden).toBe(false);
  const player = el<HTMLSelectElement>("settings-player");
  player.value = "ytmusic";
  player.dispatchEvent(new Event("change"));
  // YouTube Music has nothing to sign in to, so the Client ID stops being asked for.
  expect(el("spotify-settings").hidden).toBe(true);

  submit();
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  expect((saved[1] as { incoming: { player: string } }).incoming.player).toBe("ytmusic");
});

it("asks ytmdesktop2 for its port only, and saves the player with the port", async () => {
  expect(el("ytmd-settings").hidden).toBe(true);
  expect(el<HTMLInputElement>("ytmd-port").value).toBe("13091");
  const player = el<HTMLSelectElement>("settings-player");
  player.value = "ytmdesktop2";
  player.dispatchEvent(new Event("change"));
  expect(el("ytmd-settings").hidden).toBe(false);
  expect(el("spotify-settings").hidden).toBe(true);

  el<HTMLInputElement>("ytmd-port").value = " 20000 ";
  submit();
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  const incoming = (saved[1] as { incoming: { player: string; ytmdPort: number } }).incoming;
  expect(incoming.player).toBe("ytmdesktop2");
  expect(incoming.ytmdPort).toBe(20000);
});

it("refuses a port ytmdesktop2 would not accept, but only while it is the player", async () => {
  const player = el<HTMLSelectElement>("settings-player");
  const port = el<HTMLInputElement>("ytmd-port");
  player.value = "ytmdesktop2";
  for (const wrong of ["80", "40000", "13091x", ""]) {
    port.value = wrong;
    submit();
    await flush();
    expect(el("settings-error").textContent).toContain("9999 to 39999");
  }
  expect(bridge.invoke.mock.calls.some(([command]) => command === "save_settings")).toBe(false);

  // Spotify does not use the port, so a stray value there must not block saving;
  // the stored port is kept instead.
  player.value = "spotify";
  submit();
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  expect((saved[1] as { incoming: { ytmdPort: number } }).incoming.ytmdPort).toBe(13091);
});

it("previews the opacity and size dials on the main window as they move", async () => {
  const size = el<HTMLInputElement>("settings-lyric-size");
  size.value = "40";
  size.dispatchEvent(new Event("input"));
  expect(el("lyric-size-value").textContent).toBe("40px");
  expect(bridge.emitTo).toHaveBeenLastCalledWith("main", "settings:preview", {
    opacity: 100, compactOpacity: 85, lyricSize: 40, compactLyricSize: 18,
  });
});

it("closes without saving from Cancel, the close button or Escape", async () => {
  el("settings-cancel").click();
  el("panel-close").click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(win.close).toHaveBeenCalledTimes(3);
  expect(bridge.invoke).not.toHaveBeenCalledWith("save_settings", expect.anything());
});

it("stays open with the entered values when saving fails", async () => {
  bridge.invoke.mockRejectedValueOnce("Settings folder is read-only");
  el<HTMLInputElement>("client-id").value = "invalid";
  submit();
  await flush();
  expect(win.close).not.toHaveBeenCalled();
  expect(el<HTMLInputElement>("client-id").value).toBe("invalid");
  expect(el("settings-error").textContent).toContain("read-only");
  expect(el<HTMLButtonElement>("settings-save").disabled).toBe(false);
});

const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));

it("records shortcuts, rejects duplicates and lets Escape cancel without closing settings", async () => {
  el("shortcut-playPause").click();
  press({ key: "k", code: "KeyK", ctrlKey: true });
  expect(el("shortcut-status").textContent).toContain("already bound");
  expect(el("shortcut-playPause").textContent).toBe("Press keys…");
  press({ key: "Escape" });
  expect(win.close).not.toHaveBeenCalled();
  expect(el("shortcut-playPause").textContent).toBe("Not bound");
  el("shortcut-playPause").click();
  press({ key: "F8", code: "F8" });
  submit();
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  expect(saved[1].incoming.shortcuts).toContainEqual({ action: "playPause", accelerator: "F8", global: false });
});

it("clears and resets draft bindings without saving until requested", async () => {
  document.querySelector<HTMLButtonElement>('[aria-label="Clear Commands"]')!.click();
  expect(el("shortcut-commands").textContent).toBe("Not bound");
  el("shortcuts-reset").click();
  expect(el("shortcut-commands").textContent).toBe("Ctrl+K");
  expect(bridge.invoke.mock.calls.some(([command]) => command === "save_settings")).toBe(false);
});

it("records an OS-delivered existing global chord only while recording and still checks conflicts", () => {
  bridge.capture!({ payload: "Ctrl+Alt+KeyP" });
  expect(el("shortcut-playPause").textContent).toBe("Not bound");
  el("shortcut-playPause").click();
  bridge.capture!({ payload: "Ctrl+Alt+KeyP" });
  expect(el("shortcut-status").textContent).toContain("already bound");
  press({ key: "Escape" });
  el("shortcut-clickThrough").click();
  bridge.capture!({ payload: "Ctrl+Alt+KeyP" });
  expect(el("shortcut-clickThrough").textContent).toBe("Ctrl+Alt+P");
  expect(el("shortcut-clickThrough").getAttribute("aria-pressed")).toBe("false");
});
