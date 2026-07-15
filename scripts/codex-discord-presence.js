#!/usr/bin/env node
'use strict';

// 僅使用 Node.js 內建模組，透過 Discord 的本機 IPC 傳送 Rich Presence。
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const scriptDir = __dirname;
const dataDir = process.env.PLUGIN_DATA || scriptDir;
fs.mkdirSync(dataDir, { recursive: true });
const configPath = path.join(scriptDir, 'config.json');
const pidPath = path.join(dataDir, 'codex-discord-presence.pid');
const logPath = path.join(dataDir, 'codex-discord-presence.log');

function readConfig() {
  const defaults = { clientId: '', details: 'Using Codex', state: 'Vibe coding', pollIntervalMs: 8000 };
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return { ...defaults, ...parsed };
  } catch (error) {
    throw new Error(`無法讀取 config.json：${error.message}`);
  }
}

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(logPath, `${line}\n`, 'utf8');
}

function codexIsRunning() {
  const result = childProcess.spawnSync(
    'tasklist',
    ['/FI', 'IMAGENAME eq Codex.exe', '/FO', 'CSV', '/NH'],
    { encoding: 'utf8', windowsHide: true }
  );
  if (result.error || result.status !== 0) return false;
  return result.stdout.toLowerCase().includes('codex.exe');
}

function findLatestProjectName() {
  try {
    const projectName = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-project.json'), 'utf8')).projectName;
    if (typeof projectName === 'string' && projectName) return projectName;
  } catch {}
  const sessionsDir = path.join(os.homedir(), '.codex', 'sessions');
  try {
    const files = [];
    const collect = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) collect(fullPath);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          files.push({ fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs });
        }
      }
    };
    collect(sessionsDir);
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { fullPath } of files.slice(0, 30)) {
      try {
        const firstLine = fs.readFileSync(fullPath, 'utf8').split(/\r?\n/, 1)[0];
        const cwd = JSON.parse(firstLine)?.payload?.cwd;
        if (typeof cwd === 'string' && cwd) return path.basename(cwd);
      } catch {
        // 跳過尚未寫入完成或不符合預期格式的 session 檔。
      }
    }
  } catch {
    // 工作階段資料暫時無法讀取時，保留原本的自訂狀態。
  }
  return null;
}

function writeFrame(socket, opcode, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32LE(opcode, 0);
  header.writeInt32LE(body.length, 4);
  socket.write(Buffer.concat([header, body]));
}

class DiscordRpc {
  constructor(clientId) {
    this.clientId = clientId;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.ready = false;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.socket || !this.clientId) return;
    const tryPipe = (index) => {
      if (index > 9) {
        this.scheduleReconnect();
        return;
      }
      const socket = net.createConnection(`\\\\?\\pipe\\discord-ipc-${index}`);
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
        if (!settled) tryPipe(index + 1);
      });
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
  }

  onData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length >= 8) {
      const opcode = this.buffer.readInt32LE(0);
      const length = this.buffer.readInt32LE(4);
      if (this.buffer.length < 8 + length) return;
      const payload = JSON.parse(this.buffer.subarray(8, 8 + length).toString('utf8'));
      this.buffer = this.buffer.subarray(8 + length);
      if (opcode === 2) {
        log(`Discord IPC 已關閉：${payload.data?.message || JSON.stringify(payload)}`);
        this.socket?.destroy();
        return;
      }
      if (payload.evt === 'READY') {
        this.ready = true;
        log('Discord Rich Presence 已就緒');
      } else if (payload.evt === 'ERROR') {
        log(`Discord RPC 錯誤：${payload.data?.message || JSON.stringify(payload)}`);
      }
    }
  }

  setActivity(activity) {
    if (!this.ready || !this.socket || this.socket.destroyed) return;
    writeFrame(this.socket, 1, {
      cmd: 'SET_ACTIVITY',
      nonce: crypto.randomUUID(),
      args: { pid: process.pid, activity }
    });
  }

  clearActivity() {
    this.setActivity(null);
  }
}

function status() {
  const running = fs.existsSync(pidPath) && (() => {
    const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
    try { process.kill(pid, 0); return true; } catch { return false; }
  })();
  console.log(running ? '常駐程式正在執行。' : '常駐程式未執行。');
}

if (process.argv.includes('--status')) {
  status();
  process.exit(0);
}

const config = readConfig();
if (!/^\d{17,20}$/.test(config.clientId)) {
  console.error('請先在 scripts/config.json 填入 Discord Application ID（clientId）。');
  process.exit(1);
}

fs.writeFileSync(pidPath, String(process.pid), 'utf8');
const rpc = new DiscordRpc(config.clientId);
let active = false;
let startedAt = null;

function tick() {
  const codexRunning = codexIsRunning();
  if (codexRunning && !active) {
    active = true;
    startedAt = Math.floor(Date.now() / 1000);
    log('偵測到 Codex，正在更新 Discord 活動。');
  } else if (!codexRunning && active) {
    active = false;
    startedAt = null;
    rpc.clearActivity();
    log('Codex 已關閉，已清除 Discord 活動。');
  }
  if (active) {
    const projectName = config.showProject === false ? null : findLatestProjectName();
    const repositoryUrl = String(config.repositoryUrl || '').trim();
    const buttons = config.showRepositoryButton === false || !/^https:\/\//i.test(repositoryUrl)
      ? undefined
      : [{ label: String(config.repositoryButtonLabel || 'View Repository').slice(0, 32), url: repositoryUrl }];
    rpc.setActivity({
      details: String(config.details),
      state: projectName ? `${String(config.projectLabel || 'Workspace')}: ${projectName}` : String(config.state),
      timestamps: { start: startedAt },
      instance: false,
      buttons
    });
  }
}

function shutdown() {
  rpc.clearActivity();
  fs.rmSync(pidPath, { force: true });
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
rpc.connect();
tick();
setInterval(tick, Math.max(2000, Number(config.pollIntervalMs) || 8000));
