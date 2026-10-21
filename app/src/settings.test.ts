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
    waveFull: true,
    waveCompact: false,
    waveStrength: 100,
    checkUpdates: true,
    shakeAction: "randomQueue" as string | null,
    lastSeenVersion: "1.3.0",
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
  expect(el<HTMLInputElement>("settings-check-updates").checked).toBe(true);
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(win.show).toHaveBeenCalled();
  expect(win.setFocus).toHaveBeenCalled();
});

it("opens release notes through main without saving the settings draft", async () => {
  expect(el<HTMLSelectElement>("settings-shake-action").value).toBe("randomQueue");
  el("whats-new-open").click();
  await flush();
  expect(bridge.emitTo).toHaveBeenCalledWith("main", "whats-new:open");
  expect(bridge.invoke.mock.calls.some(([command]) => command === "save_settings")).toBe(false);
  expect(win.close).not.toHaveBeenCalled();
});

it("offers every palette action and can save no shake binding", async () => {
  const select = el<HTMLSelectElement>("settings-shake-action");
  expect([...select.options].map(option => option.value)).toEqual(["", ...SHORTCUT_ACTIONS.map(([action]) => action)]);
  select.value = "";
  submit();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: expect.objectContaining({ shakeAction: null }) });
});

it("saves Client ID, provider order/enabled state, colors and follow as one settings update, then closes", async () => {
  el<HTMLInputElement>("client-id").value = `  ${"b".repeat(32)}  `;
  el<HTMLInputElement>("color-accent").value = "#abcdef";
  el<HTMLInputElement>("color-active").value = "#fedcba";
  el<HTMLInputElement>("color-past").value = "#112233";
  el<HTMLInputElement>("settings-follow").checked = false;
  el<HTMLInputElement>("settings-check-updates").checked = false;
  el<HTMLSelectElement>("settings-shake-action").value = "compactLyrics";
  // The floor's two switches start from what is stored, one per mode.
  expect(el<HTMLInputElement>("settings-wave-full").checked).toBe(true);
  expect(el<HTMLInputElement>("settings-wave-compact").checked).toBe(false);
  el<HTMLInputElement>("settings-wave-full").checked = false;
  el<HTMLInputElement>("settings-wave-compact").checked = true;
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
    checkUpdates: false,
    shakeAction: "compactLyrics",
    lastSeenVersion: "1.3.0",
    alwaysOnTop: false,
    opacity: 100,
    clickThrough: "off",
    compact: false,
    compactLyrics: false,
    compactOpacity: 85,
    lyricSize: 26,
    compactLyricSize: 18,
    waveFull: false,
    waveCompact: true,
    waveStrength: 100,
    shortcuts: initial().settings.shortcuts,
  } });
  expect(win.close).toHaveBeenCalled();
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

it("keeps ytmdesktop separate from ytmdesktop2 and preserves its port", async () => {
  const player = el<HTMLSelectElement>("settings-player");
  expect([...player.options].map((option) => option.value)).toEqual(["spotify", "ytmdesktop", "ytmdesktop2"]);
  expect(el("ytmdesktop-settings").hidden).toBe(true);
  player.value = "ytmdesktop";
  player.dispatchEvent(new Event("change"));
  expect(el("ytmdesktop-settings").hidden).toBe(false);
  expect(el("spotify-settings").hidden).toBe(true);
  expect(el("ytmd-settings").hidden).toBe(true);
  expect(el("ytmdesktop-settings").textContent).toContain("Companion server");
  expect(el("ytmdesktop-settings").textContent).toContain("Enable companion authorization");
  expect(el("ytmdesktop-settings").textContent).toContain("30 seconds");
  expect(el("ytmdesktop-settings").querySelector("input")).toBeNull();
  el<HTMLInputElement>("ytmd-port").value = "invalid";
  submit();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("save_settings", { incoming: expect.objectContaining({ player: "ytmdesktop", ytmdPort: 13091 }) });
  player.value = "ytmdesktop2";
  player.dispatchEvent(new Event("change"));
  expect(el("ytmdesktop-settings").hidden).toBe(true);
  expect(el("ytmd-settings").hidden).toBe(false);
});

it("previews the opacity, size and wave strength dials on the main window as they move", async () => {
  const size = el<HTMLInputElement>("settings-lyric-size");
  size.value = "40";
  size.dispatchEvent(new Event("input"));
  expect(el("lyric-size-value").textContent).toBe("40px");
  expect(bridge.emitTo).toHaveBeenLastCalledWith("main", "settings:preview", {
    opacity: 100, compactOpacity: 85, lyricSize: 40, compactLyricSize: 18, waveStrength: 100,
  });
  const strength = el<HTMLInputElement>("settings-wave-strength");
  expect(el("wave-strength-value").textContent).toBe("100%");
  strength.value = "150";
  strength.dispatchEvent(new Event("input"));
  expect(el("wave-strength-value").textContent).toBe("150%");
  expect(bridge.emitTo).toHaveBeenLastCalledWith("main", "settings:preview", expect.objectContaining({ waveStrength: 150 }));
  submit();
  await flush();
  const saved = bridge.invoke.mock.calls.find(([command]) => command === "save_settings")!;
  expect(saved[1].incoming.waveStrength).toBe(150);
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

it("folds the shortcut list away, grouped as the palette is, and stops recording when it folds", () => {
  const section = el<HTMLDetailsElement>("shortcuts");
  expect(section.open).toBe(false);
  expect(el("shortcut-count").textContent).toBe("2 bound");
  expect([...document.querySelectorAll(".shortcut-group")].map((group) => group.textContent))
    .toEqual(["GENERAL", "PLAYBACK", "LYRICS", "WINDOW", "CUBE"]);
  expect(document.querySelectorAll(".shortcut-row")).toHaveLength(SHORTCUT_ACTIONS.length);
  section.open = true;
  el("shortcut-turnBack").click();
  press({ key: "F8", code: "F8" });
  expect(el("shortcut-count").textContent).toBe("3 bound");
  el("shortcut-queue").click();
  expect(el("shortcut-queue").textContent).toBe("Press keys…");
  section.open = false;
  section.dispatchEvent(new Event("toggle"));
  expect(el("shortcut-queue").textContent).toBe("Not bound");
  expect(el("shortcut-status").textContent).toBe("Recording cancelled.");
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
