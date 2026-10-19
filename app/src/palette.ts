/**
 * Command palette (Ctrl+K). Every command is a closure handed in by main.ts,
 * which mostly clicks the control that already does the job; typing also
 * searches the current song's lyrics so a line can be jumped to by its words.
 *
 * Text from lyrics providers is untrusted, so everything is built as DOM nodes,
 * never as HTML strings.
 */

type Value = string | (() => string);

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

export interface LyricHit {
  number: number;
  text: string;
  translation: string;
  time: string;
  run: () => void;
}

export interface Palette {
  open(): void;
  close(): void;
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
  run: () => void;
}

interface Match {
  score: number;
  range?: [number, number];
  picks?: number[];
}

const read = (value: Value | undefined) => (typeof value === "function" ? value() : value ?? "");

function matchCommand(command: Command, query: string): Match | null {
  const label = read(command.label).toLowerCase();
  const at = label.indexOf(query);
  if (at >= 0) return { score: 300 - at + (at === 0 || label[at - 1] === " " ? 40 : 0), range: [at, at + query.length] };
  if (`${read(command.hint)} ${command.words ?? ""}`.toLowerCase().includes(query)) return { score: 150 };
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

export function createPalette(options: {
  commands: Command[];
  lyrics(query: string): LyricHit[];
  lyricsTitle(): string;
}): Palette {
  const dialog = document.getElementById("palette") as HTMLDialogElement;
  const input = document.getElementById("pal-input") as HTMLInputElement;
  const list = document.getElementById("pal-list") as HTMLElement;
  const version = document.getElementById("pal-version") as HTMLElement;
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
    const fromCommand = (command: Command, match: Match | null): Item => ({
      icon: read(command.icon),
      label: read(command.label),
      match,
      hint: read(command.hint),
      state: command.state?.() ?? null,
      keys: [],
      enabled: command.enabled?.() ?? true,
      run: command.run,
    });
    const shown = options.commands.filter((command) => command.visible?.() ?? true);
    if (!query) {
      let group = "";
      for (const command of shown) {
        if (command.group !== group) rows.push((group = command.group));
        add(fromCommand(command, null));
      }
    } else {
      const hits = shown
        .map((command) => ({ command, match: matchCommand(command, query) }))
        .filter((hit): hit is { command: Command; match: Match } => hit.match !== null)
        .sort((a, b) => b.match.score - a.match.score);
      if (hits.length) rows.push("COMMANDS");
      hits.forEach(({ command, match }) => add(fromCommand(command, match)));
      const lines = options.lyrics(query);
      if (lines.length) rows.push(`JUMP TO LYRIC · ${options.lyricsTitle()}`);
      for (const line of lines) {
        const at = line.text.toLowerCase().indexOf(query);
        add({
          icon: String(line.number).padStart(2, "0"),
          label: line.text,
          match: at >= 0 ? { score: 0, range: [at, at + query.length] } : null,
          hint: line.translation,
          state: null,
          keys: line.time ? [line.time] : [],
          enabled: true,
          run: line.run,
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
    // Close first: a command may open a dialog of its own.
    dialog.close();
    item.run();
  }

  function open() {
    if (dialog.open) {
      dialog.close();
      return;
    }
    // One modal at a time; Ctrl+K over the settings panel does nothing.
    if (document.querySelector("dialog[open]")) return;
    input.value = "";
    dialog.showModal();
    render();
    input.focus();
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
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "k") {
      event.preventDefault();
      open();
    }
  });

  return {
    open,
    close: () => dialog.close(),
    setVersion(value) {
      version.textContent = `HAKURO v${value}`;
    },
  };
}
