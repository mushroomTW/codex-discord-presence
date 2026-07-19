#!/usr/bin/env node
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireStartLock,
  getProcessCommandLine,
  isOwnedDaemon,
  readDaemonState,
  releaseStartLock,
  stopLegacyDaemon,
  stopOwnedDaemon,
  writeDaemonState
} = require('./daemon-state');

const scriptDir = __dirname;
const dataDir = process.env.CODEX_PRESENCE_DATA || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'codex-discord-presence'
);

function retireLegacyStateRoot() {
  // 舊版狀態根目錄含 mushroomTW 廠商層級；更新後主動終止舊 daemon 與舊 Broker 並清除舊目錄。
  const legacyRoot = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'mushroomTW'
  );
  const legacyDataDir = path.join(legacyRoot, 'codex-discord-presence');
  try {
    stopOwnedDaemon(legacyDataDir);
    stopLegacyDaemon(legacyDataDir, path.join(scriptDir, 'codex-discord-presence.js'));
  } catch {}
  try { fs.rmSync(legacyDataDir, { recursive: true, force: true }); } catch {}
  const legacyBrokerDir = path.join(legacyRoot, 'discord-presence-broker');
  try {
    // 舊 Broker 失去所有 producer 後不會自行退出，須由更新後的外掛終止。
    const state = JSON.parse(fs.readFileSync(path.join(legacyBrokerDir, 'broker.state.json'), 'utf8'));
    if (Number.isInteger(state.pid) && state.pid > 0 && /broker\.js/i.test(getProcessCommandLine(state.pid) || ''))
      process.kill(state.pid, 'SIGTERM');
  } catch {}
  try { fs.rmSync(legacyBrokerDir, { recursive: true, force: true }); } catch {}
  // 另一個外掛尚未更新時目錄非空，保留待其自行清理。
  try { fs.rmdirSync(legacyRoot); } catch {}
}
const configPath = path.join(scriptDir, 'config.json');

fs.mkdirSync(dataDir, { recursive: true });
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
if (!/^\d{17,20}$/.test(String(config.clientId || ''))) {
  throw new Error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
}

if (!acquireStartLock(dataDir)) {
  console.log('Codex Discord Presence is already starting.');
  process.exit(0);
}

try {
  const daemonScript = path.join(scriptDir, 'codex-discord-presence.js');
  if (!process.env.CODEX_PRESENCE_DATA) retireLegacyStateRoot();
  if (isOwnedDaemon(readDaemonState(dataDir))) {
    console.log('Codex Discord Presence is already running.');
    process.exit(0);
  }
  stopOwnedDaemon(dataDir);
  stopLegacyDaemon(dataDir, daemonScript);
  const instanceToken = crypto.randomUUID();
  const child = childProcess.spawn(process.execPath, [daemonScript, `--instance-token=${instanceToken}`], {
    cwd: scriptDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CODEX_PRESENCE_DATA: dataDir },
    windowsHide: true
  });
  if (!Number.isInteger(child.pid)) throw new Error('無法取得常駐程序的 PID。');
  try {
    writeDaemonState(dataDir, {
      pid: child.pid,
      instanceToken,
      scriptPath: path.resolve(daemonScript)
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  child.once('error', (error) => console.error(`無法啟動 Codex Discord Presence：${error.message}`));
  child.unref();
  console.log('Codex Discord Presence started.');
} finally {
  releaseStartLock(dataDir);
}
