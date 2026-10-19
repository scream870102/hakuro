// @vitest-environment jsdom
import { expect, it } from "vitest";
import { shortcutFromEvent, shortcutConflict } from "./shortcuts";

it("uses physical keys and exact modifiers while rejecting typing, repeat and IME", () => {
  const chord = (init: KeyboardEventInit) => shortcutFromEvent(new KeyboardEvent("keydown", init));
  expect(chord({ key: "あ", code: "KeyK", ctrlKey: true, shiftKey: true })).toBe("Ctrl+Shift+KeyK");
  expect(chord({ key: "F8", code: "F8" })).toBe("F8");
  for (const init of [{ key: "a" }, { key: "A", shiftKey: true }, { key: "Escape", ctrlKey: true }, { key: "k", ctrlKey: true, repeat: true }, { key: "k", ctrlKey: true, isComposing: true }]) expect(chord(init)).toBeUndefined();
  expect(shortcutConflict([{ action: "next", accelerator: "F8", global: true }, { action: "previous", accelerator: "F8", global: false }])).toContain("already bound");
});
