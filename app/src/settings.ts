/**
 * The settings window. It edits a draft of the stored settings and saves the
 * whole draft at once. The main window reads the stored settings again when
 * this window closes, so Save, Cancel and closing it any other way all leave
 * the main window showing what is actually stored. The opacity and size dials
 * preview on the main window as they move, since judging them from a number
 * alone is guesswork.
 */

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import {
  applyTheme, SETTINGS_PREVIEW,
  type ClickThrough, type Config, type PlayerKind, type Settings, type WindowStylePreview,
} from "./config";
import { closePanel, element, reveal, wireClosing } from "./panel";

const settingsError = element("settings-error");
let config: Config | undefined;
let draft: Settings | undefined;

/** The four per-mode dials, each with its own readout. */
const DIALS = [
  { input: "settings-opacity", output: "opacity-value", unit: "%", key: "opacity" },
  { input: "settings-compact-opacity", output: "compact-opacity-value", unit: "%", key: "compactOpacity" },
  { input: "settings-lyric-size", output: "lyric-size-value", unit: "px", key: "lyricSize" },
  { input: "settings-compact-lyric-size", output: "compact-lyric-size-value", unit: "px", key: "compactLyricSize" },
] as const;

const dialValue = (id: string) => Number(element<HTMLInputElement>(id).value);

/** The slider track fills up to the thumb; CSS cannot read a range's value. */
function paintRange(input: HTMLInputElement) {
  const min = Number(input.min);
  const max = Number(input.max);
  input.style.setProperty("--p", `${((Number(input.value) - min) / (max - min)) * 100}%`);
}

/** All four values; the main window picks the pair for the mode it is in. */
function previewWindowStyle() {
  const preview: WindowStylePreview = {
    opacity: dialValue("settings-opacity"),
    compactOpacity: dialValue("settings-compact-opacity"),
    lyricSize: dialValue("settings-lyric-size"),
    compactLyricSize: dialValue("settings-compact-lyric-size"),
  };
  void emitTo("main", SETTINGS_PREVIEW, preview);
}

for (const dial of DIALS) {
  const input = element<HTMLInputElement>(dial.input);
  input.addEventListener("input", () => {
    element(dial.output).textContent = `${input.value}${dial.unit}`;
    paintRange(input);
    previewWindowStyle();
  });
}

function renderSourceOrder() {
  if (!draft) return;
  const sources = draft.sources;
  const list = element("source-order");
  list.replaceChildren();
  sources.forEach((source, index) => {
    const row = document.createElement("li");
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = source.enabled;
    checkbox.addEventListener("change", () => { source.enabled = checkbox.checked; });
    const name = config?.providers.find((provider) => provider.id === source.id)?.label ?? source.id;
    label.append(checkbox, document.createTextNode(name));
    row.append(label);
    for (const [direction, text] of [[-1, "↑"], [1, "↓"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ghost-button";
      button.textContent = text;
      button.setAttribute("aria-label", `Move ${name} ${direction < 0 ? "up" : "down"}`);
      const target = index + direction;
      button.disabled = target < 0 || target >= sources.length;
      button.addEventListener("click", () => {
        [sources[index], sources[target]] = [sources[target], sources[index]];
        renderSourceOrder();
        (list.children[target]?.querySelectorAll("button")[direction < 0 ? 0 : 1] as HTMLButtonElement)?.focus();
      });
      row.append(button);
    }
    list.append(row);
  });
}

/** Only Spotify has anything to configure, so the rest of the panel is hidden. */
function showPlayerSettings(player: PlayerKind) {
  element("spotify-settings").hidden = player !== "spotify";
}

element<HTMLSelectElement>("settings-player").addEventListener("change", (event) => {
  showPlayerSettings((event.target as HTMLSelectElement).value as PlayerKind);
});

function fill(value: Config) {
  config = value;
  draft = structuredClone(value.settings);
  applyTheme(draft.theme);
  element<HTMLSelectElement>("settings-player").value = draft.player;
  showPlayerSettings(draft.player);
  element<HTMLInputElement>("client-id").value = draft.clientId;
  element<HTMLInputElement>("color-accent").value = draft.theme.accent;
  element<HTMLInputElement>("color-active").value = draft.theme.activeLine;
  element<HTMLInputElement>("color-past").value = draft.theme.pastLine;
  element<HTMLInputElement>("settings-follow").checked = draft.followLyrics;
  for (const dial of DIALS) {
    element<HTMLInputElement>(dial.input).value = String(draft[dial.key]);
    element(dial.output).textContent = `${draft[dial.key]}${dial.unit}`;
    paintRange(element<HTMLInputElement>(dial.input));
  }
  element<HTMLSelectElement>("settings-click-through").value = draft.clickThrough;
  element("storage-info").textContent = `Data folder: ${value.dataDir} · Cached songs: ${value.storedTracks}`;
  settingsError.textContent = value.storageWarning;
  renderSourceOrder();
}

// Closing never saves; the main window puts back whatever a dial previewed.
wireClosing();
element("settings-cancel").addEventListener("click", closePanel);

element("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!draft) return;
  const button = element<HTMLButtonElement>("settings-save");
  button.disabled = true;
  settingsError.textContent = "";
  draft.player = element<HTMLSelectElement>("settings-player").value as PlayerKind;
  draft.clientId = element<HTMLInputElement>("client-id").value.trim();
  draft.theme = {
    accent: element<HTMLInputElement>("color-accent").value,
    activeLine: element<HTMLInputElement>("color-active").value,
    pastLine: element<HTMLInputElement>("color-past").value,
  };
  draft.followLyrics = element<HTMLInputElement>("settings-follow").checked;
  for (const dial of DIALS) draft[dial.key] = dialValue(dial.input);
  draft.clickThrough = element<HTMLSelectElement>("settings-click-through").value as ClickThrough;
  try {
    await invoke<Config>("save_settings", { incoming: draft });
    closePanel();
  } catch (error) { settingsError.textContent = String(error); }
  finally { button.disabled = false; }
});

async function start() {
  try {
    fill(await invoke<Config>("get_config"));
  } catch (error) { settingsError.textContent = String(error); }
  getVersion().then(
    (version) => { element("app-version").textContent = `v${version}`; },
    () => { /* outside Tauri there is no bundle to ask; the dash stays */ },
  );
  await reveal();
}

void start();
