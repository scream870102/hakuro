/**
 * Command palette (Ctrl+K). It lives in a window of its own, so the main
 * window hands it a snapshot of plain data — every command's current label,
 * state and availability, and the song's timed lines — and gets back which one
 * was picked. The commands themselves stay closures in main.ts, which mostly
 * click the control that already does the job; typing also searches the
 * current song's lyrics so a line can be jumped to by its words.
 *
 * Text from lyrics providers is untrusted, so everything is built as DOM nodes,
 * never as HTML strings.
 */

type Value = string | (() => string);

/** A command as main.ts defines it, live against its own state. */
export interface Command {
  group: string;
  icon: Value;
  label: Value;
  /** Secondary text: the Chinese name, or a detail such as the version. */
  hint?: Value;
  /** Extra words that should find the command. */
  words?: string;
  state?: () => { text: string; on: boolean } | null;
  /** Shown but not runnable while this is false (no track, no seeking...). */
  enabled?: () => boolean;
  /** Left out of the list entirely while this is false. */
  visible?: () => boolean;
  run: () => void;
}

/** A command as the palette window sees it: read once, as it stood on opening. */
export interface PaletteCommand {
  /** Its index in main.ts's command list, sent back when it is picked. */
  id: number;
  group: string;
  icon: string;
  label: string;
  hint: string;
  words: string;
  state: { text: string; on: boolean } | null;
  enabled: boolean;
}

export interface PaletteLine {
  /** The cue's index in the song's lyrics. */
  index: number;
  text: string;
  translation: string;
  time: string;
}

export interface PaletteSnapshot {
  commands: PaletteCommand[];
  /** Timed lines only: an untimed line has nowhere to jump to. */
  lines: PaletteLine[];
  title: string;
  /** The song the lines belong to, so a jump can never land in the next one. */
  trackKey: string;
  accent?: string;
}

export type PaletteAction = { command: number } | { line: number; trackKey: string };

/** Main → palette: draw this snapshot and take the focus. */
export const PALETTE_SHOW = "palette:show";
/** Palette → main: run this, then take the focus back. */
export const PALETTE_RUN = "palette:run";
/** Palette → main: closed by the keyboard or a click, so hand the focus back. */
export const PALETTE_CLOSED = "palette:closed";
/** Palette → main: the page has loaded and is listening. */
export const PALETTE_READY = "palette:ready";

const read = (value: Value | undefined) => (typeof value === "function" ? value() : value ?? "");

export function describeCommands(commands: Command[]): PaletteCommand[] {
  return commands.flatMap((command, id) => (command.visible?.() ?? true) ? [{
    id,
    group: command.group,
    icon: read(command.icon),
    label: read(command.label),
    hint: read(command.hint),
    words: command.words ?? "",
    state: command.state?.() ?? null,
    enabled: command.enabled?.() ?? true,
  }] : []);
}

export interface Palette {
  show(snapshot: PaletteSnapshot): void;
  /** Put the caret back in the field, once the window itself has the focus. */
  focus(): void;
  setVersion(version: string): void;
}

interface Item {
  icon: string;
  label: string;
  match: Match | null;
  hint: string;
  state: { text: string; on: boolean } | null;
  keys: string[];
  enabled: boolean;
  action: PaletteAction;
}

interface Match {
  score: number;
  range?: [number, number];
  picks?: number[];
}

function matchCommand(command: PaletteCommand, query: string): Match | null {
  const label = command.label.toLowerCase();
  const at = label.indexOf(query);
  if (at >= 0) return { score: 300 - at + (at === 0 || label[at - 1] === " " ? 40 : 0), range: [at, at + query.length] };
  if (`${command.hint} ${command.words}`.toLowerCase().includes(query)) return { score: 150 };
  // Letters in order, anywhere: "cmp" finds "Compact mode".
  const picks: number[] = [];
  for (let k = 0, j = 0; k < label.length && j < query.length; k++) {
    if (label[k] === query[j]) {
      picks.push(k);
      j++;
    }
  }
  if (picks.length === query.length) return { score: 60 - (picks[picks.length - 1] - picks[0]), picks };
  return null;
}

/** The label as text nodes, with the matched part wrapped in <mark>. */
function marked(text: string, match: Match | null): Node[] {
  const mark = (part: string) => {
    const el = document.createElement("mark");
    el.textContent = part;
    return el;
  };
  if (match?.range) {
    const [a, b] = match.range;
    return [document.createTextNode(text.slice(0, a)), mark(text.slice(a, b)), document.createTextNode(text.slice(b))];
  }
  if (match?.picks) {
    const picked = new Set(match.picks);
    return [...text].map((ch, k) => (picked.has(k) ? mark(ch) : document.createTextNode(ch)));
  }
  return [document.createTextNode(text)];
}

function retrigger(el: Element, name: string) {
  el.classList.remove(name);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(name);
}

const MAX_LYRIC_HITS = 8;

export function createPalette(options: {
  run(action: PaletteAction): void;
  /** Escape, Ctrl+K again, or a click beside the palette. */
  dismiss(): void;
}): Palette {
  const box = document.getElementById("palette") as HTMLElement;
  const input = document.getElementById("pal-input") as HTMLInputElement;
  const list = document.getElementById("pal-list") as HTMLElement;
  const version = document.getElementById("pal-version") as HTMLElement;
  let snapshot: PaletteSnapshot = { commands: [], lines: [], title: "", trackKey: "" };
  let items: Item[] = [];
  let selected = 0;
  let bar: HTMLElement | null = null;

  function render() {
    const query = input.value.trim().toLowerCase();
    const rows: (Item | string)[] = [];
    items = [];
    const add = (item: Item) => {
      rows.push(item);
      items.push(item);
    };
    const fromCommand = (command: PaletteCommand, match: Match | null): Item => ({
      icon: command.icon,
      label: command.label,
      match,
      hint: command.hint,
      state: command.state,
      keys: [],
      enabled: command.enabled,
      action: { command: command.id },
    });
    if (!query) {
      let group = "";
      for (const command of snapshot.commands) {
        if (command.group !== group) rows.push((group = command.group));
        add(fromCommand(command, null));
      }
    } else {
      const hits = snapshot.commands
        .map((command) => ({ command, match: matchCommand(command, query) }))
        .filter((hit): hit is { command: PaletteCommand; match: Match } => hit.match !== null)
        .sort((a, b) => b.match.score - a.match.score);
      if (hits.length) rows.push("COMMANDS");
      hits.forEach(({ command, match }) => add(fromCommand(command, match)));
      const lines = snapshot.lines
        .filter((line) => line.text.toLowerCase().includes(query) || line.translation.toLowerCase().includes(query))
        .slice(0, MAX_LYRIC_HITS);
      if (lines.length) rows.push(`JUMP TO LYRIC · ${snapshot.title}`);
      for (const line of lines) {
        const at = line.text.toLowerCase().indexOf(query);
        add({
          icon: String(line.index + 1).padStart(2, "0"),
          label: line.text,
          match: at >= 0 ? { score: 0, range: [at, at + query.length] } : null,
          hint: line.translation,
          state: null,
          keys: line.time ? [line.time] : [],
          enabled: true,
          action: { line: line.index, trackKey: snapshot.trackKey },
        });
      }
    }

    bar = document.createElement("div");
    bar.className = "pal__bar";
    const nodes: Node[] = [bar];
    rows.forEach((row) => {
      if (typeof row === "string") {
        const head = document.createElement("div");
        head.className = "pal__group";
        head.textContent = row;
        nodes.push(head);
        return;
      }
      const el = document.createElement("div");
      el.className = row.enabled ? "pal__item" : "pal__item is-off";
      el.dataset.index = String(items.indexOf(row));
      el.setAttribute("role", "option");
      if (!row.enabled) el.setAttribute("aria-disabled", "true");
      const icon = document.createElement("i");
      icon.textContent = row.icon;
      const label = document.createElement("span");
      label.className = "pal__label";
      label.append(...marked(row.label, row.match));
      if (row.hint) {
        const hint = document.createElement("small");
        hint.textContent = row.hint;
        label.append(hint);
      }
      const meta = document.createElement("span");
      meta.className = "pal__meta";
      if (row.state) {
        const state = document.createElement("span");
        state.className = row.state.on ? "pal__state on" : "pal__state";
        state.textContent = row.state.text;
        meta.append(state);
      }
      for (const key of row.keys) {
        const kbd = document.createElement("kbd");
        kbd.textContent = key;
        meta.append(kbd);
      }
      el.append(icon, label, meta);
      nodes.push(el);
    });
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "pal__empty";
      empty.textContent = "NO MATCH — TRY “PLAY”, “COMPACT” OR A LYRIC";
      nodes.push(empty);
    }
    list.replaceChildren(...nodes);
    select(0, true);
  }

  function select(index: number, snap = false) {
    if (!bar) return;
    bar.hidden = !items.length;
    if (!items.length) return;
    selected = (index + items.length) % items.length;
    let current: HTMLElement | null = null;
    list.querySelectorAll<HTMLElement>(".pal__item").forEach((el) => {
      const on = Number(el.dataset.index) === selected;
      el.classList.toggle("is-sel", on);
      el.setAttribute("aria-selected", String(on));
      if (on) current = el;
    });
    const row = current as HTMLElement | null;
    if (!row) return;
    bar.classList.toggle("snap", snap);
    bar.style.height = `${row.offsetHeight}px`;
    bar.style.setProperty("--y", `${row.offsetTop}px`);
    row.scrollIntoView?.({ block: "nearest" });
  }

  function runSelected() {
    const item = items[selected];
    if (!item) return;
    if (!item.enabled) {
      if (bar) retrigger(bar, "deny");
      return;
    }
    if (bar) retrigger(bar, "fire");
    options.run(item.action);
  }

  input.addEventListener("input", render);
  input.addEventListener("keydown", (event) => {
    // An IME is still composing: Enter confirms the characters, not a command.
    if (event.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      select(selected + (event.key === "ArrowDown" ? 1 : -1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runSelected();
    }
  });
  list.addEventListener("pointermove", (event) => {
    const row = (event.target as Element).closest<HTMLElement>(".pal__item");
    if (row && Number(row.dataset.index) !== selected) select(Number(row.dataset.index));
  });
  list.addEventListener("click", (event) => {
    const row = (event.target as Element).closest<HTMLElement>(".pal__item");
    if (!row) return;
    select(Number(row.dataset.index));
    runSelected();
  });
  window.addEventListener("keydown", (event) => {
    if (event.isComposing) return;
    const chord = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k";
    if (event.key === "Escape" || chord) {
      event.preventDefault();
      options.dismiss();
    }
  });
  // The margin around the box stands in for a backdrop. Both the press and the
  // release have to land there, so a drag that overshoots the edge is harmless.
  let pressedOutside = false;
  const outside = (event: Event) => !box.contains(event.target as Node);
  document.addEventListener("pointerdown", (event) => { pressedOutside = outside(event); });
  document.addEventListener("click", (event) => {
    const away = pressedOutside && outside(event);
    pressedOutside = false;
    if (away) options.dismiss();
  });

  return {
    show(next) {
      snapshot = next;
      input.value = "";
      render();
      retrigger(box, "is-in");
      input.focus();
    },
    focus: () => input.focus(),
    setVersion(value) {
      version.textContent = `HAKURO v${value}`;
    },
  };
}
