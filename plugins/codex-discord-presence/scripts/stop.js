#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { stopLegacyDaemon, stopOwnedDaemon } = require('./daemon-state');

const dataDir = process.env.PLUGIN_DATA || __dirname;
const daemonScript = path.join(__dirname, 'codex-discord-presence.js');
const sessionsPath = path.join(dataDir, 'active-sessions.json');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let sessionId = null;
  try {
    const event = JSON.parse(input.trim().split(/\r?\n/).pop());
    sessionId = event?.session_id ?? event?.sessionId ?? event?.id ?? event?.transcript_path ?? event?.payload?.transcript_path ?? event?.cwd;
  } catch {}
  if (sessionId) {
    try {
      const sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
      const remaining = Array.isArray(sessions) ? sessions.filter((entry) => entry?.id !== sessionId) : [];
      fs.writeFileSync(sessionsPath, JSON.stringify(remaining), 'utf8');
      if (remaining.length > 0) {
        console.log('Codex Discord Presence 保持執行，仍有其他活動工作階段。');
        return;
      }
    } catch {}
  }
  const stopped = stopOwnedDaemon(dataDir) || stopLegacyDaemon(dataDir, daemonScript);
  console.log(stopped ? 'Codex Discord Presence stopped.' : 'Codex Discord Presence is not running.');
});
process.stdin.resume();
