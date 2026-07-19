#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { isFreshSession, isWorkspaceCwd, readSessions, selectActiveSession } = require('./session-state');
const { isOwnedDaemon, readDaemonState, removeDaemonState, writeDaemonState } = require('./daemon-state');
const { createRotatingLogger } = require('./shared/logger');
const { DiscordRpc: SharedDiscordRpc } = require('./shared/discord-rpc');
const { buildPresence, truncate } = require('./shared/presence-builder');
const { classifyActivity } = require('./activity-classifier');

const scriptDir = __dirname;
const dataDir = process.env.CODEX_PRESENCE_DATA || path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'mushroomTW',
  'codex-discord-presence'
);
fs.mkdirSync(dataDir, { recursive: true });
// 純 JavaScript 執行檔與設定檔都位於 scripts/。
const configPath = path.join(scriptDir, 'config.json');
const logPath = path.join(dataDir, 'codex-discord-presence.log');
const diagnosticPath = path.join(dataDir, 'codex-discord-presence.diagnostic.json');
const CONTEXT_SCAN_INTERVAL_MS = 30_000;
const MAX_SESSION_INDEX_READ_BYTES = 512 * 1024;
const scriptPath = path.resolve(__filename);
const brokerStateDir = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'mushroomTW',
  'discord-presence-broker'
);
const brokerHeartbeatPath = path.join(brokerStateDir, 'broker.json');
const brokerScriptPath = path.join(scriptDir, 'broker.js');
const BROKER_STALE_MS = 15_000;
// Codex 若被強制關閉（當機、工作管理員結束）不會觸發 SessionEnd hook。
// Windows 會額外監看 Codex Desktop 宿主，並以 session 訊號閒置時間作為跨平台保底。
const DAEMON_IDLE_SHUTDOWN_MS = 2 * 60 * 60 * 1000;
const HOST_CHECK_INTERVAL_MS = 10_000;
const HOST_MISSING_LIMIT = 3;
// 開機後 Codex Desktop 可能尚未完成程序註冊；先保留 daemon，避免一次性的 SessionStart hook 被競速吃掉。
const HOST_STARTUP_GRACE_MS = 60_000;
const WINDOWS_HOST_IMAGE_NAMES = ['codex.exe'];
const daemonStartedAt = Date.now();
const hostMonitorStartedAt = Date.now();
const instanceToken = process.argv
  .find((argument) => argument.startsWith('--instance-token='))
  ?.slice('--instance-token='.length);

let repositoryCache = { cwd: null, url: null };
let taskTitleCache = { sessionId: null, title: null, expiresAt: 0 };

function readConfig() {
  const defaults = { clientId: '', details: 'Using Codex', state: 'Vibe coding', pollIntervalMs: 0, showActivity: true, showElapsedTime: true, useBroker: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...defaults, ...parsed };
  } catch (error) {
    throw new Error(`無法讀取 config.json：${error.message}`);
  }
}

const log = createRotatingLogger(logPath);

let pluginEnabledCache = { mtimeMs: null, value: true };

function pluginIsEnabled() {
  // 外掛可能有多個安裝來源區段（例如 @personal 與 marketplace 版）；
  // 任一區段未明確寫入 enabled = false 即視為啟用，全部停用時 daemon 才自我終止。
  // 逐行判斷而非整段 regex，避免 TOML 格式差異（空行、鍵順序）造成誤判。
  try {
    const configTomlPath = path.join(os.homedir(), '.codex', 'config.toml');
    // 以 mtime 快取解析結果，避免每次 tick 都重讀並逐行掃描整份設定。
    const mtimeMs = fs.statSync(configTomlPath).mtimeMs;
    if (mtimeMs === pluginEnabledCache.mtimeMs) return pluginEnabledCache.value;
    const config = fs.readFileSync(configTomlPath, 'utf8');
    let sawSection = false;
    let inPluginSection = false;
    let sectionDisabled = false;
    let anyEnabled = false;
    const closeSection = () => {
      if (inPluginSection && !sectionDisabled) anyEnabled = true;
    };
    for (const line of config.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.startsWith('[')) {
        closeSection();
        inPluginSection = /^\[plugins\."codex-discord-presence@[^"]+"\]$/i.test(trimmed);
        if (inPluginSection) {
          sawSection = true;
          sectionDisabled = false;
        }
      } else if (inPluginSection && /^enabled\s*=\s*false\s*(?:#.*)?$/i.test(trimmed)) {
        sectionDisabled = true;
      }
    }
    closeSection();
    pluginEnabledCache = { mtimeMs, value: !sawSection || anyEnabled };
    return pluginEnabledCache.value;
  } catch {
    return true;
  }
}

function findActiveWorkspace() {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', '.codex-global-state.json'), 'utf8'));
    const cwd = Array.isArray(state['active-workspace-roots']) ? state['active-workspace-roots'][0] : null;
    if (!isWorkspaceCwd(cwd)) return null;
    const labels = state['electron-workspace-root-labels'];
    const name = labels && typeof labels[cwd] === 'string' && labels[cwd]
      ? labels[cwd]
      : path.basename(cwd);
    return { name, cwd };
  } catch {
    return null;
  }
}

function findTaskTitle(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  if (taskTitleCache.sessionId === sessionId && taskTitleCache.expiresAt > Date.now()) return taskTitleCache.title;
  let title = null;
  try {
    const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
    const stat = fs.statSync(indexPath);
    const bytes = Math.min(stat.size, MAX_SESSION_INDEX_READ_BYTES);
    const buffer = Buffer.alloc(bytes);
    const descriptor = fs.openSync(indexPath, 'r');
    try {
      fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const text = buffer.toString('utf8');
    // 尾端讀取可能截到半行；第一個換行之前的殘缺紀錄不納入搜尋範圍。
    const lowerBound = stat.size > bytes ? text.indexOf('\n') + 1 : 0;
    // 直接從尾端搜尋 sessionId 出現位置，只解析可能命中的行，
    // 避免把整段 512KB 切成數千個行字串與逐行 JSON.parse。
    let searchEnd = text.length;
    while (searchEnd > lowerBound) {
      const hit = text.lastIndexOf(sessionId, searchEnd - 1);
      if (hit < lowerBound) break;
      const lineStart = Math.max(text.lastIndexOf('\n', hit) + 1, lowerBound);
      const newlineAfterHit = text.indexOf('\n', hit);
      const lineEnd = newlineAfterHit === -1 ? text.length : newlineAfterHit;
      try {
        const item = JSON.parse(text.slice(lineStart, lineEnd));
        if (item.id === sessionId && typeof item.thread_name === 'string' && item.thread_name) {
          title = item.thread_name;
          break;
        }
      } catch {
        // 索引最後一行可能正由 Codex 寫入，略過不完整紀錄。
      }
      searchEnd = lineStart - 1;
    }
  } catch {
    // 索引暫時無法讀取時，保留設定檔中的預設備註。
  }
  taskTitleCache = { sessionId, title, expiresAt: Date.now() + CONTEXT_SCAN_INTERVAL_MS };
  return title;
}

function findLatestProject() {
  try {
    const activeSession = selectActiveSession(readSessions(path.join(dataDir, 'active-sessions.json')));
    if (activeSession) {
      return {
        name: typeof activeSession.projectName === 'string' && activeSession.projectName ? activeSession.projectName : path.basename(activeSession.cwd),
        cwd: activeSession.cwd,
        sessionId: typeof activeSession.sessionId === 'string' ? activeSession.sessionId : null,
        transcriptPath: typeof activeSession.transcriptPath === 'string' ? activeSession.transcriptPath : null
      };
    }
  } catch {}
  const activeWorkspace = findActiveWorkspace();
  if (activeWorkspace) return activeWorkspace;
  try {
    const project = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-project.json'), 'utf8'));
    // 回退檔也必須通過新鮮度檢查，避免永久顯示過期的 Workspace。
    if (typeof project.projectName === 'string' && project.projectName && isFreshSession(project)) {
      return {
        name: project.projectName,
        cwd: project.cwd,
        sessionId: typeof project.sessionId === 'string' ? project.sessionId : null
      };
    }
  } catch {}
  return null;
}

function findGitHubRepository(cwd) {
  if (repositoryCache.cwd === cwd) return repositoryCache.url;
  const result = childProcess.spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.error || result.status !== 0) {
    repositoryCache = { cwd, url: null };
    return null;
  }

  const remote = result.stdout.trim();
  const url = remote
    .replace(/^git@github\.com:/i, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//i, 'https://github.com/')
    .replace(/\.git$/i, '');
  repositoryCache = { cwd, url: /^https:\/\/github\.com\//i.test(url) ? url : null };
  return repositoryCache.url;
}

function status() {
  const state = readDaemonState(dataDir);
  const running = Boolean(state && isOwnedDaemon(state));
  console.log(running ? '常駐程式正在執行。' : '常駐程式未執行。');
  try {
    console.log(JSON.stringify(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')), null, 2));
  } catch {
    console.log('尚未取得活動診斷快照。');
  }
}

if (process.argv.includes('--status')) {
  status();
  process.exit(0);
}

if (!instanceToken || instanceToken.length < 16) {
  console.error('請使用 start.js 啟動 Discord Presence。');
  process.exit(1);
}

let config = readConfig();
if (!/^\d{17,20}$/.test(config.clientId)) {
  console.error('外掛內建的 Discord Application ID 無效，請重新安裝外掛。');
  process.exit(1);
}

const daemonState = { pid: process.pid, instanceToken, scriptPath };
writeDaemonState(dataDir, daemonState);
const rpc = new SharedDiscordRpc(config.clientId, { log });
let active = false;
let startedAt = null;
let dataDirWatcher = null;
let codexStateWatcher = null;
let configWatcher = null;
let scheduledTick = null;
let optionalPollTimer = null;
let brokerHeartbeatTimer = null;
let hostProcessTimer = null;
let consecutiveMissingHostChecks = 0;
let hostProcessKnownRunning = null;
let configMtimeMs = 0;
let lastBrokerActivity = null;
let lastBrokerActivityLabel = null;
let lastDiagnosticSnapshot = null;
let activityCache = { transcriptPath: null, mtimeMs: 0, size: 0, value: 'Waiting' };
let lastUseBroker = null;
let brokerSpawnedAt = 0;

function isBrokerAlive() {
  try {
    const heartbeat = JSON.parse(fs.readFileSync(brokerHeartbeatPath, 'utf8'));
    return Date.now() - Number(heartbeat.updatedAt || 0) < BROKER_STALE_MS;
  } catch {
    return false;
  }
}

function ensureBroker() {
  if (config.useBroker === false || isBrokerAlive()) return;
  if (Date.now() - brokerSpawnedAt < BROKER_STALE_MS) return;
  brokerSpawnedAt = Date.now();
  try {
    childProcess.spawn(process.execPath, [brokerScriptPath], {
      cwd: scriptDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }).unref();
    log('已啟動共享 Discord Presence Broker。');
  } catch (error) {
    log(`無法啟動共享 Broker：${error.message}`);
  }
}

function publishBrokerState(activity, activityLabel) {
  lastBrokerActivity = activity;
  lastBrokerActivityLabel = activityLabel;
  fs.mkdirSync(brokerStateDir, { recursive: true });
  const priority = ({ 'Running tools': 5, Editing: 4, Thinking: 3, 'Reading results': 2, Waiting: 1 })[activityLabel] || 1;
  fs.writeFileSync(path.join(brokerStateDir, 'codex.json'), JSON.stringify({
    source: 'codex',
    clientId: config.clientId,
    priority,
    updatedAt: Date.now(),
    activity
  }), 'utf8');
}

function clearBrokerState() {
  lastBrokerActivity = null;
  lastBrokerActivityLabel = null;
  try { fs.rmSync(path.join(brokerStateDir, 'codex.json'), { force: true }); } catch {}
}

function clearPublishedActivity() {
  if (config.useBroker !== false) clearBrokerState();
  else rpc.clearActivity();
}

function refreshConfig() {
  try {
    const mtimeMs = fs.statSync(configPath).mtimeMs;
    if (mtimeMs === configMtimeMs) return;
    config = readConfig();
    configMtimeMs = mtimeMs;
    scheduleOptionalPoll();
    log('已重新載入 Discord Presence 設定。');
  } catch (error) {
    log(`無法重新載入設定，保留上一份有效設定：${error.message}`);
  }
}

function scheduleTick() {
  if (scheduledTick) return;
  scheduledTick = setTimeout(() => {
    scheduledTick = null;
    tick();
  }, 100);
}

function optionalPollIntervalMs() {
  const value = Number(config.pollIntervalMs);
  return Number.isFinite(value) && value > 0 ? Math.max(500, value) : 0;
}

function scheduleOptionalPoll() {
  if (optionalPollTimer) {
    clearTimeout(optionalPollTimer);
    optionalPollTimer = null;
  }
  const intervalMs = optionalPollIntervalMs();
  if (!intervalMs) return;
  optionalPollTimer = setTimeout(() => {
    optionalPollTimer = null;
    tick();
    scheduleOptionalPoll();
  }, intervalMs);
}

function startBrokerHeartbeat() {
  if (brokerHeartbeatTimer) return;
  // Broker 以狀態檔 mtime 判定 TTL；只 touch 檔案可避免每秒重寫相同 JSON。
  brokerHeartbeatTimer = setInterval(() => {
    if (config.useBroker !== false && lastBrokerActivity) {
      const statePath = path.join(brokerStateDir, 'codex.json');
      try {
        const now = new Date();
        fs.utimesSync(statePath, now, now);
      } catch {
        publishBrokerState(lastBrokerActivity, lastBrokerActivityLabel);
      }
      ensureBroker();
    }
  }, 1_000);
}

let hostCheckInFlight = false;

// tasklist 查詢可能耗時 50–300ms；以非同步執行避免阻塞事件迴圈，
// 讓 timer 與 fs.watch 回呼不受宿主檢查影響。
function queryWindowsHostRunning(imageIndex, callback) {
  if (imageIndex >= WINDOWS_HOST_IMAGE_NAMES.length) return callback(false);
  const imageName = WINDOWS_HOST_IMAGE_NAMES[imageIndex];
  childProcess.execFile('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${imageName}`], {
    timeout: 2_000,
    windowsHide: true
  }, (error, stdout) => {
    if (error) return callback(null);
    if (String(stdout).toLocaleLowerCase().includes(`"${imageName.toLocaleLowerCase()}"`)) return callback(true);
    queryWindowsHostRunning(imageIndex + 1, callback);
  });
}

function checkHostProcess() {
  if (hostCheckInFlight) return;
  hostCheckInFlight = true;
  queryWindowsHostRunning(0, (running) => {
    hostCheckInFlight = false;
    if (running === null) return;
    if (running) {
      hostProcessKnownRunning = true;
      consecutiveMissingHostChecks = 0;
      return;
    }
    if (Date.now() - hostMonitorStartedAt < HOST_STARTUP_GRACE_MS) return;
    hostProcessKnownRunning = false;
    consecutiveMissingHostChecks += 1;
    if (consecutiveMissingHostChecks >= HOST_MISSING_LIMIT) {
      log('連續 3 次檢查找不到 Codex Desktop 宿主程序，daemon 自動關閉。');
      shutdown();
    }
  });
}

function startHostMonitor() {
  if (process.platform !== 'win32' || hostProcessTimer) return;
  checkHostProcess();
  hostProcessTimer = setInterval(checkHostProcess, HOST_CHECK_INTERVAL_MS);
}

function lastSessionSignalAt() {
  let latest = daemonStartedAt;
  const candidates = [
    path.join(dataDir, 'active-sessions.json'),
    path.join(dataDir, 'active-project.json'),
    path.join(os.homedir(), '.codex', '.codex-global-state.json')
  ];
  for (const candidate of candidates) {
    try {
      const mtimeMs = fs.statSync(candidate).mtimeMs;
      if (mtimeMs > latest) latest = mtimeMs;
    } catch {}
  }
  return latest;
}

function startWatchers() {
  if (!dataDirWatcher) {
    try {
      dataDirWatcher = fs.watch(dataDir, (_eventType, filename) => {
        if (!filename || filename === 'active-project.json' || filename === 'active-sessions.json') scheduleTick();
      });
    } catch {}
  }
  if (!codexStateWatcher) {
    try {
      codexStateWatcher = fs.watch(path.join(os.homedir(), '.codex'), (_eventType, filename) => {
        if (filename === 'session_index.jsonl' || filename === '.codex-global-state.json') {
          taskTitleCache.expiresAt = 0;
          scheduleTick();
        }
      });
    } catch {}
  }
  if (!configWatcher) {
    try {
      configWatcher = fs.watch(scriptDir, (_eventType, filename) => {
        if (filename === 'config.json') scheduleTick();
      });
    } catch {}
  }
}

function writeDiagnostic(snapshot) {
  try {
    const serialized = JSON.stringify(snapshot);
    if (serialized === lastDiagnosticSnapshot) return;
    lastDiagnosticSnapshot = serialized;
    fs.writeFileSync(diagnosticPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
  } catch (error) {
    log(`無法寫入活動診斷快照：${error.message}`);
  }
}

function findActivity(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 'Waiting';
  try {
    const stat = fs.statSync(transcriptPath);
    if (activityCache.transcriptPath === transcriptPath
      && activityCache.mtimeMs === stat.mtimeMs
      && activityCache.size === stat.size) return activityCache.value;
    const bytes = Math.min(stat.size, 65_536);
    const buffer = Buffer.alloc(bytes);
    const descriptor = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    const value = classifyActivity(buffer.toString('utf8'));
    activityCache = { transcriptPath, mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  } catch {
    return 'Working';
  }
}

function tick() {
  startWatchers();
  refreshConfig();
  const useBroker = config.useBroker !== false;
  if (lastUseBroker === true && !useBroker) {
    // 從 Broker 模式切回直連時，立即撤下 Broker 端的舊狀態。
    clearBrokerState();
  }
  lastUseBroker = useBroker;
  if (!useBroker) {
    if (!rpc.ready) rpc.connect();
  } else {
    if (rpc.socket || rpc.reconnectTimer) rpc.disconnect();
    ensureBroker();
  }
  if (!pluginIsEnabled()) {
    clearPublishedActivity();
    removeDaemonState(dataDir, daemonState);
    setTimeout(() => process.exit(0), 250);
    return;
  }
  if (hostProcessKnownRunning !== true && Date.now() - lastSessionSignalAt() > DAEMON_IDLE_SHUTDOWN_MS) {
    log(`超過 ${Math.round(DAEMON_IDLE_SHUTDOWN_MS / 60_000)} 分鐘沒有收到任何 Codex session 訊號，判定 Codex 已關閉，daemon 自動關閉。`);
    shutdown();
    return;
  }
  // 與 Claude 外掛一致：daemon 由 Codex 工作階段 Hook 啟動，存活期間必須至少顯示泛用活動。
  // Windows 宿主監看僅決定 daemon 是否結束；查詢失敗時保守維持這個泛用活動。
  if (!active) {
    active = true;
    startedAt = Math.floor(Date.now() / 1000);
    log('Codex Discord Presence daemon 已啟動，正在更新 Discord 活動。');
  }
  const project = findLatestProject();
  const workspaceEnabled = config.showWorkspace ?? config.showProject !== false;
  const projectName = workspaceEnabled === false
    ? null
    : truncate(config.workspaceName || project?.name || '', 60);
  const taskTitle = config.showTaskTitle === false
    ? null
    : String(config.taskTitle || findTaskTitle(project?.sessionId) || '');
  const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
  const activityLabel = config.showActivity === false ? null : findActivity(project?.transcriptPath);
  // Discord 對 details 與 state 的長度上限為 128 字元。
  const activity = buildPresence({
    details: projectName
      ? `${truncate(config.projectLabel || 'Workspace', 64)}: ${projectName}${activityLabel ? ` · ${activityLabel}` : ''}`
      : `${truncate(config.details, 110)}${activityLabel ? ` · ${activityLabel}` : ''}`,
    state: taskTitle ? `Task: ${taskTitle}` : String(config.taskTitleFallback || config.state),
    startedAt,
    showElapsedTime: config.showElapsedTime !== false,
    repositoryUrl: config.showRepositoryButton === false ? null : repositoryUrl,
    repositoryButtonLabel: config.repositoryButtonLabel
  });
  if (config.useBroker !== false) publishBrokerState(activity, activityLabel);
  else rpc.setActivity(activity);
  writeDiagnostic({
    activeProject: projectName || null,
    sessionId: project?.sessionId || null,
    title: taskTitle || null,
    activity: activityLabel,
    titleSource: taskTitle ? 'session_index' : 'fallback',
    sessionIndexWatched: Boolean(codexStateWatcher),
    updateMode: 'file-watch with optional fallback poll'
  });
}

function shutdown() {
  dataDirWatcher?.close();
  codexStateWatcher?.close();
  configWatcher?.close();
  if (scheduledTick) clearTimeout(scheduledTick);
  if (optionalPollTimer) clearTimeout(optionalPollTimer);
  if (brokerHeartbeatTimer) clearInterval(brokerHeartbeatTimer);
  if (hostProcessTimer) clearInterval(hostProcessTimer);
  clearPublishedActivity();
  removeDaemonState(dataDir, daemonState);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (config.useBroker === false) rpc.connect();
else ensureBroker();
startHostMonitor();
tick();
scheduleOptionalPoll();
startBrokerHeartbeat();
