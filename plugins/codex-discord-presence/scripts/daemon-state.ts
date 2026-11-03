import { createDaemonStateManager } from './shared/daemon-state.ts';

export const {
  acquireStartLock,
  getProcessCommandLine,
  isOwnedDaemon,
  isRunning,
  isValidDaemonState,
  readDaemonState,
  releaseStartLock,
  removeDaemonState,
  statePath,
  stopOwnedDaemon,
  touchDaemonState,
  writeDaemonState
} = createDaemonStateManager({
  stateFile: 'codex-discord-presence.state.json',
  lockFile: 'codex-discord-presence.start.lock'
});
