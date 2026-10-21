/**
 * The cube deck: the controls live on an object you can grab and turn. The
 * album cover is the front (tap it to play or pause; its colour is the play
 * state; skip sits at its edges while the pointer is over it), volume is on the
 * right, the record is on top with the queue at its centre, and lyric and
 * window tools are round the back.
 *
 * Nothing here talks to the backend. Every gesture ends as a click on one of the
 * real controls, or as input/change on the volume range, so main.ts keeps one
 * code path for each command and the tests keep exercising it.
 */

import type { Pose } from "./floor";

/** Semi-implicit spring; good enough for UI wobble. */
class Spring {
  velocity = 0;
  target: number;
  constructor(public value: number, private k: number, private c: number) {
    this.target = value;
  }
  step(dtMs: number) {
    const dt = Math.min(0.05, dtMs / 1000);
    this.velocity += (-this.k * (this.value - this.target) - this.c * this.velocity) * dt;
    this.value += this.velocity * dt;
  }
  kick(velocity: number) {
    this.velocity += velocity;
  }
  snap(value: number) {
    this.value = this.target = value;
    this.velocity = 0;
  }
}

export type CubeFace = "front" | "right" | "back" | "left";

export interface Deck {
  /** Advance every spring; main.ts calls this from its own animation frame. */
  tick(now: number): void;
  /** Show new artwork. Mid-spin it waits until the front has turned away. */
  setCover(url: string | null): void;
  /** The confirmed play state; a change floods the cover with the new one. */
  setPlaying(playing: boolean): void;
  /** Spin the cube a full turn, in the direction of the last skip. */
  trackChanged(): void;
  /** Throw a few shards off the line that has just started. */
  lineChanged(line: HTMLElement): void;
  /** The outlined word behind everything. */
  setTitle(text: string): void;
  turnTo(face: CubeFace): void;
  /**
   * Compact moves the dial round to the left face, and once stretched the record
   * to the right; a stretched cube rests turned nearer to face-on.
   */
  setLayout(layout: { compact: boolean; stretched: boolean }): void;
  /** How the cube is turned right now, sway included; the floor turns with it. */
  pose(): Pose;
}

const NORMALS: Record<string, [number, number, number]> = {
  front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, -1, 0], bottom: [0, 1, 0],
};
const LIGHT = (() => {
  const v = [-0.45, -1, 0.75];
  const m = Math.hypot(...v);
  return v.map((x) => x / m);
})();
const REST_X = -29;
const REST_Y = -36;
/** Stretched, the front carries the lyrics, so the cube turns to show more of it. */
const STRETCHED_REST = { x: -24, y: -14 };
const FACE_TURN: Record<CubeFace, number> = { front: 0, right: -90, back: 180, left: 90 };
/** The idle float: how far the cube bobs (px) and sways (deg) while it rests. */
const BOB = 5;
const SWAY = 1.6;
/** One full turn of the record moves playback this far. */
const SCRATCH_MS_PER_TURN = 10_000;
/** A press that travels less than this is a tap, not a drag. */
const TAP_SLOP = 6;
const SCRAMBLE_WINDOW_MS = 900;
const SCRAMBLE_COOLDOWN_MS = 1200;
const HINT_KEY = "hakuro.cube-hint-seen";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrapAngle = (d: number) => (d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d);

/** Restart a CSS animation that is keyed to a class. */
function retrigger(el: Element, name: string) {
  el.classList.remove(name);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(name);
}

/**
 * How tall the stretched cube (edge x edge x length) stands on screen resting on
 * any of its sides, float included: the room compact's window leaves it. Turned
 * end-on, its length tips toward the reader and the near end looms. Mirrors the
 * cube's transform below and the scene's perspective in styles.css.
 */
export function stretchedHeight(edge: number, length: number) {
  const perspective = Math.max(1500, edge * 7);
  const tilt = (STRETCHED_REST.x * Math.PI) / 180;
  let reach = 0;
  for (const turn of Object.values(FACE_TURN)) {
    for (const sway of [-SWAY, 0, SWAY]) {
      const yaw = ((STRETCHED_REST.y + turn + sway) * Math.PI) / 180;
      for (const x of [-length / 2, length / 2]) {
        for (const y of [-edge / 2, edge / 2]) {
          for (const z of [-edge / 2, edge / 2]) {
            // rotateX(tilt) rotateY(yaw), then the perspective divide.
            const turned = z * Math.cos(yaw) - x * Math.sin(yaw);
            const up = y * Math.cos(tilt) - turned * Math.sin(tilt);
            const near = y * Math.sin(tilt) + turned * Math.cos(tilt);
            reach = Math.max(reach, (Math.abs(up) * perspective) / (perspective - near));
          }
        }
      }
    }
  }
  return 2 * (reach + BOB);
}

/**
 * The turns the floor has to fit at rest: facing front or back, swaying. A
 * stretched cube turned end-on points its floor at the reader too; that rare
 * turn may run past compact's window rather than make the window far taller.
 */
export function restPoses(stretched: boolean): Pose[] {
  const rest = stretched ? STRETCHED_REST : { x: REST_X, y: REST_Y };
  return [FACE_TURN.front, FACE_TURN.back].flatMap((turn) =>
    [-SWAY, 0, SWAY].map((sway) => ({ tilt: rest.x, yaw: rest.y + turn + sway })));
}

export function createDeck(options: {
  beginSeek(): void;
  previewSeek(ms: number): void;
  endSeek(commit: boolean): void;
  dragWindow(): void;
  /** A deliberate rapid scramble, once on release; main checks player support. */
  randomQueue?(): void;
}): Deck {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const scene = byId("scene");
  const cube = byId("cube");
  const faces = [...cube.querySelectorAll<HTMLElement>(".face")];
  const front = byId("cover-face");
  const coverBox = byId("cover-box");
  const rightFace = cube.querySelector<HTMLElement>(".face--right")!;
  const topFace = cube.querySelector<HTMLElement>(".face--top")!;
  const leftFace = cube.querySelector<HTMLElement>(".face--left")!;
  const coverBase = byId<HTMLImageElement>("album-art");
  const coverPeek = byId<HTMLImageElement>("cover-peek");
  const discArt = byId<HTMLImageElement>("disc-art");
  const playPause = byId<HTMLButtonElement>("play-pause");
  const dial = byId("volume-control");
  const volume = byId<HTMLInputElement>("volume");
  const mute = byId<HTMLButtonElement>("volume-mute");
  const vinyl = byId("vinyl");
  const disc = byId("disc");
  const shadow = byId("shadow");
  const glow = byId("glow");
  const hint = byId("cube-hint");
  const bgWord = byId("bg-word");
  const shardLayer = byId("shards");

  const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const calm = () => motion?.matches ?? false;

  let rest = { x: REST_X, y: REST_Y };
  let compact = false;
  const rx = new Spring(REST_X, 120, 12);
  const ry = new Spring(REST_Y, 120, 12);
  const lift = new Spring(0, 260, 13);
  const squash = new Spring(1, 420, 15);
  const lens = new Spring(0, 200, 17);
  const lx = new Spring(50, 320, 26);
  const ly = new Spring(50, 320, 26);
  const motor = new Spring(0, 22, 9);
  const parX = new Spring(0, 40, 12);
  const parY = new Spring(0, 40, 12);
  let glowLevel = 0.25;
  let last = 0;
  let sway = 0;

  function thump(power = 1, dir = 0) {
    squash.kick(-3.4 * power);
    lift.kick(150 * power);
    ry.kick(dir * 80 * power);
    rx.kick(-45 * power);
    glowLevel = Math.max(glowLevel, 0.45 + 0.55 * power);
  }

  /** A short head-shake for a press that cannot do anything right now. */
  function refuse() {
    ry.kick(260);
    squash.kick(-1);
  }

  function lightFaces() {
    const a = (ry.value * Math.PI) / 180;
    const b = (rx.value * Math.PI) / 180;
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
    for (const face of faces) {
      const [x, y, z] = NORMALS[face.dataset.face ?? "front"];
      const x1 = x * ca + z * sa;
      const z1 = -x * sa + z * ca;
      const y2 = y * cb - z1 * sb;
      const z2 = y * sb + z1 * cb;
      const d = x1 * LIGHT[0] + y2 * LIGHT[1] + z2 * LIGHT[2];
      face.style.setProperty("--l", (0.16 + 0.84 * Math.max(0, d)).toFixed(3));
    }
  }

  // ------------------------------------------------------------- the cover

  let lensOn = false;
  let playingKnown = false;
  let flood: { t0: number; r0: number; playing: boolean } | null = null;
  let spinStarted = -Infinity;
  let pendingCover: { url: string | null; since: number } | null = null;

  function applyCover(url: string | null) {
    for (const img of [coverBase, coverPeek, discArt]) {
      if (url) img.src = url;
      else img.removeAttribute("src");
    }
  }

  /** offsetX/Y are in the target's own (3D-transformed) space; climb to the cover. */
  function aimLens(event: PointerEvent) {
    let el = event.target instanceof HTMLElement ? event.target : null;
    if (!el || !coverBox.offsetWidth) return;
    let x = event.offsetX;
    let y = event.offsetY;
    for (; el && el !== coverBox; el = el.offsetParent as HTMLElement | null) {
      x += el.offsetLeft;
      y += el.offsetTop;
    }
    lx.target = (x / coverBox.offsetWidth) * 100;
    ly.target = (y / coverBox.offsetHeight) * 100;
    if (lens.value < 0.02) {
      lx.snap(lx.target);
      ly.snap(ly.target);
    }
  }
  // Over the skip buttons the pointer means skip, not play or pause.
  const overSkip = (event: PointerEvent) => event.target instanceof Element && Boolean(event.target.closest(".cover-skip"));
  coverBox.addEventListener("pointerenter", (event) => { lensOn = !overSkip(event); });
  coverBox.addEventListener("pointerleave", () => { lensOn = false; });
  coverBox.addEventListener("pointermove", (event) => {
    lensOn = !overSkip(event);
    aimLens(event);
  });
  coverBox.addEventListener("pointerdown", (event) => {
    aimLens(event);
    lens.kick(4);
  });

  // The new state spreads from the lens (or pours down from the record when the
  // change came from elsewhere) until it covers the face, then becomes the base.
  function setPlaying(playing: boolean) {
    motor.target = playing ? 1 : 0;
    const shown = front.classList.contains("is-color");
    if (!playingKnown) {
      playingKnown = true;
      front.classList.toggle("is-color", playing);
      return;
    }
    if (flood) {
      if (flood.playing === playing) return;
      // Reversed before the flood finished: the base already shows this state.
      flood = null;
      if (shown === playing) return;
    }
    if (shown === playing) return;
    if (!lensOn) {
      lx.snap(50);
      ly.snap(0);
    }
    flood = { t0: performance.now(), r0: Math.max(0, lens.value * 0.3), playing };
    thump(0.8, 0);
  }

  function coverFrame(dt: number, now: number) {
    lens.target = lensOn && !(drag && drag.moved > TAP_SLOP) ? 1 : 0;
    lens.step(dt);
    lx.step(dt);
    ly.step(dt);
    let lk = Math.max(0, lens.value * 0.3);
    if (flood) {
      const p = clamp((now - flood.t0) / 560, 0, 1);
      lk = flood.r0 + (1.45 - flood.r0) * (1 - Math.pow(1 - p, 3));
      if (p >= 1) {
        front.classList.toggle("is-color", flood.playing);
        flood = null;
        lens.snap(0);
        lk = 0;
      }
    }
    front.classList.toggle("is-flooding", flood !== null);
    front.style.setProperty("--lk", lk.toFixed(3));
    front.style.setProperty("--mx", `${lx.value.toFixed(1)}%`);
    front.style.setProperty("--my", `${ly.value.toFixed(1)}%`);
    if (pendingCover && (Math.cos((ry.value * Math.PI) / 180) < -0.2 || now - pendingCover.since > 1200)) {
      applyCover(pendingCover.url);
      pendingCover = null;
    }
  }

  // ------------------------------------------------------- turning the cube

  let drag: {
    id: number; x: number; y: number; rx: number; ry: number; t: number; vel: number; moved: number; cover: boolean;
    turns: { x: number; y: number; at: number }[];
  } | null = null;
  let lastScramble = -Infinity;

  function scrambled(now: number) {
    const turns = drag?.turns.filter((point) => now - point.at <= SCRAMBLE_WINDOW_MS) ?? [];
    if (turns.length < 4 || now - turns[turns.length - 1].at > 200) return false;
    let path = 0, reversals = 0;
    let anchor = turns[0];
    let direction: { x: number; y: number } | null = null;
    for (let i = 1; i < turns.length; i++) {
      const point = turns[i];
      path += Math.hypot(point.x - turns[i - 1].x, point.y - turns[i - 1].y);
      const leg = { x: point.x - anchor.x, y: point.y - anchor.y };
      // A 30° leg (~55px horizontally) keeps tiny pointer jitter out of reversals.
      if (Math.hypot(leg.x, leg.y) < 30) continue;
      if (direction && direction.x * leg.x + direction.y * leg.y < 0) reversals++;
      direction = leg;
      anchor = point;
    }
    // Roughly 455px of horizontal movement; an ordinary face turn is only 90°.
    return path >= 250 && reversals >= 2;
  }

  function hideHint() {
    if (hint.classList.contains("gone")) return;
    hint.classList.add("gone");
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* private window: the hint just comes back */ }
  }
  try { if (localStorage.getItem(HINT_KEY)) hint.classList.add("gone"); } catch { /* keep the hint */ }

  scene.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    // Compact's window is the cube on clear glass: the glass moves the window.
    if (compact && event.target === scene) {
      options.dragWindow();
      return;
    }
    if ((event.target as Element).closest("button, input, .vinyl, .dial, .lyrics")) return;
    const now = performance.now();
    drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY, rx: rx.value, ry: ry.value, t: now, vel: 0, moved: 0,
      cover: Boolean((event.target as Element).closest(".cover-box")),
      turns: cube.contains(event.target as Node) ? [{ x: ry.value, y: rx.value, at: now }] : [],
    };
    scene.setPointerCapture?.(event.pointerId);
    scene.classList.add("is-dragging");
  });
  scene.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
    if (drag.moved > TAP_SLOP) hideHint();
    const nextY = drag.ry + (event.clientX - drag.x) * 0.55;
    const nextX = clamp(drag.rx - (event.clientY - drag.y) * 0.4, -78, 18);
    const now = performance.now();
    if (drag.turns.length) {
      drag.turns = drag.turns.filter((point) => now - point.at <= SCRAMBLE_WINDOW_MS);
      drag.turns.push({ x: nextY, y: nextX, at: now });
    }
    drag.vel = drag.vel * 0.6 + ((nextY - ry.value) / Math.max(1, now - drag.t)) * 1000 * 0.4;
    drag.t = now;
    ry.value = ry.target = nextY;
    rx.value = rx.target = nextX;
  });
  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.id) return;
    const now = performance.now();
    const random = event.type === "pointerup" && now - lastScramble >= SCRAMBLE_COOLDOWN_MS && scrambled(now);
    const tap = drag.cover && drag.moved < TAP_SLOP && event.type === "pointerup";
    ry.velocity = drag.vel * 0.5;
    const projected = ry.value + drag.vel * 0.12;
    ry.target = rest.y + Math.round((projected - rest.y) / 90) * 90;
    rx.target = rest.x;
    rx.velocity = 0;
    drag = null;
    scene.classList.remove("is-dragging");
    if (random) {
      lastScramble = now;
      options.randomQueue?.();
    }
    if (tap) togglePlayback();
  }
  scene.addEventListener("pointerup", endDrag);
  scene.addEventListener("pointercancel", endDrag);
  scene.addEventListener("lostpointercapture", endDrag);

  /** The colour follows the confirmed state; the tap itself answers with a bounce. */
  function togglePlayback() {
    if (playPause.disabled) {
      refuse();
      return;
    }
    playPause.click();
    lens.kick(6);
    thump(0.6, 0);
  }

  function turnTo(face: CubeFace) {
    const base = rest.y + FACE_TURN[face];
    ry.target = base + Math.round((ry.value - base) / 360) * 360;
    rx.target = rest.x;
    thump(0.5, 0);
  }

  function setLayout(layout: { compact: boolean; stretched: boolean }) {
    compact = layout.compact;
    shardLayer.hidden = compact && !layout.stretched;
    if (shardLayer.hidden) shardLayer.replaceChildren();
    const home = compact ? leftFace : rightFace;
    if (dial.parentElement !== home) home.append(dial);
    // Compact's lid takes the top; stretched, the record turns up at the right end.
    const record = compact && layout.stretched ? rightFace : topFace;
    if (vinyl.parentElement !== record) record.prepend(vinyl);
    const next = layout.compact && layout.stretched ? STRETCHED_REST : { x: REST_X, y: REST_Y };
    if (next.y === rest.y && next.x === rest.x) return;
    // Keep whichever face was turned to the reader; only the resting angle moves.
    ry.target = next.y + Math.round((ry.target - rest.y) / 90) * 90;
    rx.target = next.x;
    rest = next;
  }

  // ------------------------------------------------ the record on top

  let discAngle = 0;
  let scratch: { cx: number; cy: number; a: number; moved: number; turned: number } | null = null;
  const angleOf = (event: PointerEvent, centre: { cx: number; cy: number }) =>
    Math.atan2(event.clientY - centre.cy, event.clientX - centre.cx);

  vinyl.addEventListener("pointerdown", (event) => {
    // The queue button at its centre is a button, not a grip on the record.
    if (event.button !== 0 || (event.target as Element).closest("button")) return;
    const box = vinyl.getBoundingClientRect();
    scratch = { cx: box.left + box.width / 2, cy: box.top + box.height / 2, a: 0, moved: 0, turned: 0 };
    scratch.a = angleOf(event, scratch);
    options.beginSeek();
    vinyl.setPointerCapture?.(event.pointerId);
    vinyl.classList.add("is-held");
  });
  vinyl.addEventListener("pointermove", (event) => {
    if (!scratch) return;
    const a = angleOf(event, scratch);
    const d = wrapAngle(a - scratch.a);
    scratch.a = a;
    scratch.moved += Math.abs(d);
    scratch.turned += d;
    discAngle += (d * 180) / Math.PI;
    options.previewSeek(Math.round((scratch.turned / (2 * Math.PI)) * SCRATCH_MS_PER_TURN));
  });
  function endScratch(event: PointerEvent) {
    if (!scratch) return;
    const { moved, turned } = scratch;
    scratch = null;
    vinyl.classList.remove("is-held");
    options.endSeek(event.type === "pointerup" && moved >= 0.08 && Math.abs(turned) > 0.05);
    if (event.type !== "pointerup") return;
    // One seek for the whole gesture: the player is a network call away.
    if (moved >= 0.08 && Math.abs(turned) > 0.05) {
      thump(0.4, Math.sign(turned));
    }
  }
  vinyl.addEventListener("pointerup", endScratch);
  vinyl.addEventListener("pointercancel", endScratch);
  vinyl.addEventListener("lostpointercapture", endScratch);

  // ------------------------------------------------------- the volume dial

  // The dial drives the hidden range exactly as a drag on a native slider would:
  // pointerdown, input while moving, pointerup, then change only if it moved.
  let dialDrag: { cx: number; cy: number; a: number; acc: number; start: number } | null = null;
  let wheelTimer = 0;
  let shownVolume = -1;

  // Keep the centre a native button, but never let a pointer drag become mute.
  let mutePress: { id: number; x: number; y: number } | null = null;
  let muteDragged = false;
  mute.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || mute.disabled) return;
    mutePress = { id: event.pointerId, x: event.clientX, y: event.clientY };
    muteDragged = false;
    mute.setPointerCapture?.(event.pointerId);
  });
  mute.addEventListener("pointermove", (event) => {
    if (mutePress?.id === event.pointerId) {
      muteDragged ||= Math.hypot(event.clientX - mutePress.x, event.clientY - mutePress.y) > TAP_SLOP;
    }
  });
  function endMutePress(event: PointerEvent) {
    if (!mutePress || mutePress.id !== event.pointerId) return;
    muteDragged ||= event.type !== "pointerup" || Math.hypot(event.clientX - mutePress.x, event.clientY - mutePress.y) > TAP_SLOP;
    mutePress = null;
  }
  mute.addEventListener("pointerup", endMutePress);
  mute.addEventListener("pointercancel", endMutePress);
  mute.addEventListener("lostpointercapture", endMutePress);
  mute.addEventListener("click", (event) => {
    // Keyboard activation has detail 0 and remains available after a cancelled drag.
    if (muteDragged && event.detail !== 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  function setVolume(value: number) {
    const next = String(Math.round(clamp(value, 0, 100)));
    if (next === volume.value) return;
    volume.value = next;
    volume.dispatchEvent(new Event("input", { bubbles: true }));
    if (next === "0" || next === "100") {
      retrigger(dial, "bump");
      thump(0.5, next === "100" ? 1 : -1);
    }
  }

  dial.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input")) return;
    if (volume.disabled) {
      retrigger(dial, "bump");
      return;
    }
    const box = dial.getBoundingClientRect();
    dialDrag = { cx: box.left + box.width / 2, cy: box.top + box.height / 2, a: 0, acc: Number(volume.value), start: Number(volume.value) };
    dialDrag.a = angleOf(event, dialDrag);
    dial.setPointerCapture?.(event.pointerId);
    dial.classList.add("is-held");
    volume.dispatchEvent(new Event("pointerdown"));
  });
  dial.addEventListener("pointermove", (event) => {
    if (!dialDrag || volume.disabled) return;
    const a = angleOf(event, dialDrag);
    dialDrag.acc = clamp(dialDrag.acc + (wrapAngle(a - dialDrag.a) / (2 * Math.PI)) * 133, 0, 100);
    dialDrag.a = a;
    setVolume(dialDrag.acc);
  });
  function endDial(event: PointerEvent) {
    if (!dialDrag) return;
    const { start } = dialDrag;
    dialDrag = null;
    dial.classList.remove("is-held");
    volume.dispatchEvent(new Event(event.type === "pointerup" ? "pointerup" : "pointercancel"));
    if (event.type === "pointerup" && Number(volume.value) !== start) volume.dispatchEvent(new Event("change", { bubbles: true }));
  }
  dial.addEventListener("pointerup", endDial);
  dial.addEventListener("pointercancel", endDial);
  // A wheel sends one command once it settles, not one per notch.
  dial.addEventListener("wheel", (event) => {
    event.preventDefault();
    if (volume.disabled) return;
    setVolume(Number(volume.value) - Math.sign(event.deltaY) * 3);
    clearTimeout(wheelTimer);
    wheelTimer = window.setTimeout(() => volume.dispatchEvent(new Event("change", { bubbles: true })), 350);
  }, { passive: false });

  function dialFrame() {
    dial.classList.toggle("is-off", volume.disabled && !dialDrag);
    const value = Number(volume.value);
    if (value === shownVolume) return;
    shownVolume = value;
    dial.style.setProperty("--v", String(value));
  }

  // ------------------------------------------------------- skip feedback

  let lastSkip = { dir: 1, at: -Infinity };
  function spillAt(button: HTMLElement) {
    const face = button.closest(".face");
    const spill = face?.querySelector(".spill");
    if (face && spill) {
      const f = face.getBoundingClientRect();
      const b = button.getBoundingClientRect();
      if (f.width) {
        (spill as HTMLElement).style.setProperty("--sx", `${((b.left + b.width / 2 - f.left) / f.width) * 100}%`);
        (spill as HTMLElement).style.setProperty("--sy", `${((b.top + b.height / 2 - f.top) / f.height) * 100}%`);
      }
      retrigger(spill, "on");
    }
    retrigger(button, "hit");
  }
  for (const [id, dir] of [["previous", -1], ["next", 1]] as const) {
    byId(id).addEventListener("click", (event) => {
      spillAt(event.currentTarget as HTMLElement);
      lastSkip = { dir, at: performance.now() };
      thump(0.7, dir);
    });
  }

  // ------------------------------------------------------- tool faces

  // Each tool is a stand-in for a real control elsewhere in the window: a press
  // clicks that control, and the tool mirrors its state. One marked
  // data-follow-hidden also disappears with its control (a player without
  // shuffle), and data-mode carries a control's state beyond on and off.
  const tools = [...cube.querySelectorAll<HTMLButtonElement>(".tool")].map((tool) => ({
    tool,
    target: byId<HTMLInputElement | HTMLButtonElement>(tool.dataset.proxy!),
  }));
  for (const { tool, target } of tools) {
    tool.addEventListener("click", () => {
      if (target.disabled) {
        refuse();
        return;
      }
      target.click();
      thump(0.4, 0);
    });
  }
  function toolsFrame() {
    for (const { tool, target } of tools) {
      tool.disabled = target.disabled;
      if (tool.hasAttribute("data-follow-hidden")) tool.hidden = target.hidden;
      const mode = target.dataset.mode;
      if (mode !== undefined && tool.dataset.mode !== mode) tool.dataset.mode = mode;
      let pressed: string | null = null;
      if (target instanceof HTMLInputElement) {
        pressed = String(target.checked);
      } else if (target.hasAttribute("aria-pressed")) {
        pressed = target.getAttribute("aria-pressed");
      }
      // A plain switch (the way back to full mode) is never "pressed".
      if (tool.hasAttribute("data-plain")) pressed = null;
      if (pressed !== null && tool.getAttribute("aria-pressed") !== pressed) tool.setAttribute("aria-pressed", pressed);
      if (pressed === null) tool.removeAttribute("aria-pressed");
    }
  }

  // ------------------------------------------------------- shards

  const SHARD_COLORS = ["var(--accent)", "var(--accent)", "#f1f1ec", "#3c3c3a", "#000"];
  function burst(x: number, y: number, count: number) {
    if (calm() || typeof shardLayer.animate !== "function") return;
    for (let i = 0; i < count; i++) {
      const shard = document.createElement("i");
      const size = 5 + Math.random() * 12;
      shard.style.setProperty("--z", `${size}px`);
      shard.style.background = SHARD_COLORS[Math.floor(Math.random() * SHARD_COLORS.length)];
      shardLayer.append(shard);
      // Sample a short ballistic flight into keyframes.
      let px = x, py = y, vx = (Math.random() * 2 - 0.55) * 9, vy = (Math.random() * -1.2 - 0.1) * 8, r = Math.random() * 180;
      const vr = (Math.random() - 0.5) * 24;
      const frames: Keyframe[] = [];
      for (let f = 0; f <= 10; f++) {
        frames.push({ transform: `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) rotate(${r.toFixed(0)}deg)`, opacity: f < 6 ? 1 : 1 - (f - 6) / 4 });
        for (let s = 0; s < 6; s++) {
          vy += 0.32;
          vx *= 0.975;
          px += vx;
          py += vy;
          r += vr / 6;
        }
      }
      const flight = shard.animate(frames, { duration: 1100, easing: "linear" });
      flight.onfinish = () => shard.remove();
    }
  }
  function lineChanged(line: HTMLElement) {
    if (shardLayer.hidden) return;
    const zone = shardLayer.getBoundingClientRect();
    const box = line.getBoundingClientRect();
    if (!zone.width) return;
    burst(box.left - zone.left + 40, box.top - zone.top + box.height / 2, 12);
  }

  // ------------------------------------------------------- background

  window.addEventListener("pointermove", (event) => {
    parX.target = (event.clientX / innerWidth - 0.5) * -40;
    parY.target = (event.clientY / innerHeight - 0.5) * -24;
  }, { passive: true });

  // ------------------------------------------------------- frame

  function tick(now: number) {
    const dt = last ? Math.min(64, now - last) : 16;
    last = now;
    if (!drag) {
      rx.step(dt);
      ry.step(dt);
    }
    lift.step(dt);
    squash.step(dt);
    const still = drag || calm();
    const t = now / 1000;
    const bob = still ? 0 : Math.sin(t * 1.3) * BOB;
    sway = still ? 0 : Math.sin(t * 0.7) * SWAY;
    const sy = squash.value;
    const sxz = 1 + (1 - sy) * 0.55;
    cube.style.transform = `translate3d(0, ${(lift.value + bob).toFixed(2)}px, 0) rotateX(${rx.value.toFixed(2)}deg) rotateY(${(ry.value + sway).toFixed(2)}deg) scale3d(${sxz.toFixed(3)}, ${sy.toFixed(3)}, ${sxz.toFixed(3)})`;
    lightFaces();
    coverFrame(dt, now);
    shadow.style.transform = `translateX(-50%) scale(${(1 + (lift.value + bob) * 0.004).toFixed(3)})`;
    glowLevel += (0.22 - glowLevel) * Math.min(1, dt / 260);
    glow.style.setProperty("--go", glowLevel.toFixed(3));
    glow.style.setProperty("--gs", (0.8 + glowLevel * 0.5).toFixed(3));
    // Fold whole turns back so the angle never grows without bound.
    if (!drag && Math.abs(ry.velocity) < 2 && Math.abs(ry.value - ry.target) < 0.5 && Math.abs(ry.target) > 300) {
      const turns = Math.round(ry.target / 360) * 360;
      ry.value -= turns;
      ry.target -= turns;
    }

    motor.step(dt);
    if (!scratch) discAngle += dt * (360 / 1800) * motor.value;
    disc.style.transform = `rotate(${discAngle.toFixed(2)}deg)`;

    dialFrame();
    toolsFrame();

    parX.step(dt);
    parY.step(dt);
    bgWord.style.setProperty("--px", `${parX.value.toFixed(1)}px`);
    bgWord.style.setProperty("--py", `${parY.value.toFixed(1)}px`);
  }

  return {
    tick,
    setCover(url) {
      if (performance.now() - spinStarted < 1500) pendingCover = { url, since: performance.now() };
      else applyCover(url);
    },
    setPlaying,
    trackChanged() {
      const dir = performance.now() - lastSkip.at < 4000 ? lastSkip.dir : 1;
      spinStarted = performance.now();
      ry.target += 360 * dir;
      retrigger(document.body, "shake");
      retrigger(byId("track-name"), "slam");
    },
    lineChanged,
    setTitle(text) {
      bgWord.textContent = text;
    },
    turnTo,
    setLayout,
    pose: () => ({ tilt: rx.value, yaw: ry.value + sway }),
  };
}
