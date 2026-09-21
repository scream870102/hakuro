# Spotify Original Lyrics

## 使用方式

1. 開啟 `dist` 資料夾，將你自己的 `secret.env` 放在 `SpotifyOriginalLyrics.exe` 旁邊。
2. 雙擊 `SpotifyOriginalLyrics.exe`，不需要安裝 Python 或執行 PowerShell。
3. 按 **Connect Spotify**，在瀏覽器完成授權，接著在 Spotify 播放歌曲。

`secret.env` 使用 UTF-8 純文字，可直接放一行 Client ID，或使用：

```dotenv
SPOTIFY_CLIENT_ID=你的ClientID
```

也接受 `CLIENT_ID` 或 `clientId`，可加成對引號。不要填 Client Secret。
缺少或格式錯誤時，app 會顯示提示；修正檔案後再次按 Connect Spotify 即可。
設定檔不內嵌於 EXE，也不會自動複製進發行檔；分享程式時請另行提供適合的 Client ID。

Spotify Developer app 的 Redirect URI 必須設為 `http://127.0.0.1:8787/callback`。
使用 PKCE，不需要 Client Secret。登入仍須符合 Spotify 對該開發者 app 的帳號權限限制。

## 歌詞來源與跟隨

依序查詢 **LRCLIB → NetEase → QQ Music**，優先採用歌名、歌手與長度相符的同步歌詞。
若前一來源只有純文字，會繼續找其他來源的時間軸；都沒有時間軸時保留純文字。
來源失敗會自動嘗試下一個，底部顯示實際來源及 Synced / Plain 模式。
NetEase 與 QQ Music 使用非官方公開端點，可能因地區或服務變動而暫時無法使用。
比對會統一繁簡與全形字，畫面歌詞不作翻譯或繁簡改寫；跨語言藝名／歌名仍可能找不到相符版本。

- 有 LRC 時間軸：依 Spotify 播放位置高亮目前句子，自動捲動。
- **Follow lyrics**：取消勾選即可手動閱讀；高亮仍會更新。
- **Reload Lyrics**：清除目前歌曲的記憶體快取並重新查詢。
- 暫停會停止推進；快轉、倒轉與切歌在下一次播放查詢後校正。
- 約每 1.5 秒查詢 Spotify，畫面每 0.1 秒更新；不是音訊分析或逐字卡拉 OK，會有 API 延遲。
- Spotify 連線失敗會暫停推進；來源歌詞時間本身不準時仍可能不同步。
- 無時間軸時顯示純文字，不自行猜測時間。

查詢會將歌曲名稱、歌手、專輯及長度送至歌詞來源，不傳 Spotify token 或 secret.env。
原文歌詞不翻譯、不變更 Spotify 歌名。
HTTPS 使用 Windows 憑證存放區，不停用 TLS 驗證。

## 開發者重新打包

以下指令僅供開發者；一般使用者只需 EXE 和自己的 `secret.env`。
在 Windows、Python 3.10+（包含 Tkinter）的建置環境中執行：

```text
python -m pip install -r requirements.txt PyInstaller==6.22.3
python -m unittest -v test_app test_sync test_lyrics_sources
python -m PyInstaller --noconfirm --onefile --windowed --name SpotifyOriginalLyrics --collect-data opencc app.py
```

輸出：`dist/SpotifyOriginalLyrics.exe`。不需 start.ps1 或其他啟動腳本。
建置方式參考 [PyInstaller 官方文件](https://pyinstaller.org/en/stable/usage.html)。

播放進度格式：[Spotify currently playing](https://developer.spotify.com/documentation/web-api/reference/get-the-users-currently-playing-track)。歌詞 API：[LRCLIB](https://lrclib.net/docs)。其他來源的 schema 參考見 lyrics_sources.py。
