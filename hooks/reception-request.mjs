// UserPromptSubmit hook for the maître reception: stores the user's message as
// $MAITRE_HOME/reception/requests/<n>.md (next free integer, created exclusively, 0600) and tells
// the model its id, so the reception only ever passes ids to `maitre`. It never blocks the
// prompt: always exit 0, and print nothing unless the message was stored.
// Registered for SessionStart too: it then only writes $MAITRE_HOME/reception/session-started,
// which tells `maitre` that this Claude got past the folder-trust dialog.
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const FILE = /^([0-9]{1,12})\.md$/;
const TRIES = 50;
// Prompts Claude Code injects itself (a background task or subagent reporting back), not the user's.
const SYNTHETIC = /^(?:<task-notification>|<agent-message[\s>])/;
// Claude Code wraps a pasted prompt in these tags. Same rule as unwrapPasted() in src/room-open.ts.
const PASTED = /<pasted_content id="\d+">\n?|\n?<\/pasted_content id="\d+">/g;

function unwrapPasted(text) {
  const out = text.replace(PASTED, '');
  return out === text ? text : out.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

function nextId(dir) {
  let max = 0;
  for (const name of readdirSync(dir)) {
    const m = FILE.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

function store(dir, text) {
  for (let i = 0; i < TRIES; i++) {
    const id = nextId(dir);
    let fd;
    try {
      fd = openSync(join(dir, `${id}.md`), 'wx', 0o600);
    } catch (e) {
      if (e.code === 'EEXIST') continue;
      throw e;
    }
    try {
      const buf = Buffer.from(text, 'utf8');
      for (let off = 0; off < buf.length; ) off += writeSync(fd, buf, off);
    } finally {
      closeSync(fd);
    }
    return id;
  }
  return undefined;
}

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const home = process.env.MAITRE_HOME ? resolve(process.env.MAITRE_HOME) : join(homedir(), '.maitre');
  const raw = input?.prompt;
  if (input?.hook_event_name === 'SessionStart') {
    const dir = join(home, 'reception');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'session-started'), String(input.session_id ?? ''), { mode: 0o600 });
  } else if (typeof raw === 'string' && raw.trim() !== '' && !SYNTHETIC.test(raw)) {
    const text = unwrapPasted(raw);
    const dir = join(home, 'reception', 'requests');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const id = store(dir, text);
    if (id !== undefined) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `This message is request ${id}.` } }),
      );
    }
  }
} catch {
  // Never block the user's message.
}
process.exitCode = 0;
