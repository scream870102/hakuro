import { describe, expect, it } from "vitest";

import { activeLine, formatTime, positionAt, type Sample } from "./clock";

const sample = (overrides: Partial<Sample> = {}): Sample => ({
  positionMs: 0,
  playing: false,
  durationMs: 10_000,
  receivedAt: 0,
  ...overrides,
});

describe("positionAt", () => {
  it("advances while playing and holds while paused", () => {
    const playing = sample({ positionMs: 1000, playing: true });
    expect(positionAt(playing, 1500)).toBe(2500);

    const paused = sample({ positionMs: 2500, playing: false, receivedAt: 1500 });
    expect(positionAt(paused, 10_000)).toBe(2500);
  });

  it("stops extrapolating five seconds after the last sample", () => {
    const stale = sample({ positionMs: 1000, playing: true, durationMs: 100_000 });
    expect(positionAt(stale, 50_000)).toBe(6000);
  });

  it("never runs past the end of the track", () => {
    const nearEnd = sample({ positionMs: 9900, playing: true });
    expect(positionAt(nearEnd, 1000)).toBe(10_000);
  });

  it("cannot extrapolate a missing position", () => {
    const unknown = sample({ positionMs: null, playing: true });
    expect(positionAt(unknown, 3000)).toBe(0);
  });

  it("reports nothing without a duration", () => {
    expect(positionAt(sample({ positionMs: 5000, playing: true, durationMs: 0 }), 1000)).toBe(0);
  });
});

describe("activeLine", () => {
  const times = [1000, 2000];

  it("holds the line from its own timestamp until the next one", () => {
    expect(activeLine(times, 999)).toBe(-1);
    expect(activeLine(times, 1000)).toBe(0);
    expect(activeLine(times, 1500)).toBe(0);
    expect(activeLine(times, 2000)).toBe(1);
    expect(activeLine(times, 60_000)).toBe(1);
  });

  it("handles seeking back before the first line, and empty lyrics", () => {
    expect(activeLine(times, 0)).toBe(-1);
    expect(activeLine([], 999)).toBe(-1);
  });
});

describe("formatTime", () => {
  it("pads minutes and seconds and clamps negatives", () => {
    expect(formatTime(0)).toBe("00:00");
    expect(formatTime(61_000)).toBe("01:01");
    expect(formatTime(600_000)).toBe("10:00");
    expect(formatTime(-5)).toBe("00:00");
  });
});
