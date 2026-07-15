---
name: codex-discord-presence
description: Configure, start, stop, or diagnose Codex Discord Rich Presence.
---

# Codex Discord Presence

## Operations

- The bundled Discord Application ID is used automatically; users do not need to create a Discord Application.
- Start: `node ./dist/start.js`
- Stop: `node ./dist/stop.js`
- Enable sign-in startup: `node ./dist/install-startup.js`
- Diagnose: inspect `codex-discord-presence.log` and confirm that the Discord desktop app is running.

## Notes

- On Windows, run Discord and Codex with the same privileges.
- On macOS and Linux, use the Discord desktop app and ensure the current user can access its IPC socket.
- The service only communicates through local Discord IPC and does not consume model tokens.
