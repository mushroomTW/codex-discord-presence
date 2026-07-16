#!/usr/bin/env node
'use strict';
const { createDaemonStateManager } = require('./shared/daemon-state');
module.exports = createDaemonStateManager({
    stateFile: 'codex-discord-presence.state.json',
    legacyPidFiles: ['codex-discord-presence.pid'],
    lockFile: 'codex-discord-presence.start.lock'
});
