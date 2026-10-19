/**
 * The palette window. The main window creates it hidden on first use and then
 * reuses it: each Ctrl+K sends a fresh snapshot, and the window draws it and
 * shows itself. Picking, dismissing or clicking elsewhere hides it again.
 */

import { getVersion } from "@tauri-apps/api/app";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  createPalette, PALETTE_CLOSED, PALETTE_READY, PALETTE_RUN, PALETTE_SHOW, type PaletteAction, type PaletteSnapshot,
} from "./palette";

const win = getCurrentWindow();
let shown = false;

/** Hide, and say why: a pick or a deliberate close hands the focus back to main. */
async function hide(then?: () => Promise<void>) {
  if (!shown) return;
  shown = false;
  await win.hide();
  await then?.();
}

const palette = createPalette({
  run: (action: PaletteAction) => void hide(() => emitTo("main", PALETTE_RUN, action)),
  dismiss: () => void hide(() => emitTo("main", PALETTE_CLOSED)),
});

/** How long a blur must last to count: showing the window can pass the focus
    to its webview and back, which reads as a blur for a moment. */
const BLUR_GRACE_MS = 150;

// Clicking another window is a dismissal too, but that window keeps the focus.
void win.onFocusChanged(({ payload: focused }) => {
  if (focused) return;
  window.setTimeout(async () => {
    if (shown && !(await win.isFocused())) void hide();
  }, BLUR_GRACE_MS);
});

const showReady = listen<PaletteSnapshot>(PALETTE_SHOW, async ({ payload }) => {
  if (payload.accent) document.documentElement.style.setProperty("--accent", payload.accent);
  palette.show(payload);
  shown = true;
  await win.show();
  await win.setFocus();
  palette.focus();
});

getVersion().then(palette.setVersion, () => { /* outside Tauri the heading stays plain */ });
void showReady.then(() => emitTo("main", PALETTE_READY));
