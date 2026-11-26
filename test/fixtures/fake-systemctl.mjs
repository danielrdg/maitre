#!/usr/bin/env node
// Test double for systemctl, run as `fake-systemctl.mjs <log> <args...>`: appends one JSON line of argv to <log>.
import { appendFileSync } from 'node:fs';

const [log, ...args] = process.argv.slice(2);
appendFileSync(log, JSON.stringify(args) + '\n');
