#!/usr/bin/env node
// Test double for the `claude` CLI as the router calls it.
// Appends {argv, env} (env: only CLAUDE*/ANTHROPIC* keys) as one JSON line to $FAKE_CLAUDE_LOG.
// FAKE_CLAUDE_STDOUT: what to print. FAKE_CLAUDE_SLEEP_MS: sleep before answering. FAKE_CLAUDE_EXIT: exit code.
import { appendFileSync } from 'node:fs';

const log = process.env.FAKE_CLAUDE_LOG;
if (log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^CLAUDE|^ANTHROPIC/.test(k)));
  appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env }) + '\n');
}
const sleep = Number(process.env.FAKE_CLAUDE_SLEEP_MS ?? 0);
if (sleep > 0) await new Promise((r) => setTimeout(r, sleep));
process.stdout.write(process.env.FAKE_CLAUDE_STDOUT ?? '');
process.exit(Number(process.env.FAKE_CLAUDE_EXIT ?? 0));
