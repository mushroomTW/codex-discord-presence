#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const scriptDir = __dirname;
const dataDir = process.env.PLUGIN_DATA || scriptDir;
const pidPath = path.join(dataDir, 'codex-discord-presence.pid');

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

fs.mkdirSync(dataDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(path.join(scriptDir, 'config.json'), 'utf8'));
if (!/^\d{17,20}$/.test(String(config.clientId || ''))) {
  throw new Error('請先在 scripts/config.json 填入 Discord Application ID（clientId）。');
}

if (fs.existsSync(pidPath)) {
  const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
  if (Number.isInteger(pid) && isRunning(pid)) {
    console.log('Codex Discord Presence is already running.');
    process.exit(0);
  }
  fs.rmSync(pidPath, { force: true });
}

const child = childProcess.spawn(process.execPath, [path.join(scriptDir, 'codex-discord-presence.js')], {
  cwd: scriptDir,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, PLUGIN_DATA: dataDir },
  windowsHide: true
});
child.unref();
console.log('Codex Discord Presence started.');
