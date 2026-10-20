import { expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const { nextRepeat, repeatLabel } = await import("./modes");

const modes = (repeat: "off" | "context" | "track" | null, canRepeatContext = true, canRepeatTrack = true) =>
  ({ shuffle: false, repeat, canShuffle: true, canRepeatContext, canRepeatTrack });

it("moves repeat from off to all to one and round again", () => {
  expect(nextRepeat(modes("off"))).toBe("context");
  expect(nextRepeat(modes("context"))).toBe("track");
  expect(nextRepeat(modes("track"))).toBe("off");
  expect(repeatLabel("context")).toBe("Repeat: all");
});

it("skips what the player will not take now, and offers nothing when it takes nothing", () => {
  expect(nextRepeat(modes("off", false, true))).toBe("track");
  expect(nextRepeat(modes("context", true, false))).toBe("off");
  expect(nextRepeat(modes("off", false, false))).toBeNull();
  // Turning it off is always allowed.
  expect(nextRepeat(modes("track", false, false))).toBe("off");
  // A player that does not report repeat has nothing to move.
  expect(nextRepeat(modes(null))).toBeNull();
});
