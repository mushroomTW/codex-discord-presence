#!/usr/bin/env node
// @ts-nocheck
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const script = path.join(__dirname, 'start.js');
const node = process.execPath;

if (process.platform === 'win32') {
  const startupDir = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  fs.mkdirSync(startupDir, { recursive: true });
  fs.writeFileSync(path.join(startupDir, 'codex-discord-presence.cmd'), `@echo off\r\n"${node}" "${script}"\r\n`, 'utf8');
} else if (process.platform === 'darwin') {
  const directory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = path.join(directory, 'com.mushroomtw.codex-discord-presence.plist');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.mushroomtw.codex-discord-presence</string><key>ProgramArguments</key><array><string>${node}</string><string>${script}</string></array><key>RunAtLoad</key><true/></dict></plist>\n`, 'utf8');
} else {
  const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'codex-discord-presence.desktop'), `[Desktop Entry]\nType=Application\nName=Codex Discord Presence\nExec=${JSON.stringify(node)} ${JSON.stringify(script)}\nX-GNOME-Autostart-enabled=true\n`, 'utf8');
}

console.log('Codex Discord Presence will start when you sign in.');
