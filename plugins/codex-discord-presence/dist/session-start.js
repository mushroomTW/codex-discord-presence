#!/usr/bin/env node
// @ts-nocheck
'use strict';
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');
const scriptDir = __dirname;
const dataDir = process.env.PLUGIN_DATA || scriptDir;
fs.mkdirSync(dataDir, { recursive: true });
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const cwd = JSON.parse(input).cwd;
        if (typeof cwd === 'string' && cwd) {
            fs.writeFileSync(path.join(dataDir, 'active-project.json'), JSON.stringify({ projectName: path.basename(cwd), cwd }), 'utf8');
        }
    }
    catch {
        // 無法取得 Hook 輸入時，常駐程式會改由工作階段紀錄推測專案名稱。
    }
    childProcess.spawn(process.execPath, [path.join(scriptDir, 'start.js')], {
        cwd: scriptDir,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, PLUGIN_DATA: dataDir },
        windowsHide: true
    }).unref();
});
process.stdin.resume();
