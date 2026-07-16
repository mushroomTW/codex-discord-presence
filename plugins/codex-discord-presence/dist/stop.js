#!/usr/bin/env node
// @ts-nocheck
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const path = require('path');
const { stopLegacyDaemon, stopOwnedDaemon } = require('./daemon-state');
const dataDir = process.env.PLUGIN_DATA || __dirname;
const daemonScript = path.join(__dirname, 'codex-discord-presence.js');
const stopped = stopOwnedDaemon(dataDir) || stopLegacyDaemon(dataDir, daemonScript);
console.log(stopped ? 'Codex Discord Presence stopped.' : 'Codex Discord Presence is not running.');
