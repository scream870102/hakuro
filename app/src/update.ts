import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { applyTheme, type Config } from "./config";
import { closePanel, element, reveal, wireClosing } from "./panel";

wireClosing();
// Later keeps the downloaded update; Hakuro installs it as it closes.
element("update-dismiss").addEventListener("click", closePanel);
element<HTMLButtonElement>("update-install").addEventListener("click", async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  const error = element("update-error");
  error.hidden = true;
  button.disabled = true;
  try {
    // On success the installer takes over and Hakuro exits before this returns.
    await invoke("install_update");
  } catch {
    error.textContent = "Could not install the update. 無法安裝，請改從 GitHub 下載。";
    error.hidden = false;
    element("update-release").hidden = false;
    button.disabled = false;
  }
});
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

/** A portable or development build cannot update itself, so the notification only links to GitHub. */
function showManual() {
  element("update-title").textContent = "New version available";
  element("update-message").textContent = "有新版本可用。可攜版與開發版無法自動更新，請前往 GitHub 下載。";
  element("update-install").hidden = true;
  const release = element("update-release");
  release.hidden = false;
  release.classList.add("ghost-button--go");
}

async function start() {
  const params = new URLSearchParams(location.search);
  const version = params.get("version") ?? "";
  const manual = params.has("manual");
  if (manual) showManual();
  element("update-version").textContent = `Hakuro ${version} is available.`;
  try {
    const [current, config] = await Promise.all([getVersion(), invoke<Config>("get_config")]);
    element("update-version").textContent = `v${current} → v${version}`;
    applyTheme(config.settings.theme);
  } catch { /* The notification can still show its version and its action. */ }
  await reveal();
  element(manual ? "update-release" : "update-install").focus();
}

void start();
