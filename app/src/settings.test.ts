// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../settings.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: bridge.emitTo }));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn(async () => "1.3.0") }));

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
