/**
 * The palette, the panels (settings, Find lyrics, lyrics source) and the queue
 * are windows of their own, so a small main window (compact above all) never
 * cramps them.
 * All are owned by the main window: on Windows an owned window always sits
 * above its owner, a pinned one included, hides while the owner is minimized
 * and closes with it.
 */

import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";

export interface Placement { x: number; y: number; width: number; height: number }

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** The main window and its monitor's work area, in logical pixels. */
async function mainFrame() {
  const main = getCurrentWindow();
  const [scale, position, size, monitor] = await Promise.all([
    main.scaleFactor(), main.outerPosition(), main.outerSize(), currentMonitor(),
  ]);
  const frame = {
    left: position.x / scale,
    top: position.y / scale,
    width: size.width / scale,
    height: size.height / scale,
  };
  const area = monitor && {
    left: monitor.workArea.position.x / scale,
    top: monitor.workArea.position.y / scale,
    width: monitor.workArea.size.width / scale,
    height: monitor.workArea.size.height / scale,
  };
  return { frame, area };
}

/** Shrink to the work area and move inside it, rounded to whole pixels. */
function keepInside(place: Placement, area: Awaited<ReturnType<typeof mainFrame>>["area"]): Placement {
  if (!area) return place;
  const width = Math.min(place.width, area.width);
  const height = Math.min(place.height, area.height);
  const x = clamp(place.x, area.left, area.left + area.width - width);
  const y = clamp(place.y, area.top, area.top + area.height - height);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
}

/**
 * Where a child window of this size goes, in logical pixels: centred across the
 * main window, `drop` of the spare height down from its top edge (never above
 * it), and moved or shrunk as needed to stay inside the monitor's work area.
 */
export async function placeOverMain(width: number, height: number, drop: number): Promise<Placement> {
  const { frame, area } = await mainFrame();
  const x = frame.left + (frame.width - width) / 2;
  const y = frame.top + Math.max(0, (frame.height - height) * drop);
  return area ? keepInside({ x, y, width, height }, area) : { x, y, width, height };
}

/**
 * Beside the main window rather than over it, so the cube stays in view:
 * to its right, or to its left when the right edge of the screen is too
 * close, level with its middle. With room on neither side it overlaps.
 */
export async function placeBesideMain(width: number, height: number, gap = 8): Promise<Placement> {
  const { frame, area } = await mainFrame();
  const right = frame.left + frame.width + gap;
  const left = frame.left - gap - width;
  let x = right;
  if (area && right + width > area.left + area.width && left >= area.left) x = left;
  const y = frame.top + (frame.height - height) / 2;
  return area ? keepInside({ x, y, width, height }, area) : { x, y, width, height };
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
