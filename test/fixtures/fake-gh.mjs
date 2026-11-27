#!/usr/bin/env node
// Test double for the `gh` CLI as maître calls it (`gh pr list …`, `gh pr view <url> …`).
// Appends {argv, cwd} as one JSON line to $FAKE_GH_LOG.
// FAKE_GH_EXIT: exit code for every call (non-zero also prints an error).
// FAKE_GH_FAIL: a file of lines; a call with an argument equal to one of them fails (exit 1).
// FAKE_GH_DATA: a JSON file { view: { <url>: pr }, list: { <branch>: [pr] } } read on every call:
//   `pr view <url>` prints view[url] (unknown url: exit 1), `pr list --head <b>` prints list[b] (default [],
//   cut to --limit). Without it, FAKE_GH_PRS (a JSON file, `[]` when absent) is printed as the answer.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const log = process.env.FAKE_GH_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv, cwd: process.cwd() }) + '\n');

const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
};
const exit = Number(process.env.FAKE_GH_EXIT ?? 0);
if (exit !== 0) {
  process.stderr.write('fake gh: failed on purpose\n');
  process.exit(exit);
}
const failFile = process.env.FAKE_GH_FAIL;
if (failFile && existsSync(failFile)) {
  const keys = readFileSync(failFile, 'utf8').split('\n').filter((l) => l !== '');
  if (argv.some((a) => keys.includes(a))) fail('fake gh: failed on purpose');
}

const dataFile = process.env.FAKE_GH_DATA;
if (dataFile) {
  const data = existsSync(dataFile) ? JSON.parse(readFileSync(dataFile, 'utf8')) : {};
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  if (argv[0] === 'pr' && argv[1] === 'view') {
    const pr = data.view?.[argv[2]];
    if (pr === undefined) fail(`no pull requests found for ${argv[2]}`);
    process.stdout.write(JSON.stringify(pr));
  } else if (argv[0] === 'pr' && argv[1] === 'list') {
    const all = data.list?.[flag('--head')] ?? [];
    const limit = flag('--limit');
    process.stdout.write(JSON.stringify(limit === undefined ? all : all.slice(0, Number(limit))));
  } else {
    fail(`fake gh: unknown command ${argv.join(' ')}`);
  }
  process.exit(0);
}

const prs = process.env.FAKE_GH_PRS;
process.stdout.write(prs && existsSync(prs) ? readFileSync(prs, 'utf8') : '[]');
