import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const hookPath = path.resolve(import.meta.dirname, '../plugins/codex-discord-presence/scripts/session-start.ts');
const hooks = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../plugins/codex-discord-presence/hooks/hooks.json'), 'utf8'));

test('Codex hooks 涵蓋完整 SessionStart 與 prompt 更新', () => {
  assert.equal(hooks.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.match(hooks.hooks.UserPromptSubmit[0].hooks[0].command, /--update --start$/);
});

test('Codex hooks 在 SessionEnd 時執行 stop.ts 釋放 presence', () => {
  assert.equal(hooks.hooks.SessionEnd[0].matcher, 'other');
  assert.match(hooks.hooks.SessionEnd[0].hooks[0].command, /scripts\/stop\.ts"$/);
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
