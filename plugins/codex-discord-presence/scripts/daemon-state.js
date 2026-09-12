'use strict';

const { createDaemonStateManager } = require('./shared/daemon-state');

module.exports = createDaemonStateManager({
  stateFile: 'codex-discord-presence.state.json',
  lockFile: 'codex-discord-presence.start.lock'
});
