# Codex Discord Presence

<p align="center">
  <img src="plugins/codex-discord-presence/assets/discord-wumpus-icon-transparent.png" alt="Discord Wumpus" width="220">
</p>

Show a local Discord Rich Presence while the Codex desktop app is running. The plugin does not read or upload prompts, project contents, or chat messages. It can optionally show the current project folder name.

[Privacy Policy](PRIVACY.md) · [Terms of Service](TERMS.md) · [MIT License](LICENSE)

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

- Start: `node ./plugins/codex-discord-presence/dist/start.js`
- Stop: `node ./plugins/codex-discord-presence/dist/stop.js`
- Status: `node ./plugins/codex-discord-presence/dist/codex-discord-presence.js --status`
- Start at sign-in: `node ./plugins/codex-discord-presence/dist/install-startup.js`
- Remove sign-in startup: `node ./plugins/codex-discord-presence/dist/uninstall-startup.js`

The plugin uses Node.js and Discord IPC only. It supports Windows, macOS, and Linux.

## Configuration

Edit `scripts/config.json` inside the installed plugin directory, then restart the presence service.

### Project name

```json
{
  "showProject": true,
  "projectLabel": "Workspace"
}
```

- Set `showProject` to `true` to show the project folder name.
- Set it to `false` to show the configured fallback status instead.
- Change `projectLabel` to customize the prefix.

### Repository button

```json
{
  "showRepositoryButton": true,
  "repositoryButtonLabel": "View Repository",
  "repositoryUrl": "https://github.com/mushroomTW/codex-discord-presence"
}
```

Set `showRepositoryButton` to `false` to hide the button. Access to a private repository still requires GitHub permission.

## Notes

Run Discord and Codex with the same privileges. On Linux and macOS, use the Discord desktop app and ensure the current user can access the Discord IPC socket.
