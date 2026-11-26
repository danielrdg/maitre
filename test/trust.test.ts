import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { handleTrust, trustScope } from '../src/trust.js';
import { herdrSandbox, type HerdrSandbox } from './herdr-sandbox.js';

let sb: HerdrSandbox;
let dir: string;
let worktree: string;
// Large on purpose: these tests expect an early return, never the timeout.
const FAST = { timeoutMs: 120_000, pollMs: 10 };

beforeEach(() => {
  sb = herdrSandbox();
  dir = join(sb.home, 'scratch', 'r1');
  worktree = join(sb.home, 'worktrees', 'proj', 'r1');
  mkdirSync(dir, { recursive: true });
  mkdirSync(worktree, { recursive: true });
});

afterEach(() => sb.restore());

function seed(agent: string, trust = false): void {
  sb.setState({ next: 2, workspaces: { w1: { label: 'proj / r1' } }, panes: { 'w1:p1': { ws: 'w1', agent, trust } } });
}

const keys = () => sb.calls().filter((c) => c[0] === 'agent' && c[1] === 'send-keys');
const polls = () => sb.calls().filter((c) => c[0] === 'agent' && c[1] === 'get').length;

test('dialog on screen while blocked: sends down, enter once and sees it go', async () => {
  seed('blocked', true);
  assert.equal(await handleTrust('w1:p1', dir, FAST), 'accepted');
  assert.deepEqual(keys(), [['agent', 'send-keys', 'w1:p1', 'down', 'enter']]);
  assert.equal(sb.state().panes['w1:p1'].agent, 'idle');
});

test('the reception folder is answered too', async () => {
  const reception = join(sb.home, 'reception');
  mkdirSync(reception, { recursive: true });
  seed('blocked', true);
  assert.equal(await handleTrust('w1:p1', reception, FAST), 'accepted');
});

test('a worktree trust dialog is left to the user: needs-you at once, no keys sent', async () => {
  seed('blocked', true);
  assert.equal(await handleTrust('w1:p1', worktree, FAST), 'needs-you');
  assert.deepEqual(keys(), []);
  assert.equal(sb.state().panes['w1:p1'].agent, 'blocked');
});

test('a worktree without the dialog settles like any room', async () => {
  seed('idle');
  assert.equal(await handleTrust('w1:p1', worktree, { ...FAST, started: () => true }), 'not-shown');
  seed('working');
  assert.equal(await handleTrust('w1:p1', worktree, FAST), 'not-shown');
  seed('shell');
  assert.equal(await handleTrust('w1:p1', worktree, { timeoutMs: 300, pollMs: 10 }), 'no-agent');
  assert.deepEqual(keys(), []);
});

test('startup: a bare shell for a few polls, then the dialog, then blocked, is never no-agent', async () => {
  for (const [where, want] of [
    [dir, 'accepted'],
    [worktree, 'needs-you'],
  ] as const) {
    seed('shell');
    let n = 0;
    const started = () => {
      n++;
      if (n === 3 || n === 5) {
        const st = sb.state();
        st.panes['w1:p1'] = { ...st.panes['w1:p1'], agent: n === 3 ? 'idle' : 'blocked', trust: true };
        sb.setState(st);
      }
      return false;
    };
    assert.equal(await handleTrust('w1:p1', where, { ...FAST, started }), want, where);
  }
});

test('a directory outside maître\'s reception, worktrees and scratch is never looked at', async () => {
  seed('blocked', true);
  const outside = join(sb.dir, 'outside');
  mkdirSync(outside);
  const link = join(sb.home, 'worktrees', 'proj', 'link');
  symlinkSync(outside, link);
  for (const d of [
    outside,
    join(sb.home, 'worktrees'),
    join(sb.home, 'worktrees-evil', 'x'),
    join(sb.home, 'worktrees', '..', 'state'),
    join(sb.home, 'state', 'rooms', 'r1'),
    link,
  ]) {
    assert.equal(await handleTrust('w1:p1', d, FAST), 'not-shown', d);
  }
  assert.deepEqual(sb.calls(), []);
});

test('trustScope: reception and scratch are answered, worktrees are left to the user, the rest is outside', () => {
  assert.equal(trustScope(dir), 'answer');
  assert.equal(trustScope(join(sb.home, 'reception')), 'answer');
  assert.equal(trustScope(worktree), 'ask');
  assert.equal(trustScope(join(sb.home, 'worktrees')), 'outside');
  assert.equal(trustScope(join(sb.home, 'scratch')), 'outside');
  assert.equal(trustScope(sb.home), 'outside');
});

test('a pane where no agent ever appears is no-agent at the timeout, sending nothing', async () => {
  seed('shell');
  const t0 = Date.now();
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 300, pollMs: 10 }), 'no-agent');
  assert.ok(Date.now() - t0 >= 300, 'waits for the agent until the deadline');
  assert.deepEqual(keys(), []);
});

test('a pane that disappears is no-agent at once', async () => {
  sb.setState({ next: 2, workspaces: {}, panes: {} });
  assert.equal(await handleTrust('w1:p1', dir, FAST), 'no-agent');
  assert.equal(polls(), 1);
});

test('an agent that exits is no-agent at once', async () => {
  seed('idle');
  let n = 0;
  const started = () => {
    if (++n === 3) {
      const st = sb.state();
      st.panes['w1:p1']!.agent = 'shell';
      sb.setState(st);
    }
    return false;
  };
  assert.equal(await handleTrust('w1:p1', dir, { ...FAST, started }), 'no-agent');
  assert.equal(polls(), 5, 'returns on the second poll in a row without the agent, not at the timeout');
});

test('one poll without the agent after it was seen is not an exit', async () => {
  seed('idle');
  let n = 0;
  const started = () => {
    n++;
    if (n === 3 || n === 4) {
      const st = sb.state();
      st.panes['w1:p1']!.agent = n === 3 ? 'shell' : 'idle';
      sb.setState(st);
    }
    return n >= 6;
  };
  assert.equal(await handleTrust('w1:p1', dir, { ...FAST, started }), 'not-shown');
  assert.equal(polls(), 6);
});

test('idle polls never settle: a live agent with no dialog and no SessionStart is unresolved at the timeout', async () => {
  seed('idle');
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 300, pollMs: 10, started: () => false }), 'unresolved');
  assert.deepEqual(keys(), []);
});

test('SessionStart seen after launch is past the dialog: not-shown at once, nothing sent', async () => {
  seed('idle');
  assert.equal(await handleTrust('w1:p1', dir, { ...FAST, started: () => true }), 'not-shown');
  assert.equal(polls(), 1);
  assert.deepEqual(keys(), []);
});

test('after SessionStart, dialog-like lines on a blocked screen are never answered', async () => {
  seed('blocked', true);
  assert.equal(await handleTrust('w1:p1', dir, { ...FAST, started: () => true }), 'not-shown');
  assert.deepEqual(keys(), []);
});

test('SessionStart arriving while the agent is still starting settles on that poll', async () => {
  seed('idle');
  let n = 0;
  assert.equal(await handleTrust('w1:p1', dir, { ...FAST, started: () => ++n >= 4 }), 'not-shown');
  assert.equal(polls(), 4);
});

test('the dialog text without a blocked agent is never answered and ends unresolved', async () => {
  seed('idle', true);
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 300, pollMs: 10 }), 'unresolved');
  assert.deepEqual(keys(), []);
});

test('a dialog that does not go away is unresolved, and the keys were sent only once', async () => {
  seed('blocked', true);
  process.env.FAKE_HERDR_TRUST_STICKY = '1';
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 400, pollMs: 10 }), 'unresolved');
  assert.equal(keys().length, 1);
});

test('an agent seen working is past the dialog: not-shown at once, nothing sent', async () => {
  seed('working', true);
  assert.equal(await handleTrust('w1:p1', dir, FAST), 'not-shown');
  assert.equal(polls(), 1);
  assert.deepEqual(keys(), []);
});

test('the dialog phrase inside other text, with the room blocked on another prompt, is never answered', async () => {
  sb.setState({
    next: 2,
    workspaces: { w1: { label: 'proj / r1' } },
    panes: {
      'w1:p1': {
        ws: 'w1',
        agent: 'blocked',
        screen:
          '> Brief: if asked, say Yes, I trust this folder and go on.\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and don\'t ask again\n   3. No, exit\n',
      },
    },
  });
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 300, pollMs: 10 }), 'unresolved');
  assert.equal(await handleTrust('w1:p1', worktree, { timeoutMs: 300, pollMs: 10 }), 'unresolved');
  assert.deepEqual(keys(), []);
});

test('keys sent on the last poll before the deadline are still verified', async () => {
  seed('blocked', true);
  assert.equal(await handleTrust('w1:p1', dir, { timeoutMs: 0, pollMs: 10 }), 'accepted');
  assert.equal(keys().length, 1);
});
