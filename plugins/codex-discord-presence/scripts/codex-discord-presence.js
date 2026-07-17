#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { isFreshSession, isWorkspaceCwd, readSessions, selectActiveSession } = require('./session-state');
const { isOwnedDaemon, readDaemonState, removeDaemonState, writeDaemonState } = require('./daemon-state');
const { createRotatingLogger } = require('./shared/logger');
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
const MAX_IPC_FRAME_SIZE = 1024 * 1024;
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
const HOST_CHECK_INTERVAL_MS = 1_000;
const HOST_MISSING_LIMIT = 3;
const WINDOWS_HOST_IMAGE_NAMES = ['codex.exe'];
const daemonStartedAt = Date.now();
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

function discordIpcPaths(index) {
  if (process.platform === 'win32') return [`\\\\?\\pipe\\discord-ipc-${index}`];
  const directories = process.platform === 'linux'
    ? [process.env.XDG_RUNTIME_DIR, '/tmp']
    : ['/tmp'];
  return directories.filter(Boolean).map((directory) => path.join(directory, `discord-ipc-${index}`));
}

function pluginIsEnabled() {
  // 外掛可能有多個安裝來源區段（例如 @personal 與 marketplace 版）；
  // 任一區段未明確寫入 enabled = false 即視為啟用，全部停用時 daemon 才自我終止。
  // 逐行判斷而非整段 regex，避免 TOML 格式差異（空行、鍵順序）造成誤判。
  try {
    const config = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
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
    return !sawSection || anyEnabled;
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
    const lines = (stat.size > bytes ? text.slice(text.indexOf('\n') + 1) : text).split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (!lines[index]) continue;
      try {
        const item = JSON.parse(lines[index]);
        if (item.id === sessionId && typeof item.thread_name === 'string' && item.thread_name) {
          title = item.thread_name;
          break;
        }
      } catch {
        // 索引最後一行可能正由 Codex 寫入，略過不完整紀錄。
      }
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

function writeFrame(socket, opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  socket.cork();
  socket.write(header);
  socket.write(body);
  socket.uncork();
}

function truncate(value, maximumLength) {
  return String(value).slice(0, maximumLength);
}

class DiscordRpc {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  connect() {
    if (this.socket || !this.clientId) return;
    const tryPipe = (index) => {
      if (index > 9) {
        this.scheduleReconnect();
        return;
      }
      const paths = discordIpcPaths(index);
      const tryPath = (pathIndex) => {
        if (pathIndex >= paths.length) {
          tryPipe(index + 1);
          return;
        }
        const socket = net.createConnection(paths[pathIndex]);
        let settled = false;
        socket.once('connect', () => {
          settled = true;
        this.socket = socket;
        this.buffer = Buffer.alloc(0);
        socket.on('data', (data) => this.onData(data));
        socket.on('close', () => this.reset());
        socket.on('error', () => this.reset());
        writeFrame(socket, 0, { v: 1, client_id: this.clientId });
          log(`已連線至 Discord IPC #${index}`);
        });
        socket.once('error', () => {
          if (!settled) tryPath(pathIndex + 1);
        });
      };
      tryPath(0);
    };
    tryPipe(0);
  }

  reset() {
    this.socket = null;
    this.ready = false;
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * (2 ** this.reconnectAttempt));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  onData(data) {
    if (data.length > MAX_IPC_FRAME_SIZE + 8 || this.buffer.length > MAX_IPC_FRAME_SIZE + 8 - data.length) {
      log(`Discord IPC 接收緩衝超過上限：${data.length}`);
      this.buffer = Buffer.alloc(0);
      this.socket?.destroy();
      return;
    }
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (length < 0 || length > MAX_IPC_FRAME_SIZE) {
        log(`Discord IPC 訊框長度無效：${length}`);
        this.socket?.destroy();
        return;
      }
      if (this.buffer.length < 8 + length) return;
      let payload;
      try {
        payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
      } catch (error) {
        log(`Discord IPC 訊框無法解析：${error.message}`);
        this.socket?.destroy();
        return;
      }
      this.buffer = this.buffer.subarray(8 + length);
      if (opcode === 2) {
        log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
        this.socket?.destroy();
        return;
      }
      if (payload.evt === 'READY') {
        this.ready = true;
        this.lastActivityFingerprint = null;
        this.reconnectAttempt = 0;
        log('Discord Rich Presence 已就緒');
      } else if (payload.evt === 'ERROR') {
        log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
      }
    }
  }

  setActivity(activity) {
    if (!this.ready || !this.socket || this.socket.destroyed) return;
    const fingerprint = JSON.stringify(activity);
    if (this.lastActivityFingerprint === fingerprint) return;
    this.lastActivityFingerprint = fingerprint;
    writeFrame(this.socket, 1, {
      cmd: 'SET_ACTIVITY',
      nonce: crypto.randomUUID(),
      args: { pid: process.pid, activity }
    });
  }

  clearActivity() {
    this.lastActivityFingerprint = null;
    this.setActivity(null);
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.lastActivityFingerprint = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) {
      // 移除監聽器避免 close 事件觸發自動重連。
      socket.removeAllListeners('close');
      socket.removeAllListeners('error');
      socket.on('error', () => {});
      socket.destroy();
    }
  }
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
const rpc = new DiscordRpc(config.clientId);
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
let configMtimeMs = 0;
let lastBrokerActivity = null;
let lastBrokerActivityLabel = null;
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
  // Broker 的狀態 TTL 為 3 秒；每秒重新評估可避免沒有檔案事件時活動過期閃爍。
  brokerHeartbeatTimer = setInterval(() => tick(), 1_000);
}

function isWindowsHostRunning() {
  for (const imageName of WINDOWS_HOST_IMAGE_NAMES) {
    const result = childProcess.spawnSync('tasklist', ['/NH', '/FO', 'CSV', '/FI', `IMAGENAME eq ${imageName}`], {
      encoding: 'utf8',
      timeout: 500,
      windowsHide: true
    });
    if (result.error || result.status !== 0) return null;
    if (result.stdout.toLocaleLowerCase().includes(`"${imageName.toLocaleLowerCase()}"`)) return true;
  }
  return false;
}

function checkHostProcess() {
  const running = isWindowsHostRunning();
  if (running === null) return;
  if (running) {
    consecutiveMissingHostChecks = 0;
    return;
  }
  consecutiveMissingHostChecks += 1;
  if (consecutiveMissingHostChecks >= HOST_MISSING_LIMIT) {
    log('連續 3 秒找不到 Codex Desktop 宿主程序，daemon 自動關閉。');
    shutdown();
  }
}

function startHostMonitor() {
  if (process.platform !== 'win32' || hostProcessTimer) return;
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
    fs.writeFileSync(diagnosticPath, JSON.stringify({ updatedAt: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
  } catch (error) {
    log(`無法寫入活動診斷快照：${error.message}`);
  }
}

function findActivity(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 'Waiting';
  try {
    const stat = fs.statSync(transcriptPath);
    const bytes = Math.min(stat.size, 65_536);
    const buffer = Buffer.alloc(bytes);
    const descriptor = fs.openSync(transcriptPath, 'r');
    try {
      fs.readSync(descriptor, buffer, 0, bytes, stat.size - bytes);
    } finally {
      fs.closeSync(descriptor);
    }
    return classifyActivity(buffer.toString('utf8'));
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
  if (Date.now() - lastSessionSignalAt() > DAEMON_IDLE_SHUTDOWN_MS) {
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
  const buttons = config.showRepositoryButton === false || !repositoryUrl
    ? undefined
    : [{ label: truncate(config.repositoryButtonLabel || 'View Repository', 32), url: repositoryUrl }];
  // Discord 對 details 與 state 的長度上限為 128 字元。
  const activity = {
    details: truncate(projectName
      ? `${truncate(config.projectLabel || 'Workspace', 64)}: ${projectName}${activityLabel ? ` · ${activityLabel}` : ''}`
      : `${String(config.details)}${activityLabel ? ` · ${activityLabel}` : ''}`, 128),
    state: truncate(taskTitle ? `Task: ${taskTitle}` : String(config.taskTitleFallback || config.state), 128),
    ...(config.showElapsedTime === false ? {} : { timestamps: { start: startedAt } }),
    instance: false,
    buttons
  };
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
tick();
scheduleOptionalPoll();
startBrokerHeartbeat();
startHostMonitor();
