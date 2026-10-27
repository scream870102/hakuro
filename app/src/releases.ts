export interface Release {
  version: string;
  date: string;
  title: string;
  changes: string[];
}

/** Bundled history, newest first by chronology (not numeric version).
 * Official 1.x dates/features follow git tags; 1.6.0 follows f4e93b6.
 * Before 230347f restarted numbering at 1.0.0, product versions were 4.0.0
 * (6f7e238) and 3.0.0 (6bc8871). The latter's Cargo-only 0.1.0 was never the
 * app version. Earlier Python snapshots have no recorded version number. */
export const releases: readonly Release[] = [
  {
    version: "1.8.0", date: "2026-10-27", title: "自動更新",
    changes: [
      "有新版本時，Hakuro 會在背景下載並驗證安裝檔，下載完成才跳出通知，不必再自己到 GitHub 下載。",
      "通知中選「立即更新」會安裝並重新啟動；選「稍後」則在關閉 Hakuro 時自動安裝，不會重新開啟。",
      "安裝失敗時，通知會改提供 GitHub Release 連結。可在 Settings → Updates 關閉啟動時檢查更新。",
      "1.7.0 以前的版本需手動安裝一次 1.8.0，之後的版本才會自動更新。",
    ],
  },
  {
    version: "1.7.0", date: "2026-10-27", title: "簡體歌詞轉繁體",
    changes: [
      "新增「簡體歌詞轉繁體」設定，位於 Settings → Lyrics search order，預設關閉。開啟後，下載歌詞時會把簡體歌詞與翻譯轉成繁體並存入本機，只在下載時轉換一次；日文歌詞不會被轉換。",
      "已存的歌詞維持原樣，可用 Reload lyrics 重新下載並轉換。",
      "隨 App 打包 Noto Sans TC 與 Noto Sans SC：日文字型缺少的中文字，改用同系列、同粗細的字型顯示，不再忽粗忽細。",
    ],
  },
  {
    version: "1.6.2", date: "2026-10-21", title: "一致的圖示，自訂搖一搖",
    changes: [
      "主畫面、Compact 模式、Queue 與 Command Palette 的相同動作使用一致的圖示；Compact 歌詞改用對話框加文字線。",
      "搖一搖可綁定任一 Command Palette 動作，或選擇不綁定。新設定預設為 Random queue track；升級時保留原本的開關選擇。",
      "快速來回轉動方塊後放開，執行綁定動作並回到目前模式的預設角度。",
    ],
  },
  {
    version: "1.6.1", date: "2026-10-21", title: "讓方塊替你選一首歌",
    changes: [
      "點一下音量環中央即可切換靜音，移入游標會顯示對應圖示。播放器不支援靜音時，改為切換 0%／100% 音量。",
      "快速來回轉動方塊，就能從接下來的 Queue 隨機選一首播放。在設定中開啟此手勢；預設關閉，只適用於支援 Queue 點播的播放器。",
      "Command Palette 新增隨機播放 Queue 歌曲的指令，不必開啟手勢也能使用。",
      "新增獨立的 What's new 立體視窗，每個版本首次開啟時顯示更新內容。可從設定或 Command Palette 重看，也能展開舊版本的說明。",
    ],
  },
  {
    version: "1.6.0", date: "2026-10-21", title: "加入 ytmdesktop",
    changes: [
      "新增 ytmdesktop 播放器，與 ytmdesktop2 並存；在設定中選擇要跟隨的播放器，兩者各自保留配對與歌詞快取。",
      "ytmdesktop 支援播放控制、進度拖動、音量、循環與 Shuffle queue，讓你直接打亂播放佇列。",
      "ytmdesktop 的 Queue 顯示封面、歌手與時長，可直接點播，也支援 Automix 項目與佇列更新。",
      "支援 YouTube Music 原生歌詞、歌曲／MV 對應與手動搜尋歌詞。",
    ],
  },
  {
    version: "1.5.4", date: "2026-10-20", title: "讓輕聲的音樂也看得見",
    changes: [
      "改善低音量與多聲道裝置的聲波反應，安靜的音樂也能帶動方塊下的波動。",
      "移除唱片單點的播放／暫停，保留旋轉預覽與放開後跳轉，減少誤觸。",
    ],
  },
  {
    version: "1.5.3", date: "2026-10-20", title: "精簡模式更乾淨",
    changes: ["修正收起精簡歌詞後仍出現歌詞碎片的問題，切換版面時也會清除殘留碎片。"],
  },
  {
    version: "1.5.2", date: "2026-10-20", title: "精簡控制與更新提醒",
    changes: [
      "可透過 Command Palette 或自訂快捷鍵開關精簡歌詞；展開後的側面唱片支援進度預覽與跳轉。",
      "封面移入游標時顯示播放／暫停圖示，讓下一步操作更清楚。",
      "新增啟動時檢查更新，可在設定關閉；有新版本時提供 GitHub Release 連結。",
    ],
  },
  {
    version: "1.5.1", date: "2026-10-20", title: "翻譯留白與自由快捷鍵",
    changes: [
      "調整精簡歌詞的行高與翻譯間距，避免文字被裁切或進度列遮住。",
      "Command Palette 的各項功能都能綁定快捷鍵；設定中的快捷鍵依功能分組並可摺疊。",
    ],
  },
  {
    version: "1.5.0", date: "2026-10-20", title: "精簡歌詞翻譯與播放控制",
    changes: [
      "精簡模式加入歌詞翻譯，切歌或開關翻譯時維持方塊大小。",
      "新增立體 Queue 視窗；Spotify 可點播佇列歌曲，並提供隨機與循環控制。",
      "新增隨系統音樂起伏的方塊聲波，可分別設定完整與精簡模式是否顯示。",
    ],
  },
  {
    version: "1.4.1", date: "2026-10-20", title: "唱片進度預覽",
    changes: ["旋轉唱片時可預覽目標時間與歌詞，放開後才跳轉播放位置。"],
  },
  {
    version: "1.4.0", date: "2026-10-20", title: "直接跟隨 ytmdesktop2",
    changes: ["YouTube Music 改用 ytmdesktop2 連線，直接取得歌曲與播放狀態，支援本機播放控制。"],
  },
  {
    version: "1.3.2", date: "2026-10-20", title: "更準確的歌曲比對",
    changes: ["改善 YouTube Music 藝人名稱使用介面語言時的歌詞比對。"],
  },
  {
    version: "1.3.1", date: "2026-10-20", title: "更新精簡模式外觀",
    changes: [
      "精簡模式改為透明方塊，可向右展開三行歌詞，並依歌詞字級調整大小。",
      "新增自訂快捷鍵，可選擇只在 Hakuro 生效或設為全域快捷鍵。",
      "加入 YouTube Music 原生歌詞與搜尋，並改善歌曲／MV 對應。",
    ],
  },
  {
    version: "1.3.0", date: "2026-10-19", title: "Cube Deck 登場",
    changes: [
      "以可拖動旋轉的 Cube Deck 重新設計介面，加入音量控制並改善歌詞搜尋。",
      "設定、歌詞搜尋與來源選擇改為獨立視窗。",
    ],
  },
  {
    version: "1.2.2", date: "2026-10-09", title: "修正精簡版面",
    changes: ["修正精簡模式的樣式問題。"],
  },
  {
    version: "1.2.1", date: "2026-10-05", title: "改善 Musixmatch 比對",
    changes: ["改善 Musixmatch 已對應到目前 Spotify 歌曲時的歌詞選擇。"],
  },
  {
    version: "1.2.0", date: "2026-10-02", title: "多語言歌詞搜尋",
    changes: ["擴充多語言搜尋，改善不同語言曲名與歌手的歌詞查找。"],
  },
  {
    version: "1.1.1", date: "2026-09-29", title: "減少重複請求",
    changes: ["減少連線時不必要的重複請求。"],
  },
  {
    version: "1.1.0", date: "2026-09-22", title: "開始支援 YouTube Music",
    changes: ["新增透過 Windows 媒體工作階段跟隨 YouTube Music 的支援；後續版本改為直接連線 ytmdesktop2。"],
  },
  {
    version: "1.0.0", date: "2026-09-22", title: "Hakuro 正式版本起點",
    changes: [
      "正式發行版號從 1.0.0 重新開始，早期開發版本保留在下方供回顧。",
      "跟隨 Spotify 顯示同步歌詞，提供歌詞來源設定與本機快取。",
      "提供視窗置頂、精簡模式與 Windows 安裝程式。",
    ],
  },
  {
    version: "4.0.0", date: "2026-09-22", title: "早期開發版本：Hakuro 命名與設定",
    changes: [
      "此為正式 1.0.0 之前使用的早期版號。應用程式更名為 Hakuro，加入專屬圖示與 Windows 安裝程式。",
      "加入歌詞來源選擇與設定，可保存配色、歌詞跟隨偏好與來源順序。",
      "下載的歌詞與每首歌的來源偏好保存在本機，重新整理時可重新下載歌詞。",
    ],
  },
  {
    version: "3.0.0", date: "2026-09-22", title: "早期開發版本：Spotify Original Lyrics",
    changes: [
      "此為正式 1.0.0 之前使用的早期版號。從最初的桌面原型重新打造介面，跟隨 Spotify 顯示原文歌詞。",
      "支援同步高亮、自動跟隨與點選歌詞跳轉，也可控制播放／暫停、上一首與下一首。",
      "整合多個歌詞來源；重新開啟時可沿用已保存的登入。",
    ],
  },
];
