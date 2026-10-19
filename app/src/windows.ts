/**
 * The palette and the panels (settings, Find lyrics, lyrics source) are windows
 * of their own, so a small main window (compact above all) never cramps them.
 * All are owned by the main window: on Windows an owned window always sits
 * above its owner, a pinned one included, hides while the owner is minimized
 * and closes with it.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

export interface Placement { x: number; y: number; width: number; height: number }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/**
 * Where a child window of this size goes, in logical pixels: centred across the
 * main window, `drop` of the spare height down from its top edge (never above
 * it), and moved or shrunk as needed to stay inside the monitor's work area.
 */
export async function placeOverMain(width: number, height: number, drop: number): Promise<Placement> {
  const main = getCurrentWindow();
  const [scale, position, size, monitor] = await Promise.all([
    main.scaleFactor(), main.outerPosition(), main.outerSize(), currentMonitor(),
  ]);
  const left = position.x / scale;
  const top = position.y / scale;
  const mainWidth = size.width / scale;
  const mainHeight = size.height / scale;
  let x = left + (mainWidth - width) / 2;
  let y = top + Math.max(0, (mainHeight - height) * drop);
  if (!monitor) return { x, y, width, height };

  const area = monitor.workArea;
  const areaLeft = area.position.x / scale;
  const areaTop = area.position.y / scale;
  const areaWidth = area.size.width / scale;
  const areaHeight = area.size.height / scale;
  width = Math.min(width, areaWidth);
  height = Math.min(height, areaHeight);
  x = clamp(x, areaLeft, areaLeft + areaWidth - width);
  y = clamp(y, areaTop, areaTop + areaHeight - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/** Options every child window shares: frameless and dark like the main window, owned by it. */
export const CHILD_WINDOW = {
  parent: "main",
  decorations: false,
  skipTaskbar: true,
  theme: "dark",
  // Shown by the page itself once it has drawn, so it never flashes empty.
  visible: false,
} as const;

export interface PanelSpec {
  url: string;
  title: string;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  /** How far down the spare height it opens; see `placeOverMain`. */
  drop: number;
}

const opening = new Set<string>();

/**
 * Open a panel window (settings, Find lyrics, lyrics source), or bring it
 * forward if it is already open. Resolves to the new window, or to null when
 * one was already there.
 */
export async function openPanel(label: string, spec: PanelSpec): Promise<WebviewWindow | null> {
  const open = await WebviewWindow.getByLabel(label);
  if (open) {
    await open.setFocus();
    return null;
  }
  if (opening.has(label)) return null;
  opening.add(label);
  try {
    const { drop, ...options } = spec;
    const place = await placeOverMain(spec.width, spec.height, drop);
    return await created(new WebviewWindow(label, {
      ...CHILD_WINDOW,
      ...options,
      ...place,
      resizable: true,
      // The page draws its own border, so no system frame or shadow around it.
      transparent: true,
      shadow: false,
      backgroundColor: "#0c0c0c",
    }));
  } finally {
    opening.delete(label);
  }
}

/**
 * Resolve once the window exists, or reject with the reason it could not be
 * made (a missing permission, a duplicate label).
 */
export function created(window: WebviewWindow): Promise<WebviewWindow> {
  return new Promise((resolve, reject) => {
    void window.once("tauri://created", () => resolve(window));
    void window.once<string>("tauri://error", (event) => reject(new Error(String(event.payload))));
  });
}
