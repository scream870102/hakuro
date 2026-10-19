/**
 * The lyrics source window: pick a preferred source for the song that was
 * playing when it opened, or go back to the global search order. The main
 * window passes that song in the URL; the window closes itself if the song
 * changes.
 */

import { invoke } from "@tauri-apps/api/core";
import { applyTheme, type Config } from "./config";
import { closePanel, closeWhenTrackChanges, element, reveal, wireClosing } from "./panel";

const params = new URLSearchParams(location.search);
const trackId = params.get("track") ?? "";
const select = element<HTMLSelectElement>("track-source");
const save = element<HTMLButtonElement>("source-save");
const error = element("source-error");

element("source-cancel").addEventListener("click", closePanel);
wireClosing();

save.addEventListener("click", async () => {
  save.disabled = true;
  error.textContent = "";
  try {
    await invoke("set_track_source", { source: select.value || null, trackId });
    closePanel();
  } catch (reason) { error.textContent = String(reason); }
  finally { save.disabled = false; }
});

async function start() {
  void closeWhenTrackChanges(trackId);
  element("source-track").textContent = params.get("title") ?? "";
  select.replaceChildren(new Option("Automatic (global preferences)", ""));
  try {
    const config = await invoke<Config>("get_config");
    applyTheme(config.settings.theme);
    config.providers.forEach((provider) => select.add(new Option(provider.label, provider.id)));
    select.value = params.get("source") ?? "";
  } catch (reason) {
    error.textContent = String(reason);
    save.disabled = true;
  }
  await reveal();
  select.focus();
}

void start();
