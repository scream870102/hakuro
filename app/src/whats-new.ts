import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { applyTheme, type Config } from "./config";
import { element, reveal, wireClosing } from "./panel";
import { releases } from "./releases";

wireClosing();

const status = element("whats-new-status");
const issues: string[] = [];

function report() {
  status.textContent = issues.length ? issues.join(" ") : "點選版本可展開或收合更新說明。";
  status.classList.toggle("is-error", issues.length > 0);
}

function render(current: string | null) {
  element("whats-new-version").textContent = current ? `HAKURO / v${current}` : "HAKURO / 版本未知";
  element("release-history").replaceChildren(...releases.map((release) => {
    const details = document.createElement("details");
    details.className = "release";
    details.dataset.version = release.version;
    const isCurrent = release.version === current;
    details.open = isCurrent;
    details.classList.toggle("is-current", isCurrent);
    const summary = document.createElement("summary");
    const meta = document.createElement("span");
    meta.className = "release__meta";
    const version = document.createElement("span");
    version.className = "release__version";
    version.textContent = `v${release.version}`;
    meta.append(version);
    if (isCurrent) {
      const badge = document.createElement("span");
      badge.className = "release__current";
      badge.textContent = "目前版本";
      meta.append(badge);
    }
    const date = document.createElement("time");
    date.dateTime = release.date;
    date.textContent = release.date;
    meta.append(date);
    const title = document.createElement("span");
    title.className = "release__title";
    title.textContent = release.title;
    summary.append(meta, title);
    const list = document.createElement("ul");
    list.append(...release.changes.map((change) => {
      const item = document.createElement("li");
      item.textContent = change;
      return item;
    }));
    details.append(summary, list);
    return details;
  }));
}

async function start() {
  const [version, config] = await Promise.allSettled([getVersion(), invoke<Config>("get_config")]);
  const current = version.status === "fulfilled" ? version.value : null;
  if (config.status === "fulfilled") applyTheme(config.value.settings.theme);
  else issues.push("無法讀取主題，已使用預設配色。");
  render(current);
  const hasNotes = releases.some((release) => release.version === current);
  if (!current) issues.push("無法確認目前版本，請稍後重新開啟。");
  else if (!hasNotes) issues.push(`尚未收錄 v${current} 的更新說明，可以先瀏覽歷史版本。`);
  report();
  try {
    await reveal();
  } catch {
    issues.push("視窗未能完整開啟，尚未記錄為已讀。");
    report();
    return;
  }
  element("whats-new-lean").classList.add("is-in");
  // Only acknowledge a known release after its notes are rendered and visible.
  if (hasNotes) {
    try {
      await invoke("mark_whats_new_seen");
    } catch {
      issues.push("無法儲存已讀記錄，下次啟動時可能再次顯示。");
      report();
    }
  }
}

void start();
