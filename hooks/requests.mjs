// Request allocator shared by the reception hook and the lounge service. Plain JS: Claude Code
// runs the hook with no build step, and src/requests.ts loads this file at runtime.
import { chmodSync, closeSync, mkdirSync, openSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FILE = /^([0-9]{1,12})\.md$/;
const TRIES = 50;
// Claude Code wraps a pasted prompt in these tags. Same rule as unwrapPasted() in src/room-open.ts.
const PASTED = /<pasted_content id="\d+">\n?|\n?<\/pasted_content id="\d+">/g;

export function unwrapPasted(text) {
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

// Stores text as <home>/reception/requests/<n>.md (next free integer, created exclusively, 0600).
export function storeRequest(home, text) {
  const dir = join(home, 'reception', 'requests');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
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
