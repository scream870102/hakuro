/** Stable action IDs shared with the backend's shortcut allowlist. */
export const SHORTCUT_ACTIONS = [
  ["commands", "Commands", "命令選單"],
  ["playPause", "Play / pause", "播放／暫停"],
  ["previous", "Previous track", "上一首"],
  ["next", "Next track", "下一首"],
  ["seekBackward", "Back 10 seconds", "倒轉 10 秒"],
  ["seekForward", "Forward 10 seconds", "快轉 10 秒"],
  ["volumeUp", "Volume up", "音量 +5"],
  ["volumeDown", "Volume down", "音量 −5"],
  ["followLyrics", "Follow lyrics", "跟隨歌詞"],
  ["translations", "Show translations", "顯示翻譯"],
  ["findLyrics", "Find lyrics", "搜尋歌詞"],
  ["reloadLyrics", "Reload lyrics", "重新載入歌詞"],
  ["compact", "Compact mode", "精簡模式"],
  ["alwaysOnTop", "Keep on top", "置頂"],
  ["settings", "Settings", "設定"],
  ["clickThrough", "Click-through", "滑鼠穿透"],
] as const;
export type ShortcutAction = typeof SHORTCUT_ACTIONS[number][0];
export interface ShortcutBinding { action: ShortcutAction; accelerator: string; global: boolean }
export const DEFAULT_SHORTCUTS: ShortcutBinding[] = [
  { action: "commands", accelerator: "Ctrl+KeyK", global: false },
  { action: "clickThrough", accelerator: "Ctrl+Alt+KeyP", global: true },
];

const supported = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-9]|2[0-4])|Arrow(Up|Down|Left|Right)|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown)$/;

/** Physical keys keep bindings stable across keyboard languages. */
export function shortcutFromEvent(event: KeyboardEvent): string | undefined {
  if (event.isComposing || event.repeat || event.getModifierState("AltGraph")) return;
  const code = event.code || (/^[a-z]$/i.test(event.key) ? `Key${event.key.toUpperCase()}` :
    /^[0-9]$/.test(event.key) ? `Digit${event.key}` : event.key === " " ? "Space" : event.key);
  if (!supported.test(code)) return;
  if (!event.ctrlKey && !event.altKey && !event.metaKey && !/^F\d+$/.test(code)) return;
  return [event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift", event.metaKey && "Super", code].filter(Boolean).join("+");
}

export const shortcutLabel = (accelerator: string) => accelerator
  .replace(/Key(?=[A-Z])/g, "").replace(/Digit(?=\d)/g, "").replace(/Super/g, "Win");

export function shortcutConflict(bindings: ShortcutBinding[]): string | undefined {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!binding.accelerator) continue;
    if (seen.has(binding.accelerator)) return `${shortcutLabel(binding.accelerator)} is already bound. Choose a different shortcut.`;
    seen.add(binding.accelerator);
  }
}
