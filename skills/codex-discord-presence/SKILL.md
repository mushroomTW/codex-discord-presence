---
name: codex-discord-presence
description: 協助使用者設定、啟動、停止或診斷 Codex Discord Rich Presence。
---

# Codex Discord Presence

本外掛由本機常駐程式透過 Discord IPC 顯示 Rich Presence。它只根據 `Codex.exe` 是否執行決定是否顯示，不讀取專案名稱、檔案名稱、提示或聊天內容。

## 操作

- 外掛已內建 Discord Application ID；使用者不需要到 Discord Developer Portal 建立 Application。
- 啟動：執行 `node ./scripts/start.js`。
- 停止：執行 `node ./scripts/stop.js`。
- 開機／登入後自動啟動：執行 `node ./scripts/install-startup.js`。
- 此外掛僅使用 Node.js 與 Discord IPC，支援 Windows、macOS 與 Linux。
- 診斷：查看 `scripts/codex-discord-presence.log`，並確認 Discord 桌面版已開啟。

## 注意

Discord 和 Codex 必須以相同權限執行；若其中一個以系統管理員身分開啟，IPC 可能無法連線。使用者更改 `config.json` 後需重啟常駐程式。
