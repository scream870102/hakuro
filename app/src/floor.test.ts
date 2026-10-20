import { expect, it } from "vitest";
import { fitRing, FLOOR, floorExtent, layTiles, projector } from "./floor";

it("lays tiles round the cube's footprint, never under it, each knowing how far out and round it stands", () => {
  const edge = 200;
  const length = 500;
  const tiles = layTiles(edge, length);
  expect(tiles.length).toBeGreaterThan(100);
  const halfX = length / 2 + edge * FLOOR.margin;
  const halfZ = edge / 2 + edge * FLOOR.margin;
  for (const tile of tiles) {
    expect(Math.abs(tile.x) > halfX || Math.abs(tile.z) > halfZ).toBe(true);
    expect(tile.reach).toBeGreaterThanOrEqual(0);
    expect(tile.reach).toBeLessThanOrEqual(1);
  }
  // Bass behind the cube, treble in front of it.
  const behind = tiles.find((tile) => tile.x === 0 && tile.z < 0)!;
  const front = tiles.find((tile) => tile.x === 0 && tile.z > 0)!;
  expect(behind.around).toBeCloseTo(0);
  expect(front.around).toBeCloseTo(1);
  // A smaller ring has fewer tiles.
  expect(layTiles(edge, length, 0.5).length).toBeLessThan(tiles.length);
});

it("projects like CSS: a quarter turn of rotateY carries +x to -z, and nearer points spread out", () => {
  const out = new Float64Array(5);
  projector({ tilt: 0, yaw: 90 }, 1500)(100, 0, 0, out);
  expect(out[0]).toBeCloseTo(0);
  expect(out[2]).toBeCloseTo(-100);
  // Farther away than the screen plane, so drawn smaller.
  expect(out[3]).toBeCloseTo(0);
  projector({ tilt: 0, yaw: 0 }, 1500)(100, 50, 300, out);
  expect(out[3]).toBeCloseTo(100 * 1500 / 1200);
  expect(out[4]).toBeCloseTo(50 * 1500 / 1200);
});

it("measures how far the floor reaches on screen, evenly either side when the cube faces the reader", () => {
  const level = floorExtent(200, 200, 1, [{ tilt: 0, yaw: 0 }]);
  expect(level.left).toBeCloseTo(level.right);
  // Looking down on it, the floor's near edge falls further below the cube than its far edge rises.
  const tilted = floorExtent(200, 200, 1, [{ tilt: -24, yaw: 0 }]);
  expect(tilted.below).toBeGreaterThan(tilted.above);
  expect(floorExtent(200, 200, 0.5, [{ tilt: -24, yaw: 0 }]).right).toBeLessThan(tilted.right);
});

it("shrinks the ring until the floor fits the room it has, and no further than it is told", () => {
  const poses = [{ tilt: -29, yaw: -36 }];
  const roomy = { left: 1000, right: 1000 };
  expect(fitRing(200, 200, roomy, poses)).toBe(1);
  const full = floorExtent(200, 200, 1, poses);
  const room = { left: full.left * 0.85, right: full.right * 0.85 };
  const scale = fitRing(200, 200, room, poses);
  expect(scale).toBeLessThan(1);
  expect(scale).toBeGreaterThan(0.4);
  const fitted = floorExtent(200, 200, scale, poses);
  expect(fitted.left).toBeLessThanOrEqual(room.left);
  expect(fitted.right).toBeLessThanOrEqual(room.right);
  // A column narrower than the cube itself: the smallest ring, left to spill.
  expect(fitRing(200, 200, { left: 50, right: 50 }, poses)).toBe(0.4);
  expect(fitRing(200, 200, { left: 50, right: 50 }, poses, 0.3)).toBe(0.3);
});
