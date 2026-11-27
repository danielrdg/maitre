#!/usr/bin/env node
// Test double for the `gh` CLI as the pending checks call it (`gh pr list …`).
// Appends {argv, cwd} as one JSON line to $FAKE_GH_LOG.
// FAKE_GH_PRS: a JSON file printed as the answer (`[]` when absent). FAKE_GH_EXIT: exit code (non-zero also prints an error).
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const log = process.env.FAKE_GH_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\n');
const exit = Number(process.env.FAKE_GH_EXIT ?? 0);
if (exit !== 0) {
  process.stderr.write('fake gh: failed on purpose\n');
  process.exit(exit);
}
const prs = process.env.FAKE_GH_PRS;
process.stdout.write(prs && existsSync(prs) ? readFileSync(prs, 'utf8') : '[]');
