# Hakuro

Windows 桌面歌詞播放器：跟隨 Spotify 或 YouTube Music（透過 ytmdesktop2）正在播放的歌曲，搜尋原文歌詞、同步高亮，並把下載過的歌詞存入 SQLite。介面使用英文，以 Tauri 2、Rust 與 TypeScript 實作。

## 開始使用

1. 從 [Releases](https://github.com/scream870102/hakuro/releases) 下載 `*-setup.exe` 安裝，或把可攜版 `hakuro.exe` 放在你有寫入權限的資料夾。
2. 開啟 Hakuro，點 **Settings**，在 **Player** 選擇要跟隨的播放器。一次只跟隨一個，隨時可以切換。

### Spotify

3. 在 [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) 取得自己的 App **Client ID**，加入 Redirect URI：`http://127.0.0.1:8787/callback`。建立 App 與帳號資格限制以 [官方說明](https://developer.spotify.com/documentation/web-api/concepts/apps) 為準。
4. 在 **Spotify Client ID** 填入 Client ID 並儲存。只填 ID，不要加上 `SPOTIFY_CLIENT_ID=`。
5. 依畫面提示連線，在瀏覽器完成 Spotify 授權，然後在 Spotify 播放音樂。

App 使用 PKCE 授權。Redirect URI 必須完全一致，請勿改成 `localhost`；詳見 [Spotify Redirect URI 規則](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri)。

### YouTube Music (ytmdesktop2)

3. 安裝並開啟 [ytmdesktop2](https://github.com/Venipa/ytmdesktop2)（第三方開源 YouTube Music 桌面版，與 Hakuro 無關），在它的 Settings → API & Integrations → API 開啟 API。預設埠為 `13091`。
4. Hakuro 的 **Player** 選 **YouTube Music (ytmdesktop2)**；埠號不同時填入 **ytmdesktop2 API port**（9999–39999），然後儲存。
5. 若 ytmdesktop2 開啟了 Require authorization，Hakuro 連線時狀態列會顯示配對碼；請在 30 秒內到 ytmdesktop2 的 Settings → API & Integrations → Authentication 核准 Hakuro。核准後的 token 以 Windows DPAPI 加密存在 `ytmd-session.bin`，之後不必再配對；在 ytmdesktop2 撤銷後，按 Reconnect 重新配對。

ytmdesktop2 會告訴 Hakuro 目前歌曲的 YouTube 影片 ID，所以不必靠曲名猜歌：

- YouTube Music 原生歌詞直接依影片 ID 讀取。MV 本身沒有同步歌詞時（MV 常只有純文字或沒有歌詞），會改讀它在歌曲目錄中的對應版本：ytmdesktop2 有提供就直接用，否則以同一原生藝人、相同標題與相近時長確認。都沒有同步歌詞才改用搜尋，最後才依設定順序查其他來源。MV 的演出者名稱可能被翻成介面語言（例如「酷玩樂團」），這套確認方式不依賴名稱。
- 播放位置、暫停狀態、上下一首、拖動與音量環都直接透過 ytmdesktop2 的本機 API。
- ytmdesktop2 的 YouTube Music 頁面還沒載入完成時，播放控制與音量讀取不會有回應，Hakuro 會顯示提示並繼續等待。

舊版的 **YouTube Music (media session)**（讀 Windows 系統媒體工作階段）已移除；設定裡存著它的話，開啟後會自動改為 ytmdesktop2，其餘設定保留。

## 介面

播放控制做在一顆可以抓住旋轉的方塊上（Cube Deck）；拖動方塊可以轉到其他面，放開後會停在最近的一面。

- **正面是專輯封面**：彩色代表播放中、灰階代表暫停。點一下封面切換播放／暫停，游標下的透鏡會預覽另一種狀態；游標移到封面上時，左右兩側會出現上一首／下一首。拖動封面只會轉動方塊，不會切換播放。
- **右側是音量環**：沿著環拖動調整音量，滾輪也可以。
- **頂部是唱片**：點一下切換播放／暫停；轉動唱片可以快轉或倒轉，一圈約 10 秒，放開時才送出一次跳轉。游標移到唱片上時，中央會出現**播放佇列**按鈕。
- **背面與左側是工具面**：SOURCE／FIND／RELOAD 與 FOLLOW／PIN／MINI。FOLLOW 與 RELOAD 只在工具面和指令面板，其餘也是頁首或歌詞區的按鈕。
- **進度列右端是播放／暫停**：以圖示顯示目前按下去會做的事，始終顯示，不會隨閒置隱藏。左邊是**隨機**與**循環**（僅 Spotify）。
- **播放佇列**：點唱片中央的佇列鈕（精簡模式在頂部，或指令面板的 **Queue…**），會在主視窗旁開啟一塊傾斜的佇列面板；再按一次即關閉，也可按 `Esc` 或 ×。面板列出正在播放的歌與接下來的歌，在換歌、切換隨機、面板取得焦點或按 **REFRESH** 時重新讀取。
  - Spotify：點任一首就跳到那首，面板頂部也有隨機與循環。Spotify 沒有「播放佇列中某一首」的 API，所以 Hakuro 以連續的「下一首」跳過去，被跳過的歌會出現在 Spotify 的最近播放裡。跳轉、隨機與循環都需要 Spotify Premium。
  - ytmdesktop2：只列出曲名，不能跳轉。
- **隨機與循環**（僅 Spotify）：循環依 關 → 全部 → 單曲 切換，Spotify 當下不允許的項目會略過。ytmdesktop2 無法事先讀出目前的隨機與循環狀態，所以不提供這兩個按鈕。
- **波動**：方塊下方鋪著一圈小方塊，隨整台電腦正在播放的聲音起伏，從方塊往外擴散；低音在方塊後方、高音在前方，前方的方塊壓低高度，不會擋住方塊。**Settings → Sound wave** 可分別開關完整模式與精簡模式（預設都開），指令面板也能切換。聲音取自 Windows 預設播放裝置的 loopback，只在本機計算頻譜，不錄音、不傳送；沒有播放裝置時地板保持靜止，裝置接上後自動開始。系統開啟「減少動態效果」時不擷取聲音。
- **指令面板**：按 `Ctrl+K` 或頁首的 **COMMANDS** 開啟，常用功能都在裡面，中英文都能搜尋；輸入一段歌詞可以直接跳到那一行。面板是獨立視窗，不受主視窗大小限制（精簡模式下也完整顯示）；按 `Esc`、點面板旁邊或切到其他視窗即關閉。
- **自訂快捷鍵**：指令面板裡的每個指令都能綁定快捷鍵。在 Settings 展開 Keyboard shortcuts（預設收合，依面板分組列出），點選功能旁的按鍵欄，再按組合鍵即可綁定；支援清除及恢復預設。新增綁定預設只在主視窗生效，勾選 Global 才會在其他程式中生效。按 Save settings 後立即套用並保存；重複綁定或全域按鍵遭占用會提示錯誤。原有命令選單 `Ctrl+K` 與滑鼠穿透恢復鍵 `Ctrl+Alt+P` 保留，後者預設為全域。快捷鍵沿用播放器可用的功能。
- **設定**、**Find lyrics** 與**歌詞來源**都是獨立視窗，置頂時也會顯示在主視窗上方，按 `Esc` 或右上角 × 關閉。調整背景透明度與歌詞大小時，主視窗會即時預覽；取消或直接關閉設定視窗會還原成已儲存的設定。Find lyrics 與歌詞來源只針對開啟時正在播放的那首歌，換歌時會自動關閉。
- 頁首左上角是 App 圖示的線稿，顏色跟隨強調色。
- **精簡模式**：整個視窗只有一顆方塊，沒有背景。正面是封面，點一下切換播放／暫停，游標移上去時兩側出現上一首／下一首；頂部是控制鈕（歌詞、置頂、回到完整模式，以及佇列／隨機／循環）；右側書背直書歌名與歌手；左側是音量環；背面是 SOURCE／FIND／RELOAD／SETTINGS。按歌詞鈕方塊會向右拉長，正面在封面旁顯示三行歌詞，頂部在控制鈕右邊顯示歌名、歌手與進度（只顯示，不能拖動跳轉）；開關狀態會記住。置頂時方塊邊緣亮起強調色。視窗大小依 Lyric size (compact)、歌詞面板與波動開關自動決定，不能手動縮放。有翻譯的行會縮小原文與行距，騰出空間給下方譯文；沒有翻譯或關閉翻譯時維持原字級，切歌與切換翻譯都不會改變視窗大小。拖動方塊旁的空白處可以移動視窗。
- 背景的三角形碎片會各自緩慢漂移、旋轉；系統開啟「減少動態效果」時保持靜止。
- 設定視窗右上角顯示目前版本。介面字型（Anton、JetBrains Mono、Noto Sans JP）隨 App 打包，離線也能顯示。

## 歌詞與設定

- **音量環**控制 Spotify 目前播放裝置或 ytmdesktop2 播放器的音量（0–100%），放開、停止捲動或以鍵盤提交時才送出調整，沿用既有授權。裝置不支援時會停用。Spotify 音量 API 的帳戶要求依 [官方文件](https://developer.spotify.com/documentation/web-api/reference/set-volume-for-users-playback) 為準。
- 點目前顯示的**歌詞來源按鈕**，可選擇這首歌偏好的來源，或回到自動搜尋。每首歌的選擇會保存在 SQLite。
- **Find lyrics** 可在已啟用的 LRCLIB、NetEase、QQ Music 搜尋其他曲名／歌手；Settings 的 **Player** 選擇 YouTube Music (ytmdesktop2) 時，會另外提供原生 YouTube Music 搜尋，不需額外啟用來源。查看候選與歌詞預覽後，以 **Use these lyrics** 綁定目前這首歌。手動匹配會跨重啟保存；**Restore automatic** 可取消綁定，恢復自動搜尋。切換這首歌的來源也會取代手動匹配。
- **RELOAD** 會略過快取、重新向來源取得目前歌曲的歌詞；來源選擇控制搜尋對象，兩者可同時使用。
- 有手動匹配時，重新整理會取得所選候選的歌詞；清除下載快取仍會保留手動匹配。
- **Settings** 可調整 LRCLIB、PetitLyrics、Musixmatch、NetEase、QQ Music 的全域歌詞來源順序與啟用狀態。
- Settings 的 **Player** 選擇 YouTube Music (ytmdesktop2) 時，自動搜尋會先嘗試 YouTube Music 原生同步歌詞；只有純文字、取不到或請求失敗時，會依設定順序繼續尋找其他來源的同步歌詞，仍找不到才保留純文字。原生歌詞不占用全域來源列表，也不需另外勾選。此時單曲來源選擇與 **Find lyrics** 也會提供 YouTube Music；選擇 Spotify 播放器時不提供此來源。單曲指定來源或手動匹配仍依使用者選擇。
- YouTube Music 原生歌詞先依 ytmdesktop2 提供的影片 ID 直接讀取；讀不到時才以歌名、歌手與時長尋找對應歌曲。歌曲搜尋沒有可用結果時，會再搜尋 MV，處理曲名與 YouTube 雙語標題不一致的情況，仍要求歌手與時長符合。取得對應歌曲後讀取逐行或純文字歌詞；不需登入 Google，播放控制仍走所選播放器。其內部介面可能變動，逐字與雙語資料不保證提供。
- MV 只有純文字時，可透過原生藝人 ID、標題（雙語標題取原文）與已知時長，確認歌曲目錄中的對應版本並讀取其同步歌詞。不會憑文字順序猜時間，也不會只因歌名相似就套用其他版本；無法確認時保留純文字或繼續查其他來源。
- 歌詞快取依播放來源分開存放，Spotify 與 ytmdesktop2 不會互相讀到對方的結果。
- **Settings** 可設定強調色（方塊光暈、進度列、背景色帶，預設螢光黃 `#e6ff1f`）、目前歌詞的高亮色、已唱過歌詞的顏色。
- **Follow lyrics** 控制是否自動捲動至目前歌詞；有時間軸時會隨播放位置高亮，純文字歌詞不會猜測時間。
- 來源提供逐字時間時，會跟隨播放位置突出目前的字詞；沒有逐字資料就維持逐行高亮。PetitLyrics 與 NetEase 可提供逐字資料，實際覆蓋依歌曲而異。
- 來源提供翻譯時，譯文會顯示在原文下方；搜尋視窗的 **Show translations when available** 與指令面板可切換本次開啟 App 的顯示。翻譯依時間戳對齊，不會自行翻譯歌曲或把無法對齊的文字硬套到原文上。

SQLite 保留成功下載的歌詞，重新開啟 App 仍可使用。來源可能因網路、地區、限流或服務變更而無法提供結果；有同步歌詞時優先呈現同步歌詞。搜尋會向來源傳送歌曲名稱、歌手等查詢資料，不會傳送 Spotify token。

## 資料位置與備份

所有 App 個人資料都與 `hakuro.exe` 放在同一資料夾：

| 檔案 | 內容 |
| --- | --- |
| `settings.json` | 播放器選擇、Client ID、ytmdesktop2 API 埠號、全域來源偏好、配色、跟隨歌詞、波動開關與快捷鍵設定 |
| `lyrics.db` | 已下載歌詞、逐字時間與翻譯，以及每首歌的來源偏好和手動匹配 |
| `lyrics.db-wal`、`lyrics.db-shm` | SQLite 執行期間可能產生的輔助檔 |
| `session.bin` | 經 Windows DPAPI 加密的 Spotify refresh token；只跟隨 YouTube Music 時不會產生 |
| `ytmd-session.bin` | 經 Windows DPAPI 加密的 ytmdesktop2 配對 token；ytmdesktop2 不要求授權時不會產生 |

請使用可寫入的資料夾，例如自己的文件資料夾；不要把可攜版放進唯讀目錄或 `Program Files`。備份或搬移前先關閉 App，再複製整個資料夾。`session.bin` 與 `ytmd-session.bin` 綁定 Windows 使用者，不能當成跨帳號／跨電腦登入憑證；搬到其他環境後請重新授權或配對。

分享程式時只分享乾淨的執行檔或安裝程式，不要附上個人設定、資料庫、`session.bin` 或 `ytmd-session.bin`。

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
- `app/src-tauri/src/`：播放來源（`spotify.rs` 授權／播放／佇列、`ytmdesktop.rs` ytmdesktop2 本機 API 與配對、`player.rs` 兩者的共同介面）、`visualizer.rs` 系統聲音的頻譜（波動用）、歌詞來源、SQLite 與個人設定。
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
