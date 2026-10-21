import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
const { createModes, nextRepeat, repeatLabel, shuffleLabel } = await import("./modes");

beforeEach(() => {
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
  vi.mocked(emitTo).mockReset().mockResolvedValue(undefined);
});

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

it("shuffles ytmdesktop's queue repeatedly without inventing a toggle state", async () => {
  const state = createModes(vi.fn(), vi.fn());
  state.receive({ ...modes("off"), trackKey: "ytmd:song", shuffle: null });
  state.toggleShuffle();
  state.toggleShuffle();
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(invoke).toHaveBeenNthCalledWith(1, "set_shuffle", { on: true });
  expect(invoke).toHaveBeenNthCalledWith(2, "set_shuffle", { on: true });
  expect(state.current.shuffle).toBeNull();
  expect(shuffleLabel(state.current.shuffle)).toBe("Shuffle queue");
  expect(emitTo).toHaveBeenCalledTimes(2);
  expect(emitTo).toHaveBeenCalledWith("queue", "queue:changed");
  state.receive({ trackKey: "ytmd2:song", shuffle: null, canShuffle: false });
  state.toggleShuffle();
  expect(invoke).toHaveBeenCalledTimes(2);
});

it("keeps repeat optimistic when shuffle has no toggle state", () => {
  const state = createModes(vi.fn(), vi.fn());
  const report = { ...modes("off"), trackKey: "ytmd:song", shuffle: null };
  state.receive(report);
  state.cycleRepeat();
  state.receive(report);
  expect(state.current.repeat).toBe("context");
});

it("drops held values and old errors when the player changes, including a rapid switch back", async () => {
  const done = vi.fn();
  const state = createModes(vi.fn(), done);
  let reject!: (error: string) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  state.receive({ ...modes("off"), trackKey: "sp:song" });
  state.cycleRepeat();
  expect(state.current.repeat).toBe("context");
  state.receive({ ...modes("track"), trackKey: "ytmd:song", shuffle: null });
  expect(state.current.repeat).toBe("track");
  state.receive({ trackKey: "ytmd2:song", shuffle: null, repeat: null });
  state.receive({ ...modes("off"), trackKey: "sp:song" });
  expect(state.current.repeat).toBe("off");
  reject("Old player refused");
  await Promise.resolve();
  expect(state.current.repeat).toBe("off");
  expect(done).not.toHaveBeenCalled();
});

it("reports failed queue shuffle without sending a queue change", async () => {
  const done = vi.fn();
  const state = createModes(vi.fn(), done);
  vi.mocked(invoke).mockRejectedValueOnce("Not connected");
  state.receive({ ...modes("off"), trackKey: "ytmd:song", shuffle: null });
  state.toggleShuffle();
  await Promise.resolve();
  expect(done).toHaveBeenCalledWith("Not connected");
  expect(emitTo).not.toHaveBeenCalled();
  expect(state.current.shuffle).toBeNull();
});
