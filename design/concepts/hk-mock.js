/* Hakuro UI concepts — shared mock playback.
   A classic script (not a module) so every concept also opens straight from file://.
   It stands in for the Tauri side: two tracks with synced, word-timed lyrics and
   provider translations, a playback clock, volume, compact mode and UI sounds. */
(function () {
  "use strict";

  const TRACK_DEFS = [
    {
      id: "signal",
      title: "白露のシグナル",
      artist: "KAGEROU SYSTEM",
      album: "MONOCHROME RUSH",
      source: "NetEase",
      bpm: 128,
      palette: ["#ff2e88", "#ff8a00", "#2b1055", "#ffe14d"],
      intro: 3200,
      outro: 4200,
      lines: [
        ["夜明け前の|ノイズを|抱いて", "抱緊黎明前的雜訊", 3750],
        ["白い|息が|街を|染める", "白色的氣息染遍街道", 3750],
        ["止まらない|鼓動|ひとつ", "一個停不下來的心跳", 3750],
        ["黄色い|信号|走り出せ", "黃色的號誌，奔跑吧", 3750],
        ["影を|蹴って|跳び越えて", "踢開影子，一躍而過", 3750],
        ["誰も|知らない|空まで", "直到無人知曉的天空", 3750],
        ["ガラスの|夢が|砕けても", "即使玻璃的夢碎了", 3750],
        ["この|声だけは|消えない", "只有這聲音不會消失", 3750],
        ["♪", "", 7500],
        ["白露の|朝に|光る", "在白露的早晨閃耀", 3750],
        ["ひとしずくの|約束", "一滴般的約定", 3750],
        ["線を|越えて|色を|塗れ", "越過界線，塗上顏色", 3750],
        ["黒と|白の|間で", "在黑與白之間", 3750],
        ["叫べ|もっと|高く", "再大聲地吶喊", 3750],
        ["世界が|ふるえる|まで", "直到世界顫抖", 3750],
        ["夜明けは|もう|ここに", "黎明已經在這裡", 3750],
      ],
    },
    {
      id: "satellite",
      title: "Paper Satellite",
      artist: "Lumen Drive",
      album: "Static Bloom",
      source: "LRCLIB",
      bpm: 96,
      palette: ["#00c2b8", "#1b2a6b", "#f6f1e7", "#ff6b4a"],
      intro: 3000,
      outro: 4000,
      lines: [
        ["Paper satellite folded in my hand", "紙做的衛星，摺在我手心", 4000],
        ["Throw it at the static, see where it will land", "把它丟進雜訊，看它落在哪裡", 4000],
        ["Every little signal that I never sent", "每一個我從未送出的訊號", 4000],
        ["Circles in the orbit of the words I meant", "都繞著我想說的話運行", 4000],
        ["♪", "", 6000],
        ["Turn the volume up until the windows shake", "把音量轉大，直到窗戶震動", 4000],
        ["Count the seconds backward till the morning breaks", "倒數秒數，直到天亮", 4000],
        ["If the sky is listening, let it hear me now", "如果天空在聽，就讓它聽見我", 4000],
        ["Paper satellite, I'm coming down", "紙衛星，我正在降落", 4000],
        ["Black and white and burning bright", "黑與白，燃燒得耀眼", 4000],
        ["One more lap around the night", "再繞夜晚一圈", 4000],
        ["Paper satellite, hold on tight", "紙衛星，抓緊了", 4000],
      ],
    },
  ];

  // Word timing: each line sings for 82% of its slot, split by character weight.
  function build(def) {
    let t = def.intro;
    const lines = def.lines.map(([raw, tr, dur]) => {
      const instrumental = raw === "♪";
      const parts = raw.includes("|") ? raw.split("|") : raw.split(/(?<= )/);
      const weights = parts.map((p) => Math.max(1, p.trim().length));
      const total = weights.reduce((a, b) => a + b, 0);
      const singable = dur * 0.82;
      let wt = t;
      const words = instrumental
        ? []
        : parts.map((text, i) => {
            const d = (singable * weights[i]) / total;
            const word = { t: wt, d, text };
            wt += d;
            return word;
          });
      const line = { t, d: dur, text: parts.join(""), words, tr, instrumental };
      t += dur;
      return line;
    });
    return { ...def, lines, duration: t + def.outro };
  }

  const tracks = TRACK_DEFS.map(build);
  const SOURCES = ["NetEase", "LRCLIB", "Musixmatch", "PetitLyrics", "QQ Music"];

  /* ---------- events ---------- */

  const listeners = {};
  function on(type, fn) {
    (listeners[type] ||= []).push(fn);
    return () => (listeners[type] = listeners[type].filter((f) => f !== fn));
  }
  function emit(type, ...args) {
    for (const fn of listeners[type] || []) fn(...args);
  }

  /* ---------- clock ---------- */

  const state = {
    trackIndex: 0,
    playing: true,
    volume: 64,
    follow: true,
    pinned: false,
    compact: false,
    muted: readMuted(),
    source: tracks[0].source,
  };
  let basePos = 0;
  let baseTime = performance.now();
  let lastLine = -2;
  let lastBeat = -1;

  const track = () => tracks[state.trackIndex];
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function position() {
    const p = state.playing ? basePos + performance.now() - baseTime : basePos;
    return clamp(p, 0, track().duration);
  }

  function lineAt(pos, t = track()) {
    let idx = -1;
    for (let i = 0; i < t.lines.length; i++) {
      if (t.lines[i].t <= pos) idx = i;
      else break;
    }
    return idx;
  }

  const wordProgress = (word, pos) => clamp((pos - word.t) / word.d, 0, 1);

  // Fractional count of words sung: 2.4 means two words done, the third 40% in.
  function sungWords(line, pos) {
    if (!line || !line.words.length) return 0;
    let n = 0;
    for (const w of line.words) n += wordProgress(w, pos);
    return n;
  }

  function play() {
    if (state.playing) return;
    basePos = position();
    baseTime = performance.now();
    state.playing = true;
    emit("state", true);
  }
  function pause() {
    if (!state.playing) return;
    basePos = position();
    state.playing = false;
    emit("state", false);
  }
  function toggle() {
    state.playing ? pause() : play();
  }
  function seek(ms) {
    basePos = clamp(ms, 0, track().duration);
    baseTime = performance.now();
    emit("seek", basePos);
  }
  function setTrack(index, dir) {
    state.trackIndex = (index + tracks.length) % tracks.length;
    state.source = track().source;
    basePos = 0;
    baseTime = performance.now();
    lastLine = -2;
    lastBeat = -1;
    emit("track", track(), dir);
    emit("source", state.source);
  }
  const next = () => setTrack(state.trackIndex + 1, 1);
  function prev() {
    if (position() > 3000) seek(0);
    else setTrack(state.trackIndex - 1, -1);
  }
  function setVolume(v) {
    const next = Math.round(clamp(v, 0, 100));
    if (next === state.volume) return;
    state.volume = next;
    emit("volume", next);
  }
  function setFollow(v) {
    state.follow = v;
    emit("follow", v);
  }
  function setPinned(v) {
    state.pinned = v;
    emit("pin", v);
  }
  function cycleSource(dir = 1) {
    const i = SOURCES.indexOf(state.source);
    state.source = SOURCES[(i + dir + SOURCES.length) % SOURCES.length];
    emit("source", state.source);
  }
  function refreshLyrics() {
    lastLine = -2;
    emit("refresh", track());
  }

  let lastFrame = performance.now();
  function frame(now) {
    const dt = Math.min(64, now - lastFrame);
    lastFrame = now;
    const pos = position();
    const t = track();
    if (state.playing && pos >= t.duration) {
      next();
    } else {
      const li = lineAt(pos);
      if (li !== lastLine) {
        const prevLine = lastLine;
        lastLine = li;
        emit("line", li, prevLine);
      }
      if (state.playing) {
        const beat = Math.floor(pos / (60000 / t.bpm));
        if (beat !== lastBeat) {
          lastBeat = beat;
          emit("beat", beat, beat % 4 === 0);
        }
      }
    }
    emit("frame", pos, dt, now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /* ---------- album art (procedural stand-ins for real covers) ---------- */

  const artCache = {};
  function drawSignal(c, s) {
    const g = c.createLinearGradient(0, 0, s, s);
    g.addColorStop(0, "#2b1055");
    g.addColorStop(0.55, "#ff2e88");
    g.addColorStop(1, "#ff8a00");
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    c.fillStyle = "#ffe14d";
    c.beginPath();
    c.arc(s * 0.62, s * 0.38, s * 0.22, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "#ff3d7f";
    for (let i = 0; i < 6; i++) c.fillRect(s * 0.38, s * (0.4 + i * 0.04), s * 0.5, s * (0.006 + i * 0.004));
    c.save();
    c.translate(s / 2, s / 2);
    c.rotate(-0.35);
    c.fillStyle = "#14081c";
    c.fillRect(-s, s * 0.1, s * 2, s * 0.15);
    c.restore();
    c.fillStyle = "#fff";
    c.font = `900 ${s * 0.17}px "Noto Sans JP", "Yu Gothic UI", "Meiryo", sans-serif`;
    c.fillText("白露", s * 0.07, s * 0.9);
    c.font = `700 ${s * 0.032}px "Segoe UI", sans-serif`;
    c.fillText("KAGEROU SYSTEM — MONOCHROME RUSH", s * 0.075, s * 0.955);
  }
  function drawSatellite(c, s) {
    const g = c.createRadialGradient(s * 0.3, s * 0.3, 0, s * 0.5, s * 0.5, s * 0.8);
    g.addColorStop(0, "#00c2b8");
    g.addColorStop(0.6, "#1b2a6b");
    g.addColorStop(1, "#0b1030");
    c.fillStyle = g;
    c.fillRect(0, 0, s, s);
    c.strokeStyle = "rgba(246,241,231,.55)";
    c.lineWidth = s * 0.004;
    for (let i = 1; i < 6; i++) {
      c.beginPath();
      c.ellipse(s * 0.5, s * 0.52, s * 0.09 * i, s * 0.035 * i, -0.3, 0, Math.PI * 2);
      c.stroke();
    }
    c.fillStyle = "#ff6b4a";
    c.beginPath();
    c.arc(s * 0.5, s * 0.52, s * 0.07, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.translate(s * 0.74, s * 0.3);
    c.rotate(0.6);
    c.fillStyle = "#f6f1e7";
    c.fillRect(-s * 0.06, -s * 0.04, s * 0.12, s * 0.08);
    c.fillStyle = "#1b2a6b";
    c.fillRect(-s * 0.06, -s * 0.004, s * 0.12, s * 0.008);
    c.restore();
    c.fillStyle = "#f6f1e7";
    c.font = `800 ${s * 0.085}px "Segoe UI", sans-serif`;
    c.fillText("PAPER", s * 0.07, s * 0.85);
    c.fillText("SATELLITE", s * 0.07, s * 0.93);
  }
  function artCanvas(t = track(), size = 512) {
    const key = t.id + size;
    if (artCache[key]) return artCache[key];
    const cv = document.createElement("canvas");
    cv.width = cv.height = size;
    const c = cv.getContext("2d");
    (t.id === "signal" ? drawSignal : drawSatellite)(c, size);
    return (artCache[key] = cv);
  }
  const artURL = (t = track(), size = 512) => artCanvas(t, size).toDataURL("image/png");

  /* ---------- UI sounds (synthesised, no assets) ---------- */

  let actx, master;
  function audio() {
    if (!actx) {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const comp = actx.createDynamicsCompressor();
      master = actx.createGain();
      master.gain.value = 0.55;
      master.connect(comp).connect(actx.destination);
    }
    if (actx.state === "suspended") actx.resume();
    return actx;
  }
  function tone({ type = "sine", f0, f1 = f0, dur, gain = 0.2, delay = 0 }) {
    const a = audio();
    const t0 = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }
  let noiseBuf;
  function noise({ dur, gain = 0.2, f0 = 800, f1 = f0, q = 0.8, delay = 0 }) {
    const a = audio();
    if (!noiseBuf) {
      noiseBuf = a.createBuffer(1, a.sampleRate, a.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const t0 = a.currentTime + delay;
    const src = a.createBufferSource();
    src.buffer = noiseBuf;
    const f = a.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0);
    f.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const g = a.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.02);
  }
  const SOUNDS = {
    tick: () => tone({ type: "triangle", f0: 2600, f1: 2000, dur: 0.025, gain: 0.035 }),
    click: () => tone({ type: "square", f0: 900, f1: 320, dur: 0.05, gain: 0.06 }),
    thunk: () => {
      tone({ type: "sine", f0: 170, f1: 48, dur: 0.2, gain: 0.55 });
      noise({ dur: 0.07, gain: 0.18, f0: 2400, f1: 500 });
    },
    snap: () => {
      tone({ type: "square", f0: 1500, f1: 700, dur: 0.025, gain: 0.05 });
      tone({ type: "sine", f0: 520, f1: 240, dur: 0.09, gain: 0.2, delay: 0.015 });
    },
    whoosh: () => noise({ dur: 0.5, gain: 0.3, f0: 260, f1: 3200, q: 1.1 }),
    pop: () => tone({ type: "sine", f0: 520, f1: 1300, dur: 0.1, gain: 0.16 }),
    drop: () => {
      tone({ type: "sine", f0: 1200, f1: 380, dur: 0.16, gain: 0.18 });
      tone({ type: "sine", f0: 240, f1: 90, dur: 0.25, gain: 0.25, delay: 0.02 });
    },
    blip: (v = 50) => tone({ type: "triangle", f0: 300 + v * 9, dur: 0.04, gain: 0.05 }),
    scratch: (speed = 1) =>
      noise({ dur: 0.06, gain: Math.min(0.25, 0.05 + Math.abs(speed) * 0.04), f0: 400 + Math.abs(speed) * 900, f1: 300, q: 2 }),
    impact: () => {
      tone({ type: "sine", f0: 120, f1: 35, dur: 0.35, gain: 0.7 });
      noise({ dur: 0.18, gain: 0.3, f0: 1800, f1: 200, q: 0.6 });
    },
  };
  function sfx(name, arg) {
    // Browsers refuse audio before the first gesture; stay silent instead of warning.
    if (state.muted || !SOUNDS[name] || (navigator.userActivation && !navigator.userActivation.hasBeenActive)) return;
    try {
      SOUNDS[name](arg);
    } catch (_) {
      /* audio is decoration only */
    }
  }
  function readMuted() {
    try {
      return localStorage.getItem("hk-concepts-muted") === "1";
    } catch (_) {
      return false;
    }
  }
  function setMuted(v, fromParent) {
    state.muted = v;
    try {
      localStorage.setItem("hk-concepts-muted", v ? "1" : "0");
    } catch (_) {}
    emit("muted", v);
    if (!fromParent && window.parent !== window) window.parent.postMessage({ hk: "mute", value: v }, "*");
  }

  /* ---------- compact mode + gallery bridge ---------- */

  function setCompact(v, fromParent) {
    state.compact = v;
    document.body.classList.toggle("is-compact", v);
    emit("compact", v);
    if (!fromParent && window.parent !== window) window.parent.postMessage({ hk: "compact", value: v }, "*");
  }
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m.hk !== "string") return;
    if (m.hk === "compact") setCompact(Boolean(m.value), true);
    if (m.hk === "mute") setMuted(Boolean(m.value), true);
  });

  /* ---------- keyboard ---------- */

  function bindKeys() {
    window.addEventListener("keydown", (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key;
      if (k === " ") toggle();
      else if (k === "ArrowRight") seek(position() + 5000);
      else if (k === "ArrowLeft") seek(position() - 5000);
      else if (k === "ArrowUp") setVolume(state.volume + 5);
      else if (k === "ArrowDown") setVolume(state.volume - 5);
      else if (k === "n" || k === "N") next();
      else if (k === "p" || k === "P") prev();
      else if (k === "c" || k === "C") setCompact(!state.compact);
      else if (k === "m" || k === "M") setMuted(!state.muted);
      else return;
      e.preventDefault();
    });
  }

  /* ---------- helpers ---------- */

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  // Semi-implicit spring; good enough for UI wobble.
  class Spring {
    constructor(value = 0, stiffness = 180, damping = 18) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.k = stiffness;
      this.c = damping;
    }
    step(dtMs) {
      const dt = Math.min(0.05, dtMs / 1000);
      const f = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += f * dt;
      this.value += this.velocity * dt;
      return this.value;
    }
    kick(v) {
      this.velocity += v;
    }
    snap(v) {
      this.value = this.target = v;
      this.velocity = 0;
    }
  }

  const hexToRgb = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };

  window.HK = {
    tracks,
    SOURCES,
    state,
    track,
    position,
    lineAt,
    wordProgress,
    sungWords,
    play,
    pause,
    toggle,
    seek,
    next,
    prev,
    setVolume,
    setFollow,
    setPinned,
    cycleSource,
    refreshLyrics,
    setCompact,
    setMuted,
    on,
    emit,
    sfx,
    artCanvas,
    artURL,
    bindKeys,
    fmt,
    clamp,
    Spring,
    hexToRgb,
  };
})();
