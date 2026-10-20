import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { applyTheme, type Config } from "./config";
import { closePanel, element, reveal, wireClosing } from "./panel";

wireClosing();
element("update-dismiss").addEventListener("click", closePanel);
element("update-release").addEventListener("click", async (event) => {
  event.preventDefault();
  const error = element("update-error");
  error.hidden = true;
  try {
    await invoke("open_latest_release");
    closePanel();
  } catch {
    error.textContent = "Could not open the browser. Try again.";
    error.hidden = false;
  }
});

async function start() {
  const version = new URLSearchParams(location.search).get("version") ?? "";
  element("update-version").textContent = `Hakuro ${version} is available.`;
  try {
    const [current, config] = await Promise.all([getVersion(), invoke<Config>("get_config")]);
    element("update-version").textContent = `v${current} → v${version}`;
    applyTheme(config.settings.theme);
  } catch { /* The notification can still show its version and release link. */ }
  await reveal();
  element("update-release").focus();
}

void start();
