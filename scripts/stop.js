#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const dataDir = process.env.PLUGIN_DATA || __dirname;
const pidPath = path.join(dataDir, 'codex-discord-presence.pid');
if (!fs.existsSync(pidPath)) {
  console.log('Codex Discord Presence is not running.');
  process.exit(0);
}

const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
try {
  process.kill(pid, 'SIGTERM');
} catch (error) {
  if (error.code !== 'ESRCH') throw error;
}
fs.rmSync(pidPath, { force: true });
console.log('Codex Discord Presence stopped.');
