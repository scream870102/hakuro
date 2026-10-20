// @vitest-environment jsdom
/// <reference types="vite/client" />
import { expect, it } from "vitest";
import backend from "../src-tauri/src/shortcuts.rs?raw";
import { SHORTCUT_ACTIONS, shortcutFromEvent, shortcutConflict } from "./shortcuts";

it("offers exactly the actions the backend accepts, in the same order", () => {
  const start = backend.indexOf("pub const ACTIONS");
  const list = backend.slice(start, backend.indexOf("];", start));
  expect([...list.matchAll(/"(\w+)"/g)].map((match) => match[1])).toEqual(SHORTCUT_ACTIONS.map(([action]) => action));
});

it("uses physical keys and exact modifiers while rejecting typing, repeat and IME", () => {
  const chord = (init: KeyboardEventInit) => shortcutFromEvent(new KeyboardEvent("keydown", init));
  expect(chord({ key: "あ", code: "KeyK", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+KeyK");
  expect(chord({ key: "F8", code: "F8" })).toBe("F8");
  for (const init of [{ key: "a" }, { key: "A", shiftKey: true }, { key: "Escape", ctrlKey: true }, { key: "k", ctrlKey: true, repeat: true }, { key: "k", ctrlKey: true, isComposing: true }]) expect(chord(init)).toBeUndefined();
  expect(shortcutConflict([{ action: "next", accelerator: "F8", global: true }, { action: "previous", accelerator: "F8", global: false }])).toContain("already bound");
});
