#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { isWorkspaceCwd, readSessions, selectActiveSession } = require('./session-state');
const { isOwnedDaemon, readDaemonState, removeDaemonState, writeDaemonState } = require('./daemon-state');
const { createRotatingLogger } = require('./shared/logger');

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
  try {
    const config = fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
    return /^\[plugins\."codex-discord-presence@[^"\r\n]+"\]\s*\r?\n\s*enabled\s*=\s*true\s*$/mi.test(config);
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
    if (typeof project.projectName === 'string' && project.projectName && isWorkspaceCwd(project.cwd)) {
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

function readPidRecord() {
  try {
    const value = fs.readFileSync(pidPath, 'utf8').trim();
    const record = value.startsWith('{') ? JSON.parse(value) : { pid: Number(value) };
    return Number.isInteger(record.pid) && record.pid > 0 ? record : null;
  } catch {
    return null;
  }
}

function isPresenceProcess(pid) {
  const command = process.platform === 'win32'
    ? childProcess.spawnSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\").CommandLine`], { encoding: 'utf8', windowsHide: true })
    : childProcess.spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return !command.error
    && command.status === 0
    && /codex-discord-presence\.js(?:\s|$)/i.test(command.stdout || '');
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
let configMtimeMs = 0;
let lastBrokerActivity = null;
let lastBrokerActivityLabel = null;

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
  brokerHeartbeatTimer = setInterval(() => {
    if (config.useBroker !== false && lastBrokerActivity) {
      publishBrokerState(lastBrokerActivity, lastBrokerActivityLabel);
    }
  }, 10_000);
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
    for (const value of buffer.toString('utf8').split(/\r?\n/).reverse()) {
      try {
        const record = JSON.parse(value);
        const type = `${record.type || ''}/${record.payload?.type || ''}/${record.payload?.role || ''}`;
        if (/patch_apply_end/.test(type)) return 'Editing';
        if (/function_call_output|custom_tool_call_output/.test(type)) return 'Reading results';
        if (/function_call|custom_tool_call/.test(type)) return 'Running tools';
        if (/reasoning|task_started|agent_reasoning/.test(type)) return 'Thinking';
        if (/task_complete|agent_message/.test(type)) return 'Waiting';
      } catch {}
    }
  } catch {}
  return 'Working';
}

function tick() {
  startWatchers();
  refreshConfig();
  if (config.useBroker === false && !rpc.ready) rpc.connect();
  if (!pluginIsEnabled()) {
    clearPublishedActivity();
    removeDaemonState(dataDir, daemonState);
    setTimeout(() => process.exit(0), 250);
    return;
  }
  // 與 Claude 外掛一致：daemon 由 Codex 工作階段 Hook 啟動，存活期間必須至少顯示泛用活動。
  // 不依賴 tasklist 偵測，避免 Windows 權限或程序名稱差異造成完全沒有 Discord 動態。
  if (!active) {
    active = true;
    startedAt = Math.floor(Date.now() / 1000);
    log('Codex Discord Presence daemon 已啟動，正在更新 Discord 活動。');
  }
  const project = findLatestProject();
  const workspaceEnabled = config.showWorkspace ?? config.showProject !== false;
  const projectName = workspaceEnabled === false
    ? null
    : String(config.workspaceName || project?.name || '');
  const taskTitle = config.showTaskTitle === false
    ? null
    : String(config.taskTitle || findTaskTitle(project?.sessionId) || '');
  const repositoryUrl = project?.cwd ? findGitHubRepository(project.cwd) : null;
  const activityLabel = config.showActivity === false ? null : findActivity(project?.transcriptPath);
  const buttons = config.showRepositoryButton === false || !repositoryUrl
    ? undefined
    : [{ label: String(config.repositoryButtonLabel || 'View Repository').slice(0, 32), url: repositoryUrl }];
  const activity = {
    details: projectName
      ? `${String(config.projectLabel || 'Workspace')}: ${projectName}${activityLabel ? ` · ${activityLabel}` : ''}`
      : `${String(config.details)}${activityLabel ? ` · ${activityLabel}` : ''}`,
    state: taskTitle ? `Task: ${taskTitle}` : String(config.taskTitleFallback || config.state),
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
  clearPublishedActivity();
  removeDaemonState(dataDir, daemonState);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (config.useBroker === false) rpc.connect();
tick();
scheduleOptionalPoll();
startBrokerHeartbeat();
