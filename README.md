# Hakuro

Windows 桌面歌詞播放器：跟隨 Spotify 正在播放的歌曲，搜尋原文歌詞、同步高亮，並把下載過的歌詞存入 SQLite。介面使用英文，以 Tauri 2、Rust 與 TypeScript 實作。

## 開始使用

1. 從 [Releases](https://github.com/scream870102/hakuro/releases) 下載 `*-setup.exe` 安裝，或把可攜版 `hakuro.exe` 放在你有寫入權限的資料夾。
2. 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 取得自己的 App **Client ID**，加入 Redirect URI：`http://127.0.0.1:8787/callback`。建立 App 與帳號資格限制以 [官方說明](https://developer.spotify.com/documentation/web-api/concepts/apps) 為準。
3. 開啟 Hakuro，點 **Settings**，在 **Spotify Client ID** 填入 Client ID 並儲存。只填 ID，不要加上 `SPOTIFY_CLIENT_ID=`。
4. 依畫面提示連線，在瀏覽器完成 Spotify 授權，然後在 Spotify 播放音樂。

App 使用 PKCE 授權。Redirect URI 必須完全一致，請勿改成 `localhost`；詳見 [Spotify Redirect URI 規則](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)。

## 歌詞與設定

- 點目前顯示的**歌詞來源按鈕**，可選擇這首歌偏好的來源，或回到自動搜尋。每首歌的選擇會保存在 SQLite。
- **Refresh lyrics** 會略過快取、重新向來源取得目前歌曲的歌詞；來源選擇控制搜尋對象，兩者可同時使用。
- **Settings** 可調整全域歌詞來源順序與啟用狀態。支援 LRCLIB、PetitLyrics、Musixmatch、NetEase、QQ Music。
- **Settings** 可設定按鈕與控制項的強調色、目前歌詞的高亮色、已唱過歌詞的顏色。
- **Follow lyrics** 控制是否自動捲動至目前歌詞；有時間軸時會隨播放位置高亮，純文字歌詞不會猜測時間。

SQLite 保留成功下載的歌詞，重新開啟 App 仍可使用。來源可能因網路、地區、限流或服務變更而無法提供結果；有同步歌詞時優先呈現同步歌詞。搜尋會向來源傳送歌曲名稱、歌手等查詢資料，不會傳送 Spotify token。

## 資料位置與備份

所有 App 個人資料都與 `hakuro.exe` 放在同一資料夾：

| 檔案 | 內容 |
| --- | --- |
| `settings.json` | Client ID、全域來源偏好、配色與跟隨歌詞設定 |
| `lyrics.db` | 已下載歌詞與每首歌的來源偏好 |
| `lyrics.db-wal`、`lyrics.db-shm` | SQLite 執行期間可能產生的輔助檔 |
| `session.bin` | 經 Windows DPAPI 加密的 Spotify refresh token |

請使用可寫入的資料夾，例如自己的文件資料夾；不要把可攜版放進唯讀目錄或 `Program Files`。備份或搬移前先關閉 App，再複製整個資料夾。`session.bin` 綁定 Windows 使用者與 Client ID，不能當成跨帳號／跨電腦登入憑證；搬到其他環境後請重新授權。

分享程式時只分享乾淨的執行檔或安裝程式，不要附上個人設定、資料庫或 `session.bin`。

## 開發環境

目前 Windows 實作使用 DPAPI，不是可直接在其他作業系統編譯的通用版本。

需要：

- Node.js 24 與 npm（需符合 lockfile 中各套件的 Node 版本要求）。
- Rust stable 與 Windows MSVC toolchain。
- Visual Studio Build Tools 的 **Desktop development with C++** 工作負載及 Windows SDK。
- Microsoft Edge WebView2 Runtime；使用者電腦執行 App 也需要它。

安裝細節見 [Tauri 官方前置需求](https://v2.tauri.app/start/prerequisites/)。在專案根目錄開啟 PowerShell：

```powershell
cd app
npm ci
npm run tauri -- dev
```

開發版的個人資料位於開發用執行檔旁，通常是 `app/src-tauri/target/debug/`；不會共用正式版資料。`npm run dev` 只開啟前端伺服器，完整 App 請使用 Tauri dev。

檢查與測試（工作目錄為 `app/`）：

```powershell
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## 打包與部署

以下命令在 Windows 執行，工作目錄為 `app/`；第一次建置需要網路下載 npm、Cargo 與打包工具依賴。若有指定 Cargo target 或 `CARGO_TARGET_DIR`，產物路徑會隨之改變。

### 可攜版 EXE

```powershell
npm ci
npm run tauri -- build --no-bundle
```

預設輸出：`app/src-tauri/target/release/hakuro.exe`（相對於專案根目錄）。把 EXE 複製到乾淨、可寫入的資料夾，即可使用或壓縮分享。前端資源已封裝，SQLite 使用 bundled 模式，無須另附 Node.js、Rust 或 SQLite DLL；目標電腦仍須安裝 WebView2 Runtime。

### NSIS 安裝程式

```powershell
npm ci
npm run tauri -- build --bundles nsis
```

預設輸出資料夾：`app/src-tauri/target/release/bundle/nsis/`，其中 `*-setup.exe` 是要提供給使用者的安裝程式。設定採 `currentUser` 安裝模式，請保留可寫入的安裝位置，讓設定和 SQLite 能存到 EXE 旁。NSIS 的 WebView2 安裝行為與部署選項見 [Tauri Windows Installer 文件](https://v2.tauri.app/distribute/windows-installer/)。

更新可攜版時，先關閉 App，再替換 `hakuro.exe`，保留原本的資料檔。不要把建置過程測試產生的資料檔打包給其他人。

### App icon

使用者提供的原圖保留在 `app/icon.png`，Tauri 使用 `app/src-tauri/icons/` 中的 PNG、ICO 與 ICNS。要重新產生圖示，在 `app/` 執行：

```powershell
npm run tauri -- icon icon.png
```

此命令只做格式與尺寸轉換，不會修改原圖內容。重新打包後，新圖示會嵌入執行檔及安裝程式。

## 專案結構

- `app/src/`：TypeScript 介面、歌詞同步與樣式。
- `app/src-tauri/src/`：Spotify 授權／播放、歌詞來源、SQLite 與個人設定。
- `app/src-tauri/tauri.conf.json`：視窗、App 名稱、圖示與 NSIS 打包設定。

## 授權

[MIT License](LICENSE) © 2026 Eccentric Studio
