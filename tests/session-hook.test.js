'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hookPath = path.resolve(__dirname, '../plugins/codex-discord-presence/scripts/session-start.js');
const hooks = require('../plugins/codex-discord-presence/hooks/hooks.json');

test('Codex hooks 涵蓋完整 SessionStart 與 prompt 更新', () => {
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /--update --start$/);
});

test('--update 會刷新 session 狀態並正常結束', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-presence-hook-'));
  const dataDir = path.join(root, 'data');
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  const event = JSON.stringify({
    cwd: workspace,
    session_id: 'session-1',
    transcript_path: path.join(root, 'transcript.jsonl')
  });

  try {
    const result = childProcess.spawnSync(process.execPath, [hookPath, '--update'], {
      input: `${event}\n`,
      encoding: 'utf8',
      env: { ...process.env, CODEX_PRESENCE_DATA: dataDir },
      timeout: 5_000,
      windowsHide: true
    });
    assert.equal(result.status, 0, result.stderr);
    const sessions = JSON.parse(fs.readFileSync(path.join(dataDir, 'active-sessions.json'), 'utf8'));
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].sessionId, 'session-1');
    assert.equal(sessions[0].cwd, workspace);
    assert.ok(Date.now() - sessions[0].lastActiveAt < 5_000);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
