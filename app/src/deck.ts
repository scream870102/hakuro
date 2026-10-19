/**
 * The cube deck: the controls live on an object you can grab and turn. The
 * album cover is the front (tap it to play or pause; its colour is the play
 * state), volume and skip are on the right, the record is on top, and lyric
 * and window tools are round the back.
 *
 * Nothing here talks to the backend. Every gesture ends as a click on one of the
 * real controls, or as input/change on the volume range, so main.ts keeps one
 * code path for each command and the tests keep exercising it.
 */

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
const FACE_TURN: Record<CubeFace, number> = { front: 0, right: -90, back: 180, left: 90 };
/** One full turn of the record moves playback this far. */
const SCRATCH_MS_PER_TURN = 10_000;
/** A press that travels less than this is a tap, not a drag. */
const TAP_SLOP = 6;
const HINT_KEY = "hakuro.cube-hint-seen";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const wrapAngle = (d: number) => (d > Math.PI ? d - 2 * Math.PI : d < -Math.PI ? d + 2 * Math.PI : d);

/** Restart a CSS animation that is keyed to a class. */
function retrigger(el: Element, name: string) {
  el.classList.remove(name);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(name);
}

export function createDeck(options: { seekBy(ms: number): void }): Deck {
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const scene = byId("scene");
  const cube = byId("cube");
  const faces = [...cube.querySelectorAll<HTMLElement>(".face")];
  const front = byId("cover-face");
  const coverBase = byId<HTMLImageElement>("album-art");
  const coverPeek = byId<HTMLImageElement>("cover-peek");
  const discArt = byId<HTMLImageElement>("disc-art");
  const playPause = byId<HTMLButtonElement>("play-pause");
  const dial = byId("volume-control");
  const volume = byId<HTMLInputElement>("volume");
  const vinyl = byId("vinyl");
  const disc = byId("disc");
  const shadow = byId("shadow");
  const glow = byId("glow");
  const hint = byId("cube-hint");
  const bgWord = byId("bg-word");
  const shardLayer = byId("shards");

  const motion = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
  const calm = () => motion?.matches ?? false;

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

  /** offsetX/Y are in the target's own (3D-transformed) space; climb to the face. */
  function aimLens(event: PointerEvent) {
    let el = event.target instanceof HTMLElement ? event.target : null;
    if (!el || !front.offsetWidth) return;
    let x = event.offsetX;
    let y = event.offsetY;
    for (; el && el !== front; el = el.offsetParent as HTMLElement | null) {
      x += el.offsetLeft;
      y += el.offsetTop;
    }
    lx.target = (x / front.offsetWidth) * 100;
    ly.target = (y / front.offsetHeight) * 100;
    if (lens.value < 0.02) {
      lx.snap(lx.target);
      ly.snap(ly.target);
    }
  }
  front.addEventListener("pointerenter", () => { lensOn = true; });
  front.addEventListener("pointerleave", () => { lensOn = false; });
  front.addEventListener("pointermove", aimLens);
  front.addEventListener("pointerdown", (event) => {
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
    x: number; y: number; rx: number; ry: number; t: number; vel: number; moved: number; cover: boolean;
  } | null = null;

  function hideHint() {
    if (hint.classList.contains("gone")) return;
    hint.classList.add("gone");
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* private window: the hint just comes back */ }
  }
  try { if (localStorage.getItem(HINT_KEY)) hint.classList.add("gone"); } catch { /* keep the hint */ }

  scene.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || (event.target as Element).closest("button, input, .vinyl, .dial")) return;
    drag = {
      x: event.clientX, y: event.clientY, rx: rx.value, ry: ry.value, t: performance.now(), vel: 0, moved: 0,
      cover: Boolean((event.target as Element).closest(".face--front")),
    };
    scene.setPointerCapture?.(event.pointerId);
    scene.classList.add("is-dragging");
  });
  scene.addEventListener("pointermove", (event) => {
    if (!drag) return;
    drag.moved = Math.max(drag.moved, Math.hypot(event.clientX - drag.x, event.clientY - drag.y));
    if (drag.moved > TAP_SLOP) hideHint();
    const nextY = drag.ry + (event.clientX - drag.x) * 0.55;
    const nextX = clamp(drag.rx - (event.clientY - drag.y) * 0.4, -78, 18);
    const now = performance.now();
    drag.vel = drag.vel * 0.6 + ((nextY - ry.value) / Math.max(1, now - drag.t)) * 1000 * 0.4;
    drag.t = now;
    ry.value = ry.target = nextY;
    rx.value = rx.target = nextX;
  });
  function endDrag(event: PointerEvent) {
    if (!drag) return;
    const tap = drag.cover && drag.moved < TAP_SLOP && event.type === "pointerup";
    ry.velocity = drag.vel * 0.5;
    const projected = ry.value + drag.vel * 0.12;
    ry.target = REST_Y + Math.round((projected - REST_Y) / 90) * 90;
    rx.target = REST_X;
    rx.velocity = 0;
    drag = null;
    scene.classList.remove("is-dragging");
    if (tap) togglePlayback();
  }
  scene.addEventListener("pointerup", endDrag);
  scene.addEventListener("pointercancel", endDrag);

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
    const base = REST_Y + FACE_TURN[face];
    ry.target = base + Math.round((ry.value - base) / 360) * 360;
    rx.target = REST_X;
    thump(0.5, 0);
  }

  // ------------------------------------------------ the record on top

  let discAngle = 0;
  let scratch: { cx: number; cy: number; a: number; moved: number; turned: number } | null = null;
  const angleOf = (event: PointerEvent, centre: { cx: number; cy: number }) =>
    Math.atan2(event.clientY - centre.cy, event.clientX - centre.cx);

  vinyl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    const box = vinyl.getBoundingClientRect();
    scratch = { cx: box.left + box.width / 2, cy: box.top + box.height / 2, a: 0, moved: 0, turned: 0 };
    scratch.a = angleOf(event, scratch);
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
  });
  function endScratch(event: PointerEvent) {
    if (!scratch) return;
    const { moved, turned } = scratch;
    scratch = null;
    vinyl.classList.remove("is-held");
    if (event.type !== "pointerup") return;
    // One seek for the whole gesture: the player is a network call away.
    if (moved < 0.08) togglePlayback();
    else if (Math.abs(turned) > 0.05) {
      options.seekBy(Math.round((turned / (2 * Math.PI)) * SCRATCH_MS_PER_TURN));
      thump(0.4, Math.sign(turned));
    }
  }
  vinyl.addEventListener("pointerup", endScratch);
  vinyl.addEventListener("pointercancel", endScratch);

  // ------------------------------------------------------- the volume dial

  // The dial drives the hidden range exactly as a drag on a native slider would:
  // pointerdown, input while moving, pointerup, then change only if it moved.
  let dialDrag: { cx: number; cy: number; a: number; acc: number; start: number } | null = null;
  let wheelTimer = 0;
  let shownVolume = -1;

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
  for (const id of ["bar-prev", "bar-next"]) {
    byId(id).addEventListener("click", (event) => retrigger(event.currentTarget as HTMLElement, "hit"));
  }

  // ------------------------------------------------------- tool faces

  // Each tool is a stand-in for a real control elsewhere in the window: a press
  // clicks that control, and the tool mirrors its state.
  const tools = [...cube.querySelectorAll<HTMLButtonElement>(".tool")].map((tool) => ({
    tool,
    target: byId<HTMLInputElement | HTMLButtonElement>(tool.dataset.proxy!),
    label: tool.querySelector("b"),
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
    for (const { tool, target, label } of tools) {
      tool.disabled = target.disabled;
      let pressed: string | null = null;
      if (target instanceof HTMLInputElement) {
        pressed = String(target.checked);
        if (label) label.textContent = target.checked ? "ON" : "OFF";
      } else if (target.hasAttribute("aria-pressed")) {
        pressed = target.getAttribute("aria-pressed");
      }
      if (pressed !== null && tool.getAttribute("aria-pressed") !== pressed) tool.setAttribute("aria-pressed", pressed);
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
    const bob = still ? 0 : Math.sin(t * 1.3) * 5;
    const sway = still ? 0 : Math.sin(t * 0.7) * 1.6;
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
  };
}
