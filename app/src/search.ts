/**
 * The Find lyrics window: search the enabled sources for another title or
 * artist, preview a candidate, and bind it to the song that was playing when
 * the window opened (or restore automatic search). The main window passes that
 * song in the URL; the window closes itself if the song changes.
 *
 * Search and preview share one request serial. Editing the query or changing
 * the source invalidates any outstanding response.
 */

import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { formatTime } from "./clock";
import { applyTheme, SEARCH_TRANSLATIONS, type Config } from "./config";
import { closePanel, closeWhenTrackChanges, element, reveal, wireClosing } from "./panel";

interface LyricCandidate {
  source: string;
  id: string;
  title: string;
  artists: string[];
  album: string;
  duration_ms: number;
}

interface LyricsResult {
  text: string;
  source: string;
  matched_title: string;
  cues: { time_ms: number; text: string; translation?: string | null }[];
  errors: unknown[];
}

/** The sources that can be searched by title; the others only look songs up. */
const SEARCHABLE = ["lrclib", "netease", "qqmusic"];

const params = new URLSearchParams(location.search);
const trackId = params.get("track") ?? "";

const query = element<HTMLInputElement>("lyrics-query");
const source = element<HTMLSelectElement>("lyrics-search-source");
const submit = element<HTMLButtonElement>("lyrics-search-submit");
const status = element("lyrics-search-status");
const candidates = element("lyrics-candidates");
const previewPanel = element("lyrics-preview-panel");
const previewText = element("lyrics-preview");
const apply = element<HTMLButtonElement>("lyrics-match-apply");
const clear = element<HTMLButtonElement>("lyrics-match-clear");
const translations = element<HTMLInputElement>("show-translations");
const manual = params.get("manual") === "1";

let serial = 0;
let selected: LyricCandidate | undefined;
let saving = false;

function reset() {
  serial++;
  selected = undefined;
  apply.disabled = true;
  previewPanel.hidden = true;
  previewText.textContent = "";
  candidates.replaceChildren();
  status.textContent = "";
}

async function previewCandidate(candidate: LyricCandidate, button: HTMLButtonElement) {
  const current = ++serial;
  selected = undefined;
  apply.disabled = true;
  previewPanel.hidden = true;
  status.textContent = "Loading preview…";
  candidates.querySelectorAll("button").forEach((row) => row.setAttribute("aria-pressed", String(row === button)));
  try {
    const result = await invoke<LyricsResult>("preview_lyric_candidate", { trackId, candidate });
    if (current !== serial) return;
    const text = result.cues.length
      ? result.cues.map((cue) => `${formatTime(cue.time_ms)}  ${cue.text}${cue.translation ? `\n    ${cue.translation}` : ""}`).join("\n")
      : result.text;
    previewText.textContent = text;
    previewPanel.hidden = !text;
    status.textContent = text ? "Preview ready. Use these lyrics to remember this match for this song." : "This candidate has no lyrics. Try another result.";
    if (text) {
      selected = candidate;
      apply.disabled = saving;
    }
  } catch (error) {
    if (current === serial) status.textContent = String(error);
  }
}

element("lyrics-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (saving || !query.value.trim() || !source.value) return;
  reset();
  const current = serial;
  status.textContent = "Searching…";
  try {
    const found = await invoke<LyricCandidate[]>("search_lyrics", { trackId, query: query.value.trim(), source: source.value });
    if (current !== serial) return;
    status.textContent = found.length ? `${found.length} results. Choose one to preview.` : "No results. Try another title, artist or source.";
    for (const candidate of found) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lyric-candidate";
      button.setAttribute("aria-pressed", "false");
      const title = document.createElement("strong");
      title.textContent = candidate.title;
      const detail = document.createElement("span");
      detail.textContent = [candidate.artists.join(", "), candidate.album, candidate.duration_ms > 0 ? formatTime(candidate.duration_ms) : "", candidate.source].filter(Boolean).join(" · ");
      button.append(title, detail);
      button.addEventListener("click", () => { if (!saving) void previewCandidate(candidate, button); });
      row.append(button);
      candidates.append(row);
    }
  } catch (error) {
    if (current === serial) status.textContent = String(error);
  }
});

async function saveMatch(restore: boolean) {
  if (saving || (!restore && !selected)) return;
  const current = ++serial;
  saving = true;
  for (const control of [query, source, submit, apply, clear]) control.disabled = true;
  status.textContent = restore ? "Restoring automatic search…" : "Saving match…";
  try {
    await invoke(restore ? "clear_lyric_match" : "apply_lyric_match", restore ? { trackId } : { trackId, candidate: selected });
    closePanel();
  } catch (error) {
    if (current === serial) status.textContent = String(error);
    query.disabled = false;
    source.disabled = false;
    submit.disabled = !source.options.length;
    apply.disabled = !selected;
    clear.disabled = !manual;
  } finally {
    saving = false;
  }
}

query.addEventListener("input", reset);
source.addEventListener("change", reset);
apply.addEventListener("click", () => void saveMatch(false));
clear.addEventListener("click", () => void saveMatch(true));
element("lyrics-search-close").addEventListener("click", closePanel);
translations.addEventListener("change", () => void emitTo("main", SEARCH_TRANSLATIONS, translations.checked));
wireClosing();

async function start() {
  void closeWhenTrackChanges(trackId);
  element("lyrics-search-track").textContent = params.get("title") ?? "";
  query.value = params.get("query") ?? "";
  translations.checked = params.get("translations") === "1";
  clear.disabled = !manual;
  try {
    const config = await invoke<Config>("get_config");
    applyTheme(config.settings.theme);
    for (const entry of config.settings.sources) {
      if (!entry.enabled || !SEARCHABLE.includes(entry.id)) continue;
      const label = config.providers.find((provider) => provider.id === entry.id)?.label ?? entry.id;
      source.add(new Option(label, entry.id));
    }
    submit.disabled = !source.options.length;
    if (!source.options.length) status.textContent = "Enable LRCLIB, NetEase or QQ Music in Settings to search.";
  } catch (error) {
    status.textContent = String(error);
    submit.disabled = true;
  }
  await reveal();
  query.focus();
  query.select();
}

void start();
