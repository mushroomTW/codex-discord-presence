'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { classifyActivity } = require('../plugins/codex-discord-presence/scripts/activity-classifier');

test('依最後一筆有效紀錄分類活動', () => {
  const lines = [
    JSON.stringify({ type: 'task_started' }),
    JSON.stringify({ payload: { type: 'function_call' } })
  ].join('\n');
  assert.equal(classifyActivity(lines), 'Running tools');
});

test('各事件型別對應正確標籤', () => {
  assert.equal(classifyActivity(JSON.stringify({ payload: { type: 'patch_apply_end' } })), 'Editing');
  assert.equal(classifyActivity(JSON.stringify({ payload: { type: 'function_call_output' } })), 'Reading results');
  assert.equal(classifyActivity(JSON.stringify({ type: 'agent_reasoning' })), 'Thinking');
  assert.equal(classifyActivity(JSON.stringify({ type: 'task_complete' })), 'Waiting');
});

test('空內容或無法解析時回傳 Working', () => {
  assert.equal(classifyActivity(''), 'Working');
  assert.equal(classifyActivity('not-json\n{broken'), 'Working');
});
