/** Shared action geometry for the main window, panels and command palette. */
const ICONS = {
  findLyrics: [12, "<circle cx=\"5\" cy=\"5\" r=\"3\"></circle><path d=\"m7.3 7.3 3 3\"></path>"],
  settings: [12, "<path d=\"M1.8 4h8.4M1.8 8h8.4\"></path><circle cx=\"4.2\" cy=\"4\" r=\"1.5\"></circle><circle cx=\"7.8\" cy=\"8\" r=\"1.5\"></circle>"],
  refresh: [12, "<path d=\"M9.9 5.2A4 4 0 1 0 9.4 8M10 1.9v3.3H6.7\"></path>"],
  compact: [12, "<path d=\"M6 1.4v3.1M4.4 3l1.6 1.5L7.6 3M6 10.6V7.5M4.4 9l1.6-1.5L7.6 9\"></path>"],
  expand: [12, "<path d=\"M6 4.5V1.4M4.4 2.9L6 1.4l1.6 1.5M6 7.5v3.1M4.4 9.1L6 10.6l1.6-1.5\"></path>"],
  alwaysOnTop: [12, "<path d=\"M3.6 1.4h4.8M5 1.4v2.8L3.4 6h5.2L7 4.2V1.4M6 6v3.2\"></path>"],
  minimize: [12, "<path d=\"M2.5 6h7\"></path>"],
  maximize: [12, "<path d=\"M2.5 2.5h7v7h-7z\"></path>"],
  restore: [12, "<path d=\"M2.5 4.5h5v5h-5zM4.5 4.5v-2h5v5h-2\"></path>"],
  close: [12, "<path d=\"M2.6 2.6l6.8 6.8M9.4 2.6l-6.8 6.8\"></path>"],
  queue: [24, "<path d=\"M3 6h13M3 11h13M3 16h8\"></path><path class=\"icon-solid\" d=\"M16 14.5v6l5-3z\"></path>"],
  shuffle: [24, "<path d=\"M3 7h3c2.5 0 3.7 1.4 5 3.6l1.6 2.8C14 15.6 15.4 17 18 17h3M18 14l3 3-3 3M3 17h3c1.5 0 2.5-.5 3.4-1.5M21 7h-3c-1.5 0-2.6.5-3.5 1.5M18 4l3 3-3 3\"></path>"],
  repeat: [24, "<path d=\"M4 11V9.5A3.5 3.5 0 0 1 7.5 6H20M17 3l3 3-3 3M20 13v1.5a3.5 3.5 0 0 1-3.5 3.5H4M7 21l-3-3 3-3\"></path>"],
  play: [24, "<path d=\"M7 4.8v14.4a.8.8 0 0 0 1.22.68l11.3-7.2a.8.8 0 0 0 0-1.36L8.22 4.12A.8.8 0 0 0 7 4.8Z\"></path>", true],
  pause: [24, "<path d=\"M6 4.5h4v15H6zM14 4.5h4v15h-4z\"></path>", true],
  previous: [24, "<path d=\"M5 5h3v14H5zM20 5.8v12.4a.8.8 0 0 1-1.25.66L9.5 12.66a.8.8 0 0 1 0-1.32l9.25-6.2A.8.8 0 0 1 20 5.8Z\"></path>", true],
  next: [24, "<path d=\"M16 5h3v14h-3zM4 5.8v12.4a.8.8 0 0 0 1.25.66l9.25-6.2a.8.8 0 0 0 0-1.32L5.25 5.14A.8.8 0 0 0 4 5.8Z\"></path>", true],
  mute: [24, "<path d=\"M11 4 6 8H3v8h3l5 4Z\"></path><path d=\"m16 9 6 6m0-6-6 6\"></path>"],
  unmute: [24, "<path d=\"M11 4 6 8H3v8h3l5 4Z\"></path><path d=\"M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14\"></path>"],
  lyricsSource: [12, "<path d=\"M2.5 4.5 6 8l3.5-3.5\"></path>"],
  followLyrics: [12, "<path d=\"M6 1.5v6.2M3.4 5.3 6 7.9l2.6-2.6M2 10.5h8\"></path>"],
  compactLyrics: [12, "<path d=\"M1.5 2h9v6.5H5L2.5 10V8.5h-1zM3.5 4.2h5M3.5 6.3h3.5\"/>"],
  seekForward: [12, "<path d=\"M1.5 6h9M7 2.5 10.5 6 7 9.5\"/>"],
  seekBackward: [12, "<path d=\"M10.5 6h-9M5 2.5 1.5 6 5 9.5\"/>"],
  volumeUp: [12, "<path d=\"M6 2v8M2 6h8\"/>"],
  volumeDown: [12, "<path d=\"M2 6h8\"/>"],
  randomQueue: [12, "<rect x=\"1.5\" y=\"1.5\" width=\"9\" height=\"9\" rx=\"1.5\"/><path d=\"M3.5 3.5h.01M8.5 3.5h.01M6 6h.01M3.5 8.5h.01M8.5 8.5h.01\"/>"],
  translations: [12, "<path d=\"M1 3h6M4 1.5V3M2.5 3q0 4 4.5 5M5.5 3q0 4-4.5 5M7 10.5 9 5l2 5.5M7.8 8.5h2.4\"/>"],
  clickThrough: [12, "<path d=\"m2 1.5 7 4-3.5 1L4 10zM8 8l2.5 2.5\"/>"],
  whatsNew: [12, "<path d=\"M6 1 7.3 4.7 11 6 7.3 7.3 6 11 4.7 7.3 1 6 4.7 4.7z\"/>"],
  wave: [12, "<path d=\"M1 4q2-2 5 0t5 0M1 8q2-2 5 0t5 0\"/>"],
  cube: [12, "<path d=\"m6 1 4.5 2.5v5L6 11 1.5 8.5v-5ZM1.5 3.5 6 6l4.5-2.5M6 6v5\"/>"],
} as const;

export type IconName = keyof typeof ICONS;

/** Only bundled SVG is parsed; names received from another window are allowlisted. */
export function createIcon(name: string): SVGSVGElement | null {
  if (!Object.prototype.hasOwnProperty.call(ICONS, name)) return null;
  const [size, body, solid = false] = ICONS[name as IconName] as readonly [number, string, boolean?];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.dataset.icon = name;
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = `fill:${solid ? "currentColor" : "none"};stroke:${solid ? "none" : "currentColor"};stroke-width:${size === 24 ? 2 : 1.3};stroke-linecap:round;stroke-linejoin:round`;
  svg.innerHTML = body;
  svg.querySelectorAll<SVGElement>(".icon-solid").forEach(part => { part.style.fill = "currentColor"; part.style.stroke = "none"; });
  return svg;
}

export function renderIcons(root: ParentNode = document) {
  root.querySelectorAll<SVGSVGElement>("svg[data-icon]").forEach(placeholder => {
    const icon = createIcon(placeholder.dataset.icon!);
    if (!icon) return;
    icon.setAttribute("class", placeholder.getAttribute("class") ?? "");
    placeholder.replaceWith(icon);
  });
}
