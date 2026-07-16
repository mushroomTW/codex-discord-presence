#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const scriptDir = __dirname;
const dataDir = process.env.PLUGIN_DATA || scriptDir;
fs.mkdirSync(dataDir, { recursive: true });
function removeLegacyStartupEntry() {
    const file = process.platform === 'win32'
        ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'codex-discord-presence.cmd')
        : process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.mushroomtw.codex-discord-presence.plist')
            : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', 'codex-discord-presence.desktop');
    fs.rmSync(file, { force: true });
}
removeLegacyStartupEntry();
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
    try {
        const events = input.trim().split(/\r?\n/).reverse();
        const session = events
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .find((event) => event && typeof (event.cwd ?? event.payload?.cwd ?? event.context?.cwd) === 'string');
        const cwd = session?.cwd ?? session?.payload?.cwd ?? session?.context?.cwd;
        const sessionId = session?.session_id ?? session?.sessionId ?? session?.id;
        const transcriptPath = session?.transcript_path ?? session?.transcriptPath ?? session?.payload?.transcript_path;
        if (typeof cwd === 'string' && cwd) {
            fs.writeFileSync(path.join(dataDir, 'active-project.json'), JSON.stringify({
                projectName: path.basename(cwd),
                cwd,
                sessionId: typeof sessionId === 'string' ? sessionId : null,
                transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : null
            }), 'utf8');
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
