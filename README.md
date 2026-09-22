# Hakuro

Windows 桌面歌詞播放器：跟隨 Spotify 或 YouTube Music 正在播放的歌曲，搜尋原文歌詞、同步高亮，並把下載過的歌詞存入 SQLite。介面使用英文，以 Tauri 2、Rust 與 TypeScript 實作。

## 開始使用

1. 從 [Releases](https://github.com/scream870102/hakuro/releases) 下載 `*-setup.exe` 安裝，或把可攜版 `hakuro.exe` 放在你有寫入權限的資料夾。
2. 開啟 Hakuro，點 **Settings**，在 **Player** 選擇要跟隨的播放器。一次只跟隨一個，隨時可以切換。

### Spotify

3. 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 取得自己的 App **Client ID**，加入 Redirect URI：`http://127.0.0.1:8787/callback`。建立 App 與帳號資格限制以 [官方說明](https://developer.spotify.com/documentation/web-api/concepts/apps) 為準。
4. 在 **Spotify Client ID** 填入 Client ID 並儲存。只填 ID，不要加上 `SPOTIFY_CLIENT_ID=`。
5. 依畫面提示連線，在瀏覽器完成 Spotify 授權，然後在 Spotify 播放音樂。

App 使用 PKCE 授權。Redirect URI 必須完全一致，請勿改成 `localhost`；詳見 [Spotify Redirect URI 規則](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)。

### YouTube Music

3. 選好之後直接儲存，不需要 Client ID、不需要授權、不需要另外安裝程式。
4. 在瀏覽器或桌面版播放 YouTube Music，Hakuro 就會跟上。

YouTube Music 沒有「目前播放」的 API，所以 Hakuro 讀的是 Windows 系統媒體工作階段（SMTC）——也就是播放器本來就會告訴 Windows 的曲名、演出者、專輯、長度與播放位置。已知限制：

- 瀏覽器不會在播放過程中更新播放位置，Hakuro 依系統回報的時間戳推算。暫停、續播、拖動進度、切歌都會重新校準。
- 瀏覽器的所有分頁共用同一個媒體工作階段識別，所以另一個分頁在播影片時可能被誤認。這點尚未處理。
- 轉存控制（播放、暫停、上下一首、拖動）依播放器實際開放的項目啟用，播放器不支援時按鈕會停用。

## 歌詞與設定

- 點目前顯示的**歌詞來源按鈕**，可選擇這首歌偏好的來源，或回到自動搜尋。每首歌的選擇會保存在 SQLite。
- **Refresh lyrics** 會略過快取、重新向來源取得目前歌曲的歌詞；來源選擇控制搜尋對象，兩者可同時使用。
- **Settings** 可調整全域歌詞來源順序與啟用狀態。支援 LRCLIB、PetitLyrics、Musixmatch、NetEase、QQ Music。
- 歌詞快取依播放來源分開存放，Spotify 與 YouTube Music 不會互相讀到對方的結果。
- **Settings** 可設定按鈕與控制項的強調色、目前歌詞的高亮色、已唱過歌詞的顏色。
- **Follow lyrics** 控制是否自動捲動至目前歌詞；有時間軸時會隨播放位置高亮，純文字歌詞不會猜測時間。

SQLite 保留成功下載的歌詞，重新開啟 App 仍可使用。來源可能因網路、地區、限流或服務變更而無法提供結果；有同步歌詞時優先呈現同步歌詞。搜尋會向來源傳送歌曲名稱、歌手等查詢資料，不會傳送 Spotify token。

## 資料位置與備份

所有 App 個人資料都與 `hakuro.exe` 放在同一資料夾：

| 檔案 | 內容 |
| --- | --- |
| `settings.json` | 播放器選擇、Client ID、全域來源偏好、配色與跟隨歌詞設定 |
| `lyrics.db` | 已下載歌詞與每首歌的來源偏好 |
| `lyrics.db-wal`、`lyrics.db-shm` | SQLite 執行期間可能產生的輔助檔 |
| `session.bin` | 經 Windows DPAPI 加密的 Spotify refresh token；只跟隨 YouTube Music 時不會產生 |

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
- `app/src-tauri/src/`：播放來源（`spotify.rs` 授權／播放、`smtc.rs` 系統媒體工作階段、`player.rs` 兩者的共同介面）、歌詞來源、SQLite 與個人設定。
- `app/src-tauri/tauri.conf.json`：視窗、App 名稱、圖示與 NSIS 打包設定。

### 發佈新版本

推一個 `v` 開頭的 tag 就會觸發 [`.github/workflows/release.yml`](.github/workflows/release.yml)：在 `windows-latest` 上建置 NSIS 安裝程式，並發佈成可下載的 GitHub Release。不需要手動上傳檔案。

Workflow 的第一步是拿 tag 比對 `app/src-tauri/tauri.conf.json` 的 `version`，不一致就直接失敗、不進建置。**這是唯一會被檢查、也是唯一決定安裝程式檔名的版號**，產物會是 `Hakuro_<version>_x64-setup.exe`。

#### 要更新的檔案

| 檔案 | 位置 | 怎麼改 | 不改會怎樣 |
| --- | --- | --- | --- |
| `app/src-tauri/tauri.conf.json` | `version` | 手動編輯 | **Workflow 直接失敗**，不會建置 |
| `app/src-tauri/Cargo.toml` | `[package]` 的 `version` | 手動編輯 | 照常建置，但 crate 版號與發佈版號對不上 |
| `app/src-tauri/Cargo.lock` | `hakuro` 套件條目 | 不必手改，改完 `Cargo.toml` 跑任一 cargo 指令就會同步 | 下次建置時自己被改掉，留下非預期的 diff |
| `app/package.json` | `version` | `npm version` | 照常建置，版號分歧而已 |
| `app/package-lock.json` | root 與 `packages[""]` 各一處 | 同上，`npm version` 會一起更新 | 同上 |

只有 `tauri.conf.json` 會擋下建置。其餘四個不同步不會讓 CI 失敗（`package.json` 與 lockfile 的版號不一致並不影響 `npm ci`），但發出去的版本會對不上原始碼的版號，所以一併更新。

#### 步驟

工作目錄為 `app/`，以發佈 `1.2.0` 為例：

```powershell
# 1. 前端版號：package.json 與 package-lock.json 會一起更新
npm version 1.2.0 --no-git-tag-version

# 2. Rust 版號：手動把 src-tauri/Cargo.toml 的 version 改成 1.2.0，再同步 lockfile
cargo metadata --manifest-path src-tauri/Cargo.toml --format-version 1 | Out-Null

# 3. 手動把 src-tauri/tauri.conf.json 的 version 改成 1.2.0
```

確認五個檔案的版號一致後，在專案根目錄提交、打 tag、推上去：

```powershell
git commit -am "chore: Bump version to 1.2.0"
git tag v1.2.0
git push
git push origin v1.2.0
```

tag 必須是 `v` 加上版號，`1.2.0` 對應 `v1.2.0`。推上 tag 後在 GitHub 的 Actions 分頁看建置結果，成功後 Release 會自動出現。

## 授權

[MIT License](LICENSE) © 2026 Eccentric Studio
