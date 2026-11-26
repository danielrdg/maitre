#!/usr/bin/env node
// Test double for any external command, run as `fake-bin.mjs <dir> <name> [args...]`.
// Appends one JSON line of argv to <dir>/<name>.log, prints <dir>/<name>.stdout when present,
// starts <dir>/<name>.spawn (a JSON argv) detached when present, then exits with <dir>/<name>.exit (default 0).
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, name, ...args] = process.argv.slice(2);
const file = (ext) => join(dir, `${name}.${ext}`);
appendFileSync(file('log'), JSON.stringify(args) + '\n');
if (existsSync(file('stdout'))) process.stdout.write(readFileSync(file('stdout')));
if (existsSync(file('spawn'))) {
  const [cmd, ...rest] = JSON.parse(readFileSync(file('spawn'), 'utf8'));
  spawn(cmd, rest, { detached: true, stdio: 'ignore' }).unref();
}
process.exit(existsSync(file('exit')) ? Number(readFileSync(file('exit'), 'utf8')) : 0);
