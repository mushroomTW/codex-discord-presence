# Privacy Policy

Last updated: July 16, 2026

Codex Discord Presence runs locally on your device. It does not operate a remote service and does not collect, transmit, sell, or share personal data.

## Local data used

- `scripts/config.json`, containing the bundled Discord Application ID and display preferences.
- The Codex process state, used only to determine whether Codex is running.
- The active project folder name when project display is enabled. Full project paths and project contents are not sent to Discord.
- A local PID file and log file used to manage and diagnose the presence service.

## Discord communication

The plugin sends the configured Rich Presence details to the local Discord desktop application's IPC socket. No prompts, conversation content, source files, or project contents are sent.

## Contact

For privacy questions, open an issue in this repository.
