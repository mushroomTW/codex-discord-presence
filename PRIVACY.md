# 隱私權政策

生效日：2026 年 7 月 16 日

Codex Discord Presence（以下稱「本外掛」）僅在你的電腦上運作，用於在 Discord 顯示 Codex 的 Rich Presence。

## 本外掛處理的資料

本外掛僅會：

- 偵測 `Codex.exe` 是否正在執行。
- 讀取最近活躍 Codex 工作階段的本機工作目錄，並僅將最後一層資料夾名稱作為 Discord 活動狀態顯示。
- 讀取你本機的 `scripts/config.json`，其中包含 Discord Application ID 與顯示文字。
- 在 Codex 外掛資料目錄建立 PID 與日誌檔。
- 透過本機 Discord IPC 將活動狀態傳送給已登入的 Discord 桌面版。
- 若啟用儲存庫按鈕，將設定的 GitHub 儲存庫 URL 提供給 Discord 作為活動連結。

## 不會收集或傳送的資料

本外掛不會讀取、儲存或傳送提示、聊天內容、程式碼、檔案名稱、完整專案路徑、帳號密碼、API 金鑰或分析資料。它不會將資料傳送給外掛作者的伺服器。若啟用預設設定，專案資料夾名稱會透過 Discord IPC 顯示給 Discord。

Discord 對 Rich Presence 資料的處理，仍受 [Discord 隱私權政策](https://discord.com/privacy) 規範。

## 資料控制與刪除

你可以在 Codex 停用或移除本外掛，或停止其背景程序，以停止活動更新。刪除 Codex 外掛資料目錄中的 PID 與日誌檔即可移除本機執行紀錄。

## 政策更新

本政策若有重大更新，會透過此儲存庫發布。繼續使用本外掛即表示你接受更新後的政策。
