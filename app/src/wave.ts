/**
 * The tile floor under the cube, rippling with whatever this computer plays.
 *
 * The backend listens to the speakers and streams sixteen band levels, bass
 * first. Each tile shows one band — bass behind the cube, treble in front — as
 * it sounded a moment ago, later the further out the tile stands, so every beat
 * spreads from the cube like a ripple.
 *
 * It is drawn on a canvas behind the cube rather than built from elements: a
 * few hundred 3D-transformed tiles would each become a layer of their own, and
 * the canvas also lets each frame paint them far to near. The projection
 * matches the cube's own (see floor.ts), so the floor stays under it as it
 * turns.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { restPoses } from "./deck";
import { FLOOR, fitRing, floorDepth, layTiles, perspectiveFor, projector, type Pose, type Tile } from "./floor";

const BANDS = 16;
/** Display frames of history, one every FRAME_MS. */
const HISTORY = 48;
const FRAME_MS = 1000 / 60;
/** How many of those frames a ripple takes to reach the rim. */
const LAG = 22;
/** Levels older than this are silence: capture stopped sending, so all is still. */
const STALE_MS = 150;
/** A tile in front of the cube stands at most this much of the full height, so it never hides the cube. */
const FRONT_CAP = 0.35;
/** In full mode: how far past its column the floor may reach under the lyrics' margin, in edges. */
const SPILL = 0.3;
/** ...and the soft edge both its ends fade out over, in pixels (styles.css draws it). */
const FADE = 28;

export interface Wave {
  /** Show the floor and listen, or hide it and stop listening. */
  setActive(active: boolean): void;
  setAccent(hex: string): void;
  /** Called every animation frame, after the cube has moved. */
  draw(now: number): void;
}

interface Layout {
  edge: number;
  length: number;
  tiles: Tile[];
  /** The scene's centre in the canvas, in CSS pixels. */
  originX: number;
  originY: number;
  /** Device pixels per CSS pixel. */
  ratio: number;
}

function parseHex(hex: string): [number, number, number] {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return match ? [1, 2, 3].map((index) => parseInt(match[index], 16)) as [number, number, number] : [230, 255, 31];
}

export function createWave(options: {
  zone: HTMLElement;
  scene: HTMLElement;
  cube: HTMLElement;
  pose(): Pose;
  /** Whether the floor may shrink its ring to stay inside the zone (full mode). */
  fitted(): boolean;
}): Wave {
  const { zone, scene, cube } = options;
  const canvas = document.createElement("canvas");
  canvas.className = "wave";
  canvas.setAttribute("aria-hidden", "true");
  canvas.hidden = true;
  zone.prepend(canvas);
  const context = canvas.getContext("2d");

  const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  let active = false;
  let channel: Channel<number[]> | null = null;
  let rgb = parseHex("#e6ff1f");
  let layout: Layout | null = null;
  let dirty = true;

  const history = Array.from({ length: HISTORY }, () => new Uint8Array(BANDS));
  let head = 0;
  const latest = new Uint8Array(BANDS);
  let latestAt = -Infinity;
  let frameClock = 0;
  const silence = new Uint8Array(BANDS);

  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => { dirty = true; });
    for (const element of [zone, scene, cube]) observer.observe(element);
  }

  function relayout() {
    dirty = false;
    const width = zone.clientWidth;
    const height = zone.clientHeight;
    const edge = cube.offsetHeight;
    const length = cube.offsetWidth;
    if (!width || !height || !edge) {
      layout = null;
      return;
    }
    const originX = scene.offsetLeft + scene.offsetWidth / 2;
    const originY = scene.offsetTop + scene.offsetHeight / 2;
    // In full mode the column is narrower than the whole floor at rest, which
    // the cube's own corner nearly fills. The ring shrinks to fit the window's
    // left edge and a little way under the lyrics' margin, then gives up and
    // lets its ends fade out instead, as they also do when the cube is turned.
    // Compact's window is sized for the floor (main.ts), so it never shrinks.
    const fitted = options.fitted();
    const spill = fitted ? Math.round(edge * SPILL) : 0;
    const scale = fitted
      ? fitRing(edge, length, { left: originX + FADE / 2, right: width - originX + spill - FADE / 2 }, restPoses(false))
      : 1;
    canvas.classList.toggle("wave--fade", fitted);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round((width + spill) * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width + spill}px`;
    canvas.style.height = `${height}px`;
    layout = { edge, length, tiles: layTiles(edge, length, scale), originX, originY, ratio };
  }

  /** Move the history on by however many display frames have passed. */
  function advance(now: number) {
    if (!frameClock) frameClock = now;
    let steps = Math.min(HISTORY, Math.floor((now - frameClock) / FRAME_MS));
    if (steps <= 0) return;
    frameClock += steps * FRAME_MS;
    const source = now - latestAt < STALE_MS ? latest : silence;
    while (steps-- > 0) {
      head = (head + 1) % HISTORY;
      history[head].set(source);
    }
  }

  const color = (scale: number, alpha: number) => {
    // Past full brightness the accent runs toward white, like a lit tile.
    const over = Math.max(0, scale - 1);
    const channel = (value: number) => Math.round(Math.min(255, value * Math.min(1, scale) + (255 - value) * over));
    return `rgba(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])}, ${alpha.toFixed(3)})`;
  };

  // Eight corners per tile: x y z (turned) then x y (on screen), five numbers each.
  const corners = new Float64Array(8 * 5);
  const centre = new Float64Array(5);
  /** Each side as four corner indices, outward normal last. */
  const SIDES: [number[], [number, number, number]][] = [
    [[0, 1, 5, 4], [0, 0, -1]],
    [[1, 3, 7, 5], [1, 0, 0]],
    [[3, 2, 6, 7], [0, 0, 1]],
    [[2, 0, 4, 6], [-1, 0, 0]],
  ];

  function fillFace(ctx: CanvasRenderingContext2D, indices: number[], style: string) {
    ctx.fillStyle = style;
    ctx.beginPath();
    indices.forEach((corner, step) => {
      const x = corners[corner * 5 + 3];
      const y = corners[corner * 5 + 4];
      if (step === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fill();
  }

  function draw(now: number) {
    if (!active || !context) return;
    if (dirty) relayout();
    if (!layout) return;
    advance(now);
    const { edge, length, tiles, originX, originY, ratio } = layout;
    const pose = options.pose();
    const perspective = perspectiveFor(edge);
    const project = projector(pose, perspective);
    const ground = floorDepth(edge);
    const tallest = edge * FLOOR.height;
    const half = (edge * FLOOR.tile) / 2;
    const frontX = length / 2 + edge * FLOOR.margin;
    const still = motion?.matches ?? false;

    // The turned normals and the eye decide which sides face the reader;
    // turning is linear, so a normal turns like any point.
    const normals = SIDES.map(([, [x, y, z]]) => {
      const out = new Float64Array(5);
      project(x, y, z, out);
      return out;
    });
    const up = new Float64Array(5);
    project(0, -1, 0, up);

    // Far to near, so nearer tiles paint over farther ones.
    const yaw = (pose.yaw * Math.PI) / 180;
    const order = tiles.map((tile, index) => {
      project(tile.x, ground, tile.z, centre);
      return {
        index,
        depth: centre[2],
        // In front of the cube, as it is turned now, before it tips toward the reader.
        inFront: -tile.x * Math.sin(yaw) + tile.z * Math.cos(yaw) > 0 && Math.abs(centre[0]) < frontX,
      };
    });
    order.sort((a, b) => a.depth - b.depth);

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.translate(originX, originY);

    for (const { index, inFront } of order) {
      const tile = tiles[index];
      const lag = Math.round(tile.reach * LAG);
      const band = Math.round(tile.around * (BANDS - 1));
      const raw = still ? 0 : history[(head - lag + HISTORY) % HISTORY][band] / 255;
      const level = Math.pow(raw, 1.25);
      const height = Math.max(1, tallest * level * (1 - 0.45 * tile.reach) * (inFront ? FRONT_CAP : 1));
      const top = ground - height;
      for (let corner = 0; corner < 8; corner++) {
        project(
          tile.x + (corner & 1 ? half : -half),
          corner & 4 ? ground : top,
          tile.z + (corner & 2 ? half : -half),
          corners,
          corner * 5,
        );
      }
      project(tile.x, ground - height / 2, tile.z, centre);
      const alpha = 1 - 0.6 * Math.pow(tile.reach, 1.5);
      const bright = 0.28 + 0.92 * level;
      const eye = (normal: Float64Array) =>
        normal[0] * -centre[0] + normal[1] * -centre[1] + normal[2] * (perspective - centre[2]) > 0;
      SIDES.forEach(([indices], side) => {
        if (eye(normals[side])) fillFace(context, indices, color(bright * (side % 2 ? 0.5 : 0.66), alpha * 0.9));
      });
      if (eye(up)) fillFace(context, [0, 1, 3, 2], color(bright, alpha));
    }
  }

  async function start() {
    const levels = new Channel<number[]>();
    levels.onmessage = (message) => {
      // A capture that was stopped may still have a frame on its way.
      if (channel !== levels) return;
      latest.set(message.slice(0, BANDS));
      latestAt = performance.now();
    };
    channel = levels;
    try {
      await invoke("start_wave", { levels });
    } catch {
      // No backend (a test page): the floor simply stays still.
    }
  }

  function stop() {
    channel = null;
    latestAt = -Infinity;
    invoke("stop_wave").catch(() => { /* no backend: nothing was listening */ });
  }

  return {
    setActive(next) {
      if (next === active) return;
      active = next;
      canvas.hidden = !next;
      dirty = true;
      // A floor that cannot move gains nothing from listening.
      if (next && !(motion?.matches ?? false)) void start();
      else if (!next && channel) stop();
    },
    setAccent(hex) {
      rgb = parseHex(hex);
    },
    draw,
  };
}
