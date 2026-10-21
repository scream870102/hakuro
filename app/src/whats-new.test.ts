// @vitest-environment jsdom
/// <reference types="vite/client" />
import { beforeEach, expect, it, vi } from "vitest";
import html from "../whats-new.html?raw";
import { releases } from "./releases";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const bridge = vi.hoisted(() => ({ invoke: vi.fn(), getVersion: vi.fn() }));
const win = vi.hoisted(() => ({ show: vi.fn(), setFocus: vi.fn(), close: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: bridge.getVersion }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const config = { settings: { theme: { accent: "#123456", activeLine: "#ffffff", pastLine: "#666666" } } };
const history = () => [...document.querySelectorAll<HTMLDetailsElement>(".release")];
const status = () => document.getElementById("whats-new-status")!;
const flush = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const open = async () => { await import("./whats-new"); await flush(); };

beforeEach(() => {
  vi.resetModules();
  bridge.getVersion.mockReset().mockResolvedValue("1.6.1");
  bridge.invoke.mockReset().mockImplementation(async (command: string) => command === "get_config" ? config : undefined);
  for (const fn of Object.values(win)) fn.mockReset().mockResolvedValue(undefined);
  document.documentElement.innerHTML = html;
  document.documentElement.removeAttribute("style");
});

it("expands the installed release and lets readers independently open older versions", async () => {
  await open();
  expect(history()).toHaveLength(releases.length);
  expect(history().filter((item) => item.open).map((item) => item.dataset.version)).toEqual(["1.6.1"]);
  expect(history()[0].textContent).toContain("目前版本");
  expect(history()[0].textContent).toContain("0%／100%");
  expect(history()[1].textContent).toContain("ytmdesktop");
  expect(history()[1].textContent).not.toContain("快速來回轉動");
  const previous = history()[1];
  previous.querySelector("summary")!.click();
  expect(previous.open).toBe(true);
  expect(history()[0].open).toBe(true);
  previous.querySelector("summary")!.click();
  expect(previous.open).toBe(false);
  expect(status().classList.contains("is-error")).toBe(false);
});

it("includes every recorded product version, keeping early numbering after official 1.0.0", async () => {
  // Audited against all historical package/Tauri versions, git tags and worklogs.
  const versions = [
    "1.6.1", "1.6.0", "1.5.4", "1.5.3", "1.5.2", "1.5.1", "1.5.0",
    "1.4.1", "1.4.0", "1.3.2", "1.3.1", "1.3.0", "1.2.2", "1.2.1",
    "1.2.0", "1.1.1", "1.1.0", "1.0.0", "4.0.0", "3.0.0",
  ];
  expect(releases.map((release) => release.version)).toEqual(versions);
  expect(new Set(versions).size).toBe(versions.length);
  await open();
  expect(history().map((item) => item.dataset.version)).toEqual(versions);
  expect(history().filter((item) => item.open).map((item) => item.dataset.version)).toEqual(["1.6.1"]);
  for (const item of history().slice(-2)) {
    expect(item.open).toBe(false);
    expect(item.querySelector("summary")!.textContent).toContain("早期開發版本");
  }
});

it("renders and applies the theme before showing, and records seen only after reveal finishes", async () => {
  let finishReveal!: () => void;
  win.show.mockImplementation(async () => {
    expect(history()[0].open).toBe(true);
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });
  win.setFocus.mockImplementation(() => new Promise<void>((resolve) => { finishReveal = resolve; }));
  await open();
  expect(win.show).toHaveBeenCalledOnce();
  expect(win.setFocus).toHaveBeenCalledOnce();
  expect(bridge.invoke).not.toHaveBeenCalledWith("mark_whats_new_seen");
  finishReveal();
  await flush();
  expect(bridge.invoke).toHaveBeenCalledWith("mark_whats_new_seen");
  expect(document.getElementById("whats-new-lean")!.classList.contains("is-in")).toBe(true);
});

it("uses the actual installed version rather than assuming the newest entry", async () => {
  bridge.getVersion.mockResolvedValue("1.6.0");
  await open();
  expect(history().filter((item) => item.open).map((item) => item.dataset.version)).toEqual(["1.6.0"]);
  expect(document.getElementById("whats-new-version")!.textContent).toContain("v1.6.0");
});

it("keeps history visible for an unknown version without acknowledging missing notes", async () => {
  bridge.getVersion.mockResolvedValue("99.0.0");
  await open();
  expect(history()).toHaveLength(releases.length);
  expect(history().every((item) => !item.open)).toBe(true);
  expect(document.getElementById("whats-new-version")!.textContent).toContain("99.0.0");
  expect(status().textContent).toContain("尚未收錄 v99.0.0");
  expect(win.show).toHaveBeenCalledOnce();
  expect(bridge.invoke).not.toHaveBeenCalledWith("mark_whats_new_seen");
});

it("shows a version-read failure while preserving the historical notes", async () => {
  bridge.getVersion.mockRejectedValue(new Error("version unavailable"));
  await open();
  expect(status().textContent).toContain("無法確認目前版本");
  expect(history()).toHaveLength(releases.length);
  expect(history().every((item) => !item.open)).toBe(true);
  expect(win.show).toHaveBeenCalledOnce();
  expect(bridge.invoke).not.toHaveBeenCalledWith("mark_whats_new_seen");
});

it("still displays and acknowledges known notes if reading the theme fails", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "get_config") throw new Error("config unavailable");
  });
  await open();
  expect(status().textContent).toContain("已使用預設配色");
  expect(history()[0].open).toBe(true);
  expect(win.show).toHaveBeenCalledOnce();
  expect(bridge.invoke).toHaveBeenCalledWith("mark_whats_new_seen");
});

it.each(["show", "setFocus"] as const)("does not acknowledge the version when %s fails", async (step) => {
  win[step].mockRejectedValue(new Error("window unavailable"));
  await open();
  expect(bridge.invoke).not.toHaveBeenCalledWith("mark_whats_new_seen");
  expect(status().textContent).toContain("尚未記錄為已讀");
  expect(history()[0].open).toBe(true);
});

it("reports a failed seen-marker write without hiding the notes", async () => {
  bridge.invoke.mockImplementation(async (command: string) => {
    if (command === "mark_whats_new_seen") throw new Error("write failed");
    return config;
  });
  await open();
  expect(win.show).toHaveBeenCalledOnce();
  expect(history()[0].open).toBe(true);
  expect(status().textContent).toContain("無法儲存已讀記錄");
  expect(status().classList.contains("is-error")).toBe(true);
});

it("uses the shared close button and Escape behavior", async () => {
  await open();
  document.getElementById("panel-close")!.click();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
  expect(win.close).toHaveBeenCalledOnce();
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  expect(win.close).toHaveBeenCalledTimes(2);
  expect(document.querySelector("header")!.getAttribute("data-tauri-drag-region")).toBe("deep");
});
