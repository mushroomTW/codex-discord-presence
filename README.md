# Codex Discord Presence

## Prerequisites

Before installing this plugin, install **Node.js LTS** (Node.js 20 or later is recommended), because the plugin hooks and Discord Presence daemon run through `node`. Verify the installation in a terminal:

```text
node --version
```

If the `node` command is not found, install Node.js and restart Codex.

<p align="center">
  <img src="plugins/codex-discord-presence/assets/discord-wumpus-icon-transparent.png" alt="Discord Wumpus" width="220">
</p>

Show a local Discord Rich Presence while the Codex desktop app is running. The plugin does not read or upload prompts, project contents, or chat messages. It can optionally show the active Codex workspace and task title.

[Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [MIT License](LICENSE)

## Example

![Discord Rich Presence showing the active workspace and task title](plugins/codex-discord-presence/assets/workspace-task-example.png)

## Install

Run these commands in a terminal authenticated with GitHub:

```sh
codex plugin marketplace add mushroomTW/codex-discord-presence
codex plugin add codex-discord-presence@codex-discord-presence
```

The first command adds the marketplace and the second installs the plugin. Trust the plugin Hook when prompted, then open or resume a Codex session.

## Setup

The plugin includes the Discord Application created by mushroomTW. Users do not need to create a Discord Application or provide an Application ID.

## Controls

- Start: `node ./plugins/codex-discord-presence/scripts/start.js`
- Stop: `node ./plugins/codex-discord-presence/scripts/stop.js`
- Status: `node ./plugins/codex-discord-presence/scripts/codex-discord-presence.js --status`

The plugin uses Node.js and Discord IPC only. It supports Windows, macOS, and Linux.

The Rich Presence service starts with a Codex session and stops when that session ends. The plugin does not create an operating-system startup entry, so it can be installed, disabled, and removed through Codex without leaving a startup task behind.

Codex stores Presence session data in a single shared local directory. Workspace is shown only for recent sessions whose workspace is not inside the user's home directory or Codex data directory. Otherwise, the plugin keeps a generic Presence and does not expose the Windows username.

## Configuration

Edit `scripts/config.json` inside the installed plugin directory, then restart the presence service.

Content updates are event-driven by default (`pollIntervalMs: 0`). Set `pollIntervalMs` to a positive millisecond value only when a filesystem watcher is unreliable and a fallback poll is needed.

`useBroker` defaults to `true`: Codex publishes its activity to the shared local Broker, which is the only process that connects to Discord IPC. The plugin bundles the Broker at `scripts/broker.js` and the daemon starts it automatically when no Broker heartbeat is present, so no manual step is required. The Broker enforces a single running instance, so Claude and Codex can both enable it safely. Set `useBroker` to `false` only for direct IPC mode.

This repository also includes a standalone copy of the Broker at `discord-presence-broker/broker.js` for running it manually with `node discord-presence-broker/broker.js`.

### Workspace and task title

```json
{
  "showWorkspace": true,
  "projectLabel": "Workspace",
  "workspaceName": "",
  "showTaskTitle": true,
  "taskTitle": "",
  "taskTitleFallback": "Vibe coding"
}
```

- Set `showWorkspace` to `true` to display the active workspace. Set it to `false` to use `details` instead.
- Change `projectLabel` to customize the prefix, for example `Workspace`.
- Set `workspaceName` to a non-empty value to override automatic workspace detection, for example `discord-codex`.
- Set `showTaskTitle` to `true` to display the active Codex task title. Set it to `false` to use the fallback text instead.
- Set `taskTitle` to a non-empty value to override automatic task-title detection.
- Change `taskTitleFallback` to customize the text shown when no task title is available.
- `showProject` remains supported as a legacy alias for `showWorkspace`.

### Repository button

```json
{
  "showRepositoryButton": true,
  "repositoryButtonLabel": "View Repository"
}
```

The button uses the current project's Git `origin` remote when it points to GitHub. Set `showRepositoryButton` to `false` to hide it. Projects without a GitHub `origin` remote do not show a button, and private repositories still require GitHub permission.

## Notes

Run Discord and Codex with the same privileges. On Linux and macOS, use the Discord desktop app and ensure the current user can access the Discord IPC socket.
