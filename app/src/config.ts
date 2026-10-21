/**
 * The settings shape the backend stores, shared by the main window and the
 * settings window, and the few things both do with it.
 */

import type { ShortcutAction, ShortcutBinding } from "./shortcuts";

export type ClickThrough = "off" | "auto" | "always";
/**
 * Which player Hakuro follows. The two YouTube Music desktop apps have separate
 * local APIs and credentials; exactly one player is live at a time.
 */
export type PlayerKind = "spotify" | "ytmdesktop" | "ytmdesktop2";

export interface Theme { accent: string; activeLine: string; pastLine: string }

export interface Settings {
  player: PlayerKind;
  clientId: string;
  /** Where ytmdesktop2 serves its API, 9999–39999. */
  ytmdPort: number;
  sources: { id: string; enabled: boolean }[];
  theme: Theme;
  followLyrics: boolean;
  checkUpdates: boolean;
  /** Command run after rapidly turning the cube; null leaves the gesture unbound. */
  shakeAction: ShortcutAction | null;
  /** Written by the backend after the release notes have been displayed. */
  lastSeenVersion: string;
  alwaysOnTop: boolean;
  /** Background opacity as a percentage; the lyrics stay opaque regardless. */
  opacity: number;
  clickThrough: ClickThrough;
  compact: boolean;
  /** Compact's cube stretches sideways to show the lyrics. */
  compactLyrics: boolean;
  /** Stored but unused: compact's window is the cube alone, with no background to thin. */
  compactOpacity: number;
  lyricSize: number;
  compactLyricSize: number;
  /** The tile floor that ripples with the sound under the cube, per mode. */
  waveFull: boolean;
  waveCompact: boolean;
  /** How hard the floor answers the sound, 10–200 (%). */
  waveStrength: number;
  shortcuts: ShortcutBinding[];
}

export interface Config {
  settings: Settings;
  providers: { id: string; label: string }[];
  dataDir: string;
  storedTracks: number;
  storageWarning: string;
}

/** The settings window's dials, sent to the main window as they move. */
export interface WindowStylePreview {
  opacity: number;
  compactOpacity: number;
  lyricSize: number;
  compactLyricSize: number;
  waveStrength: number;
}

export const SETTINGS_PREVIEW = "settings:preview";
export const WHATS_NEW_OPEN = "whats-new:open";
/** Find lyrics → main: its translation toggle drives the main window's lyrics. */
export const SEARCH_TRANSLATIONS = "search:translations";

export function applyTheme(theme: Theme) {
  const root = document.documentElement.style;
  root.setProperty("--accent", theme.accent);
  root.setProperty("--active-line", theme.activeLine);
  root.setProperty("--past-line", theme.pastLine);
}
