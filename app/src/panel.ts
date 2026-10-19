/**
 * What the panel windows (settings, Find lyrics, lyrics source) share. Each is
 * a window of its own, owned by the main window, created hidden and shown once
 * it has drawn, and closed rather than hidden when it is done.
 */

import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export const element = <T extends HTMLElement>(id: string): T => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element: ${id}`);
  return found as T;
};

export const panel = getCurrentWindow();

export const closePanel = () => void panel.close();

/** The header's close button and Escape both close, as they did when these were dialogs. */
export function wireClosing() {
  element("panel-close").addEventListener("click", closePanel);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) closePanel();
  });
}

/** Created hidden, so it never flashes an empty form; shown once filled in. */
export async function reveal() {
  await panel.show();
  await panel.setFocus();
}

/**
 * A panel about one song closes when that song stops playing: anything it
 * would save afterwards would land on the wrong track. Playback events reach
 * every window.
 */
export function closeWhenTrackChanges(trackKey: string) {
  return listen<{ hasTrack: boolean; trackKey: string }>("playback", ({ payload }) => {
    if (!payload.hasTrack || payload.trackKey !== trackKey) closePanel();
  });
}
