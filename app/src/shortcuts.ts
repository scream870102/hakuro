/**
 * Stable action IDs shared with the backend's shortcut allowlist: one for every
 * command in the palette, plus opening the palette itself. Grouped as the
 * palette groups them.
 */
export const SHORTCUT_ACTIONS = [
  ["commands", "Commands", "命令選單", "GENERAL"],
  ["playPause", "Play / pause", "播放／暫停", "PLAYBACK"],
  ["previous", "Previous track", "上一首", "PLAYBACK"],
  ["next", "Next track", "下一首", "PLAYBACK"],
  ["seekBackward", "Back 10 seconds", "倒轉 10 秒", "PLAYBACK"],
  ["seekForward", "Forward 10 seconds", "快轉 10 秒", "PLAYBACK"],
  ["mute", "Mute / unmute", "靜音／取消靜音", "PLAYBACK"],
  ["volumeUp", "Volume up", "音量 +5", "PLAYBACK"],
  ["volumeDown", "Volume down", "音量 −5", "PLAYBACK"],
  ["queue", "Queue", "播放佇列", "PLAYBACK"],
  ["randomQueue", "Random queue track", "隨機跳至佇列歌曲", "PLAYBACK"],
  ["shuffle", "Shuffle", "隨機播放", "PLAYBACK"],
  ["repeat", "Repeat", "循環播放", "PLAYBACK"],
  ["refreshPlayback", "Refresh playback", "重新整理播放狀態", "PLAYBACK"],
  ["reconnect", "Retry connection", "重新連線", "PLAYBACK"],
  ["followLyrics", "Follow lyrics", "跟隨歌詞", "LYRICS"],
  ["translations", "Show translations", "顯示翻譯", "LYRICS"],
  ["findLyrics", "Find lyrics", "搜尋歌詞", "LYRICS"],
  ["lyricsSource", "Lyrics source", "歌詞來源", "LYRICS"],
  ["reloadLyrics", "Reload lyrics", "重新載入歌詞", "LYRICS"],
  ["compact", "Compact mode", "精簡模式", "WINDOW"],
  ["compactLyrics", "Lyrics in compact mode", "精簡模式顯示歌詞", "WINDOW"],
  ["alwaysOnTop", "Keep on top", "置頂", "WINDOW"],
  ["clickThrough", "Click-through", "滑鼠穿透", "WINDOW"],
  ["settings", "Settings", "設定", "WINDOW"],
  ["whatsNew", "What's new", "版本更新說明", "WINDOW"],
  ["waveFull", "Sound wave in full mode", "波動：完整模式", "WINDOW"],
  ["waveCompact", "Sound wave in compact mode", "波動：精簡模式", "WINDOW"],
  ["minimize", "Minimize", "最小化", "WINDOW"],
  ["maximize", "Maximize / restore", "最大化／還原", "WINDOW"],
  ["turnFront", "Turn cube: Cover", "方塊轉到封面", "CUBE"],
  ["turnRight", "Turn cube: Volume", "方塊轉到音量", "CUBE"],
  ["turnBack", "Turn cube: Lyric tools", "方塊轉到歌詞工具", "CUBE"],
  ["turnLeft", "Turn cube: Window tools", "方塊轉到視窗工具", "CUBE"],
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
