# Codex Discord Presence

在 Discord 桌面版開啟時，這個本機常駐程式會偵測 `Codex.exe`，並顯示「Using Codex」的 Rich Presence。它不會讀取或傳送提示、檔案名稱或聊天內容；預設會將目前專案資料夾的名稱顯示到 Discord。

[隱私權政策](PRIVACY.md) · [服務條款](TERMS.md)

授權條款：[MIT License](LICENSE)

## 安裝

在已登入 GitHub 的終端機執行：

```powershell
codex plugin marketplace add mushroomTW/codex-discord-presence
```

接著在 Codex 的 Plugins 畫面安裝並啟用 **Codex Discord Presence**，首次使用時審核並信任它的 Hook。重新開啟或恢復一個 Codex 工作階段後，Discord Presence 會自動啟動。

## 設定

1. 在 <https://discord.com/developers/applications> 建立一個 Application，例如命名為 `Codex`。
2. 複製該 Application 的 **Application ID**。
3. 將 ID 貼入 `scripts/config.json` 的 `clientId`。
4. 在 Codex 安裝並啟用本外掛，然後審核並信任其 Hook。
5. 開啟或恢復 Codex 工作階段時，外掛會自動啟動 Discord Rich Presence。

## 控制

- 停止：`powershell -ExecutionPolicy Bypass -File .\scripts\stop.ps1`
- 查看狀態：`node .\scripts\codex-discord-presence.js --status`

程式由 Codex Hook 自動啟動，每 8 秒檢查一次 Codex 是否在執行；偵測到後會更新 Discord 狀態，關閉 Codex 後會清除活動。

## 可調整文字

編輯 `scripts/config.json` 的 `details`、`state` 與 `projectLabel`。將 `showProject` 設為 `false` 可停止顯示專案名稱。任何設定變更都需要先停止再重新啟動常駐程式。

## 限制

Discord Rich Presence 必須使用你自己的 Discord Application ID，因此第一次設定無法省略。Discord 與 Codex 需以相同權限執行（兩者都不要以系統管理員身分開啟）。
