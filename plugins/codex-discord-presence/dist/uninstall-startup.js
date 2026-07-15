#!/usr/bin/env node
// @ts-nocheck
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const file = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'codex-discord-presence.cmd')
    : process.platform === 'darwin'
        ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.mushroomtw.codex-discord-presence.plist')
        : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'codex-discord-presence.desktop');
fs.rmSync(file, { force: true });
console.log('Codex Discord Presence startup entry removed.');
