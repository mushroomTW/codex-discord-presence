'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repositoryRoot = path.resolve(__dirname, '..');
const pluginRoot = path.join(repositoryRoot, 'plugins', 'codex-discord-presence');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8'));
}

test('Codex 發布 metadata 與必要檔案完整', () => {
  const marketplace = readJson('.agents/plugins/marketplace.json');
  const manifest = readJson('plugins/codex-discord-presence/.codex-plugin/plugin.json');
  const config = readJson('plugins/codex-discord-presence/scripts/config.json');

  assert.equal(marketplace.name, manifest.name);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, manifest.name);
  assert.equal(marketplace.plugins[0].source.path, './plugins/codex-discord-presence');
  assert.match(manifest.version, /^0\.1\.\d+$/);
  assert.match(config.clientId, /^\d{17,20}$/);
  assert.equal(config.useBroker, true);

  for (const relativePath of [manifest.hooks, manifest.skills, manifest.interface.logo, manifest.interface.composerIcon]) {
    assert.ok(fs.existsSync(path.resolve(pluginRoot, relativePath)), `缺少 manifest 引用：${relativePath}`);
  }
});

test('Codex hooks 僅引用存在的 Node.js 腳本', () => {
  const hooks = readJson('plugins/codex-discord-presence/hooks/hooks.json').hooks;
  const commands = Object.values(hooks).flatMap((groups) => groups.flatMap((group) => group.hooks));
  assert.ok(commands.length > 0);
  for (const hook of commands) {
    assert.equal(hook.type, 'command');
    assert.ok(Number(hook.timeout) > 0 && Number(hook.timeout) <= 10);
    const match = hook.command.match(/\$\{PLUGIN_ROOT\}\/([^" ]+\.js)/);
    assert.ok(match, `無法解析 Hook 命令：${hook.command}`);
    assert.ok(fs.existsSync(path.join(pluginRoot, match[1])), `Hook 腳本不存在：${match[1]}`);
  }
});

test('Git 發布內容不追蹤套件管理器或開發用 Broker 副本', () => {
  for (const name of ['package.json', 'package-lock.json', 'node_modules', 'discord-presence-broker']) {
    const tracked = childProcess.execFileSync('git', [
      'ls-files', '--', `plugins/codex-discord-presence/${name}`
    ], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true }).trim();
    assert.equal(tracked, '', `不應出貨：${name}`);
  }
});
