#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWorkspaceCwd, pruneSessions, readSessions, writeJsonAtomic } = require('./session-state');

const scriptDir = __dirname;
const dataDir = process.env.CODEX_PRESENCE_DATA || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'codex-discord-presence'
);
const sessionsPath = path.join(dataDir, 'active-sessions.json');
const updateOnly = process.argv.includes('--update');
const startDaemon = !updateOnly || process.argv.includes('--start');
fs.mkdirSync(dataDir, { recursive: true });

function removeLegacyStartupEntry() {
  const file = process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'codex-discord-presence.cmd')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.mushroomtw.codex-discord-presence.plist')
      : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'codex-discord-presence.desktop');
  fs.rmSync(file, { force: true });
}

if (!updateOnly) removeLegacyStartupEntry();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const events = input.trim().split(/\r?\n/).reverse();
    const session = events
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .find((event) => event && typeof (event.cwd ?? event.payload?.cwd ?? event.context?.cwd) === 'string');
    const cwd = session?.cwd ?? session?.payload?.cwd ?? session?.context?.cwd;
    const sessionId = session?.session_id ?? session?.sessionId ?? session?.id;
    const transcriptPath = session?.transcript_path ?? session?.transcriptPath ?? session?.payload?.transcript_path;
    if (isWorkspaceCwd(cwd)) {
      const activeSession = {
        id: typeof sessionId === 'string' && sessionId ? sessionId : transcriptPath || cwd,
        projectName: path.basename(cwd),
        cwd,
        sessionId: typeof sessionId === 'string' ? sessionId : null,
        transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null,
        lastActiveAt: Date.now()
      };
      const sessions = pruneSessions(readSessions(sessionsPath))
        .filter((entry) => entry?.id !== activeSession.id).slice(-19);
      sessions.push(activeSession);
      writeJsonAtomic(sessionsPath, sessions);
      writeJsonAtomic(path.join(dataDir, 'active-project.json'), activeSession);
    }
  } catch {
    // 無法取得 Hook 輸入時，常駐程式會改由工作階段紀錄推測專案名稱。
  }

  if (startDaemon) {
    childProcess.spawn(process.execPath, [path.join(scriptDir, 'start.js')], {
      cwd: scriptDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CODEX_PRESENCE_DATA: dataDir },
      windowsHide: true
    }).unref();
  }
});
process.stdin.resume();
