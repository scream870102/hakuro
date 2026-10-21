// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import html from "../index.html?raw";
import { createDeck, type Deck } from "./deck";
import { isolateListeners } from "./test-listeners";

isolateListeners(window, document);

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const press = (target: Element, type: string, x = 0, y = 0, pointerId = 1) =>
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, pointerId }));
const click = (target: Element, detail = 1) => target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
let now: number;
let deck: Deck;
let shake: ReturnType<typeof vi.fn>;
let dragWindow: ReturnType<typeof vi.fn>;

beforeEach(() => {
  document.documentElement.innerHTML = html;
  now = 10_000;
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  shake = vi.fn();
  dragWindow = vi.fn();
  deck = createDeck({ beginSeek: vi.fn(), previewSeek: vi.fn(), endSeek: vi.fn(), dragWindow, shake });
  el<HTMLInputElement>("volume").disabled = false;
  el<HTMLInputElement>("volume").value = "40";
  el<HTMLButtonElement>("volume-mute").disabled = false;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function move(target: Element, points: number[], interval = 100, finish = "pointerup") {
  press(target, "pointerdown");
  for (const x of points) {
    now += interval;
    press(target, "pointermove", x);
  }
  press(target, finish, points[points.length - 1] ?? 0);
}

it("keeps the mute centre a native button and leaves activation to main", () => {
  const mute = el<HTMLButtonElement>("volume-mute");
  const activate = vi.fn();
  const change = vi.fn();
  mute.addEventListener("click", activate);
  el("volume").addEventListener("change", change);
  expect(mute.tagName).toBe("BUTTON");
  expect(mute.type).toBe("button");
  expect(mute.getAttribute("aria-label")).toBe("Mute");
  expect(mute.querySelectorAll('svg[aria-hidden="true"]')).toHaveLength(2);
  press(mute, "pointerdown", 10, 10);
  press(mute, "pointerup", 12, 11);
  click(mute);
  click(mute, 0); // The native Enter/Space activation path.
  expect(activate).toHaveBeenCalledTimes(2);
  expect(change).not.toHaveBeenCalled();
  expect(shake).not.toHaveBeenCalled();
  expect(el("scene").classList.contains("is-dragging")).toBe(false);
});

it.each(["pointerup", "pointercancel", "lostpointercapture"])("does not mute after centre dragging or %s", (finish) => {
  const mute = el("volume-mute");
  const activate = vi.fn();
  mute.addEventListener("click", activate);
  press(mute, "pointerdown");
  if (finish === "pointerup") {
    press(mute, "pointermove", 10);
    press(mute, "pointermove", 0); // Returning to the centre is still a drag.
  }
  press(mute, finish);
  press(mute, "pointerup");
  click(mute);
  expect(activate).not.toHaveBeenCalled();
  click(mute, 0);
  expect(activate).toHaveBeenCalledTimes(1);
  press(mute, "pointerdown");
  press(mute, "pointerup");
  click(mute);
  expect(activate).toHaveBeenCalledTimes(2);
});

it("keeps the ring's drag and wheel volume semantics", () => {
  const dial = el("volume-control");
  const volume = el<HTMLInputElement>("volume");
  const change = vi.fn();
  volume.addEventListener("change", change);
  press(dial, "pointerdown", 10, 0);
  press(dial, "pointermove", 0, 10);
  expect(volume.value).toBe("73");
  expect(change).not.toHaveBeenCalled();
  press(dial, "pointerup", 0, 10);
  expect(change).toHaveBeenCalledTimes(1);
  el("volume-mute").dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1 }));
  expect(volume.value).toBe("70");
  vi.advanceTimersByTime(350);
  expect(change).toHaveBeenCalledTimes(2);
  expect(shake).not.toHaveBeenCalled();
});

it("requests one bound action only when a rapid scramble is released, with a cooldown", () => {
  const cube = el("cube");
  press(cube, "pointerdown");
  for (const x of [160, 0, 160]) {
    now += 100;
    press(cube, "pointermove", x);
  }
  expect(shake).not.toHaveBeenCalled();
  press(cube, "pointerup", 160);
  press(cube, "lostpointercapture", 160);
  press(cube, "pointerup", 160);
  expect(shake).toHaveBeenCalledTimes(1);
  move(cube, [160, 0, 160]);
  expect(shake).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 240; i++) deck.tick(now += 16);
  expect(Math.abs(deck.pose().yaw - (-36))).toBeLessThan(1.7);
  now += 1300;
  move(cube, [160, 0, 160]);
  expect(shake).toHaveBeenCalledTimes(2);
});

it.each([
  [false, false, -29, -36],
  [true, false, -29, -36],
  [true, true, -24, -14],
] as const)("returns a shake to the default pose (compact %s, lyrics %s), even without a binding", (compact, stretched, tilt, yaw) => {
  deck.setLayout({ compact, stretched });
  deck.turnTo("back");
  for (let i = 0; i < 240; i++) deck.tick(now += 16);
  // A bound turn command also runs before the gesture restores the front.
  shake.mockImplementationOnce(() => deck.turnTo("right"));
  move(el("cube"), [160, 0, 160]);
  for (let i = 0; i < 240; i++) deck.tick(now += 16);
  expect(deck.pose().tilt).toBeCloseTo(tilt, 1);
  expect(Math.abs(deck.pose().yaw - yaw)).toBeLessThan(1.7); // Includes idle sway.
  shake.mockImplementation(() => {});
  move(el("cube"), [-160, 0, -160]);
  for (let i = 0; i < 240; i++) deck.tick(now += 16);
  expect(deck.pose().tilt).toBeCloseTo(tilt, 1);
  expect(Math.abs(deck.pose().yaw - yaw)).toBeLessThan(1.7);
  // An ordinary drag still selects a different face.
  move(el("cube"), [170]);
  for (let i = 0; i < 240; i++) deck.tick(now += 16);
  expect(Math.abs(deck.pose().yaw - yaw)).toBeGreaterThan(80);
});

it.each([
  ["a normal face turn", [170], 100],
  ["a fast one-way spin", [250, 500, 800], 100],
  ["small jitter", Array.from({ length: 60 }, (_, i) => i % 2 ? 0 : 10), 10],
  ["slow back-and-forth", [160, 0, 160, 0, 160], 500],
  ["one reversal", [300, 0], 100],
] as const)("ignores %s", (_label, points, interval) => {
  move(el("cube"), [...points], interval);
  expect(shake).not.toHaveBeenCalled();
});

it.each(["pointercancel", "lostpointercapture"])("cancels a qualifying scramble on %s and resets the next drag", (finish) => {
  move(el("cube"), [160, 0, 160], 100, finish);
  press(el("cube"), "pointerup", 160);
  expect(shake).not.toHaveBeenCalled();
  move(el("cube"), [170]);
  expect(shake).not.toHaveBeenCalled();
  move(el("cube"), [160, 0, 160]);
  expect(shake).toHaveBeenCalledTimes(1);
});

it("requires recent movement and the same captured pointer", () => {
  const cube = el("cube");
  press(cube, "pointerdown");
  for (const x of [160, 0, 160]) { now += 100; press(cube, "pointermove", x, 0, 2); }
  press(cube, "pointerup", 160, 0, 2);
  expect(shake).not.toHaveBeenCalled();
  press(cube, "pointercancel");
  press(cube, "pointerdown");
  for (const x of [160, 0, 160]) { now += 100; press(cube, "pointermove", x); }
  now += 300;
  press(cube, "pointerup", 160);
  expect(shake).not.toHaveBeenCalled();
});

it("does not count controls, lyrics, background dragging, or autonomous spins", () => {
  for (const target of [el("volume-control"), el("volume-mute"), el("vinyl"), el("queue-open"), el("lyrics-list"), el("scene")]) {
    move(target, [160, 0, 160]);
  }
  deck.setLayout({ compact: true, stretched: true });
  move(el("scene"), [160, 0, 160]);
  expect(dragWindow).toHaveBeenCalledTimes(1);
  deck.trackChanged();
  deck.turnTo("back");
  for (let i = 0; i < 60; i++) deck.tick(now += 16);
  expect(shake).not.toHaveBeenCalled();
  move(el("cube"), [160, 0, 160]);
  expect(shake).toHaveBeenCalledTimes(1);
});
