// Replays raw Claude Code hook payloads (one JSON object per line, as in
// test/fixtures/hook-events.jsonl) through the real hook into $MAITRE_HOME, so a running
// `maitre lounge` shows them as a live room. For demos and manual QA.
//
//   MAITRE_HOME=<the lounge's folder> node scripts/replay-events.mjs <fixture> [--room <name>] [--delay <ms>]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HOOK = fileURLToPath(new URL('../hooks/maitre-hook.mjs', import.meta.url));
const USAGE = 'usage: node scripts/replay-events.mjs <fixture> [--room <name>] [--delay <ms>]';

function fail(msg) {
  console.error(`replay-events: ${msg}`);
  process.exit(2);
}

function parse(argv) {
  const out = { fixture: undefined, room: 'replay', delay: 300 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--room') out.room = argv[++i];
    else if (a === '--delay') out.delay = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (a.startsWith('-') || out.fixture !== undefined) fail(USAGE);
    else out.fixture = a;
  }
  if (out.fixture === undefined || typeof out.room !== 'string') fail(USAGE);
  if (!/[a-z0-9]/i.test(out.room)) fail('invalid room name; use letters or digits');
  if (!Number.isFinite(out.delay) || out.delay < 0) fail('--delay must be a number of milliseconds, 0 or more');
  return out;
}

const args = parse(process.argv.slice(2));
// Without it the hook would write into the real ~/.maitre and leave a ghost room in the lounge.
if (!process.env.MAITRE_HOME) fail('set MAITRE_HOME to the folder the lounge uses, e.g. MAITRE_HOME=/tmp/maitre-try');
const lines = readFileSync(args.fixture, 'utf8')
  .split('\n')
  .filter((l) => l.trim() !== '');
// The hook ignores a relative MAITRE_HOME, so resolve it here against our own cwd.
const env = { ...process.env, MAITRE_ROOM: args.room, MAITRE_HOME: resolve(process.env.MAITRE_HOME) };

for (const [i, input] of lines.entries()) {
  if (i > 0 && args.delay > 0) await sleep(args.delay);
  const r = spawnSync(process.execPath, [HOOK], { input, env, stdio: ['pipe', 'ignore', 'inherit'] });
  if (r.status !== 0) fail(`the hook failed on line ${i + 1}`);
}
console.log(`replay-events: ${lines.length} event(s) replayed into room ${JSON.stringify(args.room)}`);
