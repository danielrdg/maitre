import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookLine } from '../src/events.js';
import { EventTail } from '../src/event-tail.js';

function line(room: string, event: string, extra: Partial<HookLine> = {}): string {
  return JSON.stringify({ v: 1, ts: Date.now(), room, session: 's-1', event, ...extra }) + '\n';
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const homes: string[] = [];
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true });
});

function tmpHome(): string {
  const h = mkdtempSync(join(tmpdir(), 'maitre-tail-'));
  homes.push(h);
  return h;
}

function setup(room = 'r1'): { state: string; file: string; dir: string } {
  const home = tmpHome();
  const state = join(home, 'state');
  const dir = join(state, 'rooms', room);
  mkdirSync(dir, { recursive: true });
  return { state, dir, file: join(dir, 'events.jsonl') };
}

// Every behavior must hold with fs.watch off: on some filesystems it never fires.
for (const watch of [true, false]) {
  const mode = watch ? 'watch+poll' : 'poll only';

  test(`tail (${mode}): appended lines are delivered once each`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, line('r1', 'SessionStart') + line('r1', 'UserPromptSubmit'));
      await waitFor(() => got.length === 2);
      await pause(150);
      assert.deepEqual(
        got.map((l) => l.event),
        ['SessionStart', 'UserPromptSubmit'],
      );
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): a partial line is held until its newline`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      const full = Buffer.from(line('r1', 'UserPromptSubmit', { prompt: 'café ☕ ok' }));
      // Split inside the multi-byte "☕" so a naive string decode would corrupt it.
      const cut = full.indexOf(Buffer.from('☕')) + 1;
      appendFileSync(file, full.subarray(0, cut));
      await pause(200);
      assert.equal(got.length, 0);
      appendFileSync(file, full.subarray(cut));
      await waitFor(() => got.length === 1);
      assert.equal(got[0]?.prompt, 'café ☕ ok');
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): truncation resets the offset without replaying`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, line('r1', 'SessionStart') + line('r1', 'UserPromptSubmit'));
      await waitFor(() => got.length === 2);
      truncateSync(file, 0);
      appendFileSync(file, line('r1', 'Stop'));
      await waitFor(() => got.length === 3);
      await pause(200);
      assert.deepEqual(
        got.map((l) => l.event),
        ['SessionStart', 'UserPromptSubmit', 'Stop'],
      );
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): a truncate-and-rewrite past the old offset is read from the start`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, line('r1', 'SessionStart'));
      await waitFor(() => got.length === 1);
      // Both writes land before any scan can run: same inode, and the file is bigger than before.
      const s2 = { session: 's-2' };
      truncateSync(file, 0);
      appendFileSync(file, line('r1', 'SessionStart', s2) + line('r1', 'UserPromptSubmit', s2) + line('r1', 'Stop', s2));
      await waitFor(() => got.length === 4);
      await pause(200);
      assert.deepEqual(
        got.slice(1).map((l) => `${l.session}:${l.event}`),
        ['s-2:SessionStart', 's-2:UserPromptSubmit', 's-2:Stop'],
      );
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): a replaced file (new inode) is read from the start`, async () => {
    const { state, dir, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, line('r1', 'SessionStart') + line('r1', 'UserPromptSubmit') + line('r1', 'Stop'));
      await waitFor(() => got.length === 3);
      // Larger than the old file, so only the inode change can reveal the replacement. The new
      // file is created while the old one still exists, so it cannot reuse its inode.
      const tmp = join(dir, 'next.tmp');
      const s2 = { session: 's-2' };
      writeFileSync(
        tmp,
        line('r1', 'SessionStart', s2) + line('r1', 'UserPromptSubmit', s2) + line('r1', 'Stop', s2) + line('r1', 'SessionEnd', s2),
      );
      renameSync(tmp, file);
      await waitFor(() => got.length === 7);
      await pause(200);
      assert.deepEqual(
        got.slice(3).map((l) => `${l.session}:${l.event}`),
        ['s-2:SessionStart', 's-2:UserPromptSubmit', 's-2:Stop', 's-2:SessionEnd'],
      );
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): unparsable and malformed lines are skipped`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, 'not json\n\n[1,2]\n{"room":"r1"}\nnull\n' + line('r1', 'Stop'));
      await waitFor(() => got.length === 1);
      await pause(150);
      assert.equal(got.length, 1);
      assert.equal(got[0]?.event, 'Stop');
    } finally {
      tail.stop();
    }
  });

  test(`tail (${mode}): deleting and recreating a file does not throw`, async () => {
    const { state, file } = setup();
    const got: HookLine[] = [];
    const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50, watch });
    tail.start();
    try {
      appendFileSync(file, line('r1', 'SessionStart'));
      await waitFor(() => got.length === 1);
      unlinkSync(file);
      await pause(150);
      appendFileSync(file, line('r1', 'Stop'));
      await waitFor(() => got.length === 2);
      assert.equal(got[1]?.event, 'Stop');
    } finally {
      tail.stop();
    }
  });
}

test('tail: a room created after start() is picked up by the default poll', async () => {
  const { state } = setup('first');
  const got: HookLine[] = [];
  const tail = new EventTail(state, (l) => got.push(l), { watch: false });
  tail.start();
  try {
    await pause(50);
    const dir = join(state, 'rooms', 'late');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), line('late', 'SessionStart'));
    // The default poll is 500 ms; the margin is for a loaded machine.
    await waitFor(() => got.length === 1, 3000);
    assert.equal(got[0]?.room, 'late');
  } finally {
    tail.stop();
  }
});

test('tail: a missing state dir is tolerated until it appears', async () => {
  const home = tmpHome();
  const state = join(home, 'state');
  const got: HookLine[] = [];
  const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50 });
  tail.start();
  try {
    await pause(100);
    const dir = join(state, 'rooms', 'r1');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'events.jsonl'), line('r1', 'SessionStart'));
    await waitFor(() => got.length === 1);
  } finally {
    tail.stop();
  }
});

test('tail: start() replays existing files, stop() halts delivery', async () => {
  const { state, file } = setup();
  appendFileSync(file, line('r1', 'SessionStart') + line('r1', 'SessionEnd'));
  const got: HookLine[] = [];
  const tail = new EventTail(state, (l) => got.push(l), { pollMs: 50 });
  tail.start();
  assert.deepEqual(
    got.map((l) => l.event),
    ['SessionStart', 'SessionEnd'],
  );
  tail.stop();
  appendFileSync(file, line('r1', 'SessionStart', { session: 's-2' }));
  await pause(200);
  assert.equal(got.length, 2);
});

test('tail: a throwing consumer does not stop the tail', async () => {
  const { state, file } = setup();
  const got: HookLine[] = [];
  const tail = new EventTail(
    state,
    (l) => {
      got.push(l);
      if (l.event === 'SessionStart') throw new Error('boom');
    },
    { pollMs: 50 },
  );
  tail.start();
  try {
    appendFileSync(file, line('r1', 'SessionStart') + line('r1', 'Stop'));
    await waitFor(() => got.length === 2);
  } finally {
    tail.stop();
  }
});
