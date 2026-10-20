/**
 * The tile floor's shape, and where it lands on screen. The floor that draws
 * it (wave.ts) and the compact window that has to make room for it (main.ts)
 * both read it from here, so they agree to the pixel.
 *
 * Lengths are fractions of the cube's edge. Positions are in the cube's own
 * frame, before it turns: x along its width, y down, z toward the reader, the
 * cube's centre at the origin. The projection repeats the cube's transform
 * (rotateX, then rotateY) and the scene's perspective in styles.css.
 */

export const FLOOR = {
  /** How far under the cube's bottom face the floor lies; the cube floats over it. */
  gap: 0.16,
  /** Tile pitch, and each tile's side. */
  step: 0.122,
  tile: 0.09,
  /** Bare floor kept round the cube's footprint, so no tile stands under it. */
  margin: 0.06,
  /** How far the tiles reach beyond that. */
  ring: 0.58,
  /** The tallest a tile stands. */
  height: 0.19,
};

export interface Tile {
  x: number;
  z: number;
  /** 0 at the bare floor's edge, 1 at the outer rim: how late a ripple arrives. */
  reach: number;
  /** 0 straight behind the cube, 1 straight in front: which sound it shows. */
  around: number;
}

/** A turned cube: its rotateX and rotateY, in degrees. */
export interface Pose {
  tilt: number;
  yaw: number;
}

/** The scene's perspective for a cube this size; styles.css sets the same. */
export const perspectiveFor = (edge: number) => Math.max(1500, edge * 7);

/** How far below the cube's centre the floor lies. */
export const floorDepth = (edge: number) => edge / 2 + edge * FLOOR.gap;

/** Every tile round a cube `edge` deep and `length` wide, the ring scaled by `scale`. */
export function layTiles(edge: number, length: number, scale = 1): Tile[] {
  const step = edge * FLOOR.step;
  const halfX = length / 2 + edge * FLOOR.margin;
  const halfZ = edge / 2 + edge * FLOOR.margin;
  const ring = edge * FLOOR.ring * scale;
  const columns = Math.ceil((halfX + ring) / step);
  const rows = Math.ceil((halfZ + ring) / step);
  const tiles: Tile[] = [];
  for (let i = -columns; i <= columns; i++) {
    for (let j = -rows; j <= rows; j++) {
      const x = i * step;
      const z = j * step;
      const outX = Math.max(0, Math.abs(x) - halfX);
      const outZ = Math.max(0, Math.abs(z) - halfZ);
      // Under the cube, or past the rim.
      if (outX === 0 && outZ === 0) continue;
      const distance = Math.hypot(outX, outZ);
      if (distance > ring) continue;
      tiles.push({ x, z, reach: distance / ring, around: Math.atan2(Math.abs(x), -z) / Math.PI });
    }
  }
  return tiles;
}

/**
 * Turn a point the way the cube is turned. Writes the turned point (x, y, z)
 * and its place on screen (x, y) into `out`, so a frame's thousands of points
 * allocate nothing.
 */
export function projector(pose: Pose, perspective: number) {
  const a = (pose.tilt * Math.PI) / 180;
  const b = (pose.yaw * Math.PI) / 180;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
  return (x: number, y: number, z: number, out: Float64Array, at = 0) => {
    const x1 = x * cb + z * sb;
    const z1 = -x * sb + z * cb;
    const y2 = y * ca - z1 * sa;
    const z2 = y * sa + z1 * ca;
    const k = perspective / (perspective - z2);
    out[at] = x1;
    out[at + 1] = y2;
    out[at + 2] = z2;
    out[at + 3] = x1 * k;
    out[at + 4] = y2 * k;
  };
}

/** Where the floor may reach from the cube's centre on screen. */
export interface Room {
  left: number;
  right: number;
}

export interface Extent {
  left: number;
  right: number;
  above: number;
  below: number;
}

/**
 * How far the floor reaches from the cube's centre on screen, every tile at
 * full height, in any of `poses`.
 */
export function floorExtent(edge: number, length: number, scale: number, poses: Pose[]): Extent {
  const tiles = layTiles(edge, length, scale);
  const half = (edge * FLOOR.tile) / 2;
  const ground = floorDepth(edge);
  const tops = [ground, ground - edge * FLOOR.height];
  const point = new Float64Array(5);
  const extent = { left: 0, right: 0, above: 0, below: 0 };
  for (const pose of poses) {
    const project = projector(pose, perspectiveFor(edge));
    for (const tile of tiles) {
      for (const y of tops) {
        for (const dx of [-half, half]) {
          for (const dz of [-half, half]) {
            project(tile.x + dx, y, tile.z + dz, point);
            extent.left = Math.max(extent.left, -point[3]);
            extent.right = Math.max(extent.right, point[3]);
            extent.above = Math.max(extent.above, -point[4]);
            extent.below = Math.max(extent.below, point[4]);
          }
        }
      }
    }
  }
  return extent;
}

/**
 * The largest ring, in steps of 0.05, whose floor stays inside `room` in
 * every one of `poses`; never under `least`, where it is left to spill.
 */
export function fitRing(edge: number, length: number, room: Room, poses: Pose[], least = 0.4): number {
  for (let scale = 1; scale > least + 1e-9; scale -= 0.05) {
    const extent = floorExtent(edge, length, scale, poses);
    if (extent.left <= room.left && extent.right <= room.right) return scale;
  }
  return least;
}
