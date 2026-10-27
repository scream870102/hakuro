// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../update.html?raw";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
const win = vi.hoisted(() => ({ close: vi.fn(), show: vi.fn(), setFocus: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.5.2" }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
const el = (id: string) => document.getElementById(id)!;
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.resetModules();
  bridge.invoke.mockReset().mockImplementation(async (command) => {
    if (command === "get_config") return { settings: { theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" } } };
  });
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/update.html?version=1.6.0");
  await import("./update");
  await flush();
});

it("shows current/new versions with the saved theme and focuses the install button", () => {
  expect(el("update-version").textContent).toBe("v1.5.2 → v1.6.0");
  expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  expect(el("update-release").hidden).toBe(true);
  expect(win.show).toHaveBeenCalled();
  expect(document.activeElement).toBe(el("update-install"));
});

it("installs the downloaded update only after Restart now is clicked", async () => {
  expect(bridge.invoke).not.toHaveBeenCalledWith("install_update");
  el("update-install").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("install_update");
  expect(el("update-error").hidden).toBe(true);
});

it("falls back to the GitHub release when installing fails, and permits retry", async () => {
  bridge.invoke.mockRejectedValueOnce(new Error("installer failed"));
  el("update-install").click();
  await flush();
  expect(el("update-error").hidden).toBe(false);
  expect(el("update-release").hidden).toBe(false);
  expect(el("update-release").getAttribute("href")).toBe("https://github.com/scream870102/hakuro/releases/latest");
  expect((el("update-install") as HTMLButtonElement).disabled).toBe(false);
  expect(win.close).not.toHaveBeenCalled();

  el("update-release").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("open_latest_release");
  expect(win.close).toHaveBeenCalledTimes(1);
});

it("keeps the notification open and permits retry when the browser cannot open", async () => {
  bridge.invoke.mockRejectedValueOnce(new Error("browser unavailable"));
  el("update-release").click();
  await flush();
  expect(el("update-error").hidden).toBe(false);
  expect(win.close).not.toHaveBeenCalled();
  el("update-release").click();
  await flush();
  expect(el("update-error").hidden).toBe(true);
  expect(win.close).toHaveBeenCalledTimes(1);
});

it("only links to GitHub for a build that cannot update itself", async () => {
  vi.resetModules();
  document.documentElement.innerHTML = html;
  history.replaceState(null, "", "/update.html?version=1.6.0&manual=1");
  await import("./update");
  await flush();
  expect(el("update-title").textContent).toBe("New version available");
  expect(el("update-message").textContent).toContain("GitHub");
  expect(el("update-install").hidden).toBe(true);
  expect(el("update-release").hidden).toBe(false);
  expect(document.activeElement).toBe(el("update-release"));
  el("update-release").click();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("open_latest_release");
  expect(bridge.invoke).not.toHaveBeenCalledWith("install_update");
});

it("dismisses from Later, close or Escape without installing", () => {
  el("update-dismiss").click();
  el("panel-close").click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(win.close).toHaveBeenCalledTimes(3);
  expect(bridge.invoke).not.toHaveBeenCalledWith("install_update");
  expect(bridge.invoke).not.toHaveBeenCalledWith("open_latest_release");
});
