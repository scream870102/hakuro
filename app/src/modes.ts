/**
 * Shuffle and repeat as the main window and the queue window both show them.
 * Spotify reports both and lets them be set; ytmdesktop2 can only toggle them
 * blind, so for it they arrive as null and both windows hide the buttons.
 */

import { invoke } from "@tauri-apps/api/core";

/** Spotify's own names: the whole album or playlist, or the one song. */
export type Repeat = "off" | "context" | "track";

export interface Modes {
  shuffle: boolean | null;
  repeat: Repeat | null;
  canShuffle: boolean;
  canRepeatContext: boolean;
  canRepeatTrack: boolean;
}

/** What the reader reads: Spotify's "context" is "all". */
export const REPEAT_NAMES: Record<Repeat, string> = { off: "off", context: "all", track: "one" };

const ORDER: Repeat[] = ["off", "context", "track"];

/**
 * The repeat state a press moves to: off, all, one, and round again, past any
 * the player will not take right now. Null when none of them is available.
 */
export function nextRepeat(modes: Modes): Repeat | null {
  if (modes.repeat === null) return null;
  const allowed = (repeat: Repeat) =>
    repeat === "off" || (repeat === "context" ? modes.canRepeatContext : modes.canRepeatTrack);
  const start = ORDER.indexOf(modes.repeat);
  for (let step = 1; step < ORDER.length; step++) {
    const candidate = ORDER[(start + step) % ORDER.length];
    if (allowed(candidate)) return candidate;
  }
  return null;
}

export const shuffleLabel = (on: boolean) => `Shuffle: ${on ? "on" : "off"}`;
export const repeatLabel = (repeat: Repeat) => `Repeat: ${REPEAT_NAMES[repeat]}`;

/** What a playback event says about them; older events say nothing. */
export interface ModeReport {
  shuffle?: boolean | null;
  repeat?: Repeat | null;
  canShuffle?: boolean;
  canRepeatContext?: boolean;
  canRepeatTrack?: boolean;
}

/** How long a press is trusted over the polls that follow it. */
const HOLD_MS = 2500;

/**
 * Shuffle and repeat as one window keeps them. They show what the player last
 * reported, but a press shows its result at once: the poll it wakes may still
 * carry the old state, so for a moment the press is trusted over the poll, and
 * taken back if the player refuses it. `done` hears the refusal, or null.
 */
export function createModes(render: (modes: Readonly<Modes>) => void, done: (error: string | null) => void) {
  const current: Modes = { shuffle: null, repeat: null, canShuffle: false, canRepeatContext: false, canRepeatTrack: false };
  let heldUntil = 0;

  async function change(patch: Partial<Modes>, command: string, args: Record<string, unknown>) {
    // Only what this press changed is taken back if it is refused.
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, current[key as keyof Modes]]));
    Object.assign(current, patch);
    heldUntil = performance.now() + HOLD_MS;
    render(current);
    try {
      await invoke(command, args);
      done(null);
    } catch (error) {
      Object.assign(current, before);
      heldUntil = 0;
      render(current);
      done(String(error));
    }
  }

  return {
    current: current as Readonly<Modes>,
    receive(report: ModeReport) {
      current.canShuffle = report.canShuffle === true;
      current.canRepeatContext = report.canRepeatContext === true;
      current.canRepeatTrack = report.canRepeatTrack === true;
      const reported = { shuffle: report.shuffle ?? null, repeat: report.repeat ?? null };
      // A player that cannot report them hides them at once, held or not.
      if (performance.now() >= heldUntil || reported.shuffle === null) Object.assign(current, reported);
      render(current);
    },
    toggleShuffle() {
      if (current.shuffle === null) return;
      const on = !current.shuffle;
      void change({ shuffle: on }, "set_shuffle", { on });
    },
    cycleRepeat() {
      const repeat = nextRepeat(current);
      if (repeat) void change({ repeat }, "set_repeat", { repeat });
    },
  };
}
