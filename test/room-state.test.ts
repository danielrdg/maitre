import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from '../src/events.js';
import { roomDir } from '../src/paths.js';
import { modelKey, reduce, type LiveState, type RoomState } from '../src/room-state.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HOOK = join(ROOT, 'hooks', 'maitre-hook.mjs');

// Raw hook payloads (as Claude Code sends them) become HookLines by going through the real hook.
function throughHook(raw: string[]): HookLine[] {
  const home = mkdtempSync(join(tmpdir(), 'maitre-state-'));
  try {
    for (const input of raw) {
      const r = spawnSync(process.execPath, [HOOK], {
        input,
        env: { PATH: process.env.PATH ?? '', MAITRE_ROOM: 't1', MAITRE_HOME: home },
        encoding: 'utf8',
      });
      assert.equal(r.status, 0);
    }
    const lines = readFileSync(join(roomDir('t1', { MAITRE_HOME: home }), 'events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as HookLine);
    assert.equal(lines.length, raw.length);
    return lines.map((l, i) => ({ ...l, ts: 1000 + i * 10 }));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const FIXTURE = throughHook(
  readFileSync(join(ROOT, 'test', 'fixtures', 'hook-events.jsonl'), 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== ''),
);

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Reflect.ownKeys(v)) deepFreeze((v as Record<PropertyKey, unknown>)[k]);
  }
  return v;
}

function fold(lines: HookLine[], start?: RoomState): RoomState {
  let s = start;
  for (const l of lines) s = reduce(s === undefined ? undefined : deepFreeze(s), l);
  assert.ok(s);
  return s;
}

let clock = 0;
function ev(event: string, extra: Partial<HookLine> = {}): HookLine {
  clock += 10;
  return { v: 1, ts: clock, room: 't1', session: 's-1', event, ...extra };
}

const pre = (id: string, tool: string, input: unknown, extra: Partial<HookLine> = {}) =>
  ev('PreToolUse', { tool, tool_use_id: id, input, ...extra });
const ask = (tool: string, input: unknown, extra: Partial<HookLine> = {}) => ev('PermissionRequest', { tool, input, ...extra });
const post = (id: string, tool: string, input: unknown, extra: Partial<HookLine> = {}) =>
  ev('PostToolUse', { tool, tool_use_id: id, input, ...extra });

function started(): RoomState {
  return fold([ev('SessionStart', { model: 'claude-opus-5-5' }), ev('UserPromptSubmit', { prompt: 'do it', synthetic: false })]);
}

function assertBlockedInvariant(s: RoomState, where: string): void {
  assert.equal(s.state === 'blocked', s.block !== undefined, `${where}: state ${s.state}, block ${JSON.stringify(s.block)}`);
}

test('modelKey maps model ids to the lounge cast', () => {
  assert.equal(modelKey('claude-haiku-5-5'), 'haiku');
  assert.equal(modelKey('claude-sonnet-4-6'), 'sonnet');
  assert.equal(modelKey('claude-opus-5-5[1m]'), 'opus');
  assert.equal(modelKey('fable'), 'fable');
  assert.equal(modelKey('gpt-x'), 'unknown');
  assert.equal(modelKey(undefined), 'unknown');
});

test('folding the fixture yields the measured state at every step', () => {
  const expected: LiveState[] = [
    'coffee', 'work', 'work', 'blocked', 'blocked', 'work', 'ready', 'ready', // touch hello.txt (manual permission)
    'work', 'work', 'blocked', 'work', 'ready', 'ready', // AskUserQuestion
    'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', 'work', // background subagent
    'ready', 'ready',
    'work', 'work', 'work', 'ready', 'ready', // auto mode, allowed
    'work', 'work', 'work', 'ready', 'ready', // auto mode, PermissionDenied without a block
    'work', 'work', 'blocked', 'work', 'whisky', 'whisky', 'whisky', 'exit', // gh pr create
  ];
  assert.equal(FIXTURE.length, expected.length);
  let s: RoomState | undefined;
  const seen: LiveState[] = [];
  for (const [i, l] of FIXTURE.entries()) {
    const next = reduce(s === undefined ? undefined : deepFreeze(s), l);
    assert.equal(next.updatedAt, l.ts, `line ${i + 1}: updatedAt`);
    if (s !== undefined) {
      if (next.state === s.state) assert.equal(next.since, s.since, `line ${i + 1}: since kept`);
      else assert.equal(next.since, l.ts, `line ${i + 1}: since moved`);
    }
    assertBlockedInvariant(next, `line ${i + 1}`);
    seen.push(next.state);
    s = next;
  }
  assert.deepEqual(seen, expected);

  const at = (n: number) => fold(FIXTURE.slice(0, n));
  assert.equal(at(1).model, 'haiku');
  assert.equal(at(1).room, 't1');
  assert.equal(at(1).session, 's-0001');
  assert.equal(at(2).task, 'Create an empty file hello.txt');
  assert.deepEqual(at(18).subagents, [{ id: 'a1', type: 'general-purpose', model: 'haiku' }]);
  assert.deepEqual(at(24).subagents, []);
  assert.equal(at(25).task, 'Create an empty file hello.txt', 'later and synthetic prompts keep the task');
  assert.equal(at(40).block?.detail, 'gh pr create --fill');
  assert.equal(at(40).block?.toolUseId, 'toolu_P1');
  assert.equal(at(41).prUrl, 'https://github.com/acme/app/pull/12');
  assert.equal(at(10).steps.at(-1), 'AskUserQuestion: Which fruit?');
  assert.deepEqual(at(45).steps, ['Agent: List files', 'Bash: ls', 'Bash: touch a.txt', 'Bash: rm -rf ../outside', 'Bash: gh pr create --fill']);
});

test('phantom SubagentStop (agent_type "") is ignored', () => {
  const s0 = fold([
    ev('SessionStart'),
    ev('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }),
    ev('Stop', { background_running: 1 }),
  ]);
  const s1 = reduce(s0, ev('SubagentStop', { agent_id: 'a1', agent_type: '' }));
  assert.deepEqual(s1.subagents, s0.subagents);
  assert.equal(s1.state, 'work');
  const s2 = reduce(s0, ev('SubagentStart', { agent_id: 'a9', agent_type: '' }));
  assert.deepEqual(s2.subagents, s0.subagents);
});

test('Stop with a running background task stays work; without one goes ready', () => {
  assert.equal(reduce(started(), ev('Stop', { background_running: 2 })).state, 'work');
  assert.equal(reduce(started(), ev('Stop', { background_running: 0 })).state, 'ready');
  assert.equal(reduce(started(), ev('Stop')).state, 'ready');
});

test('Bash touch PermissionRequest blocks with a permission', () => {
  const s = fold(FIXTURE.slice(0, 4));
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.kind, 'permission');
  assert.equal(s.block?.tool, 'Bash');
  assert.equal(s.block?.detail, 'touch hello.txt');
  assert.equal(s.block?.toolUseId, 'toolu_A1');
});

test('AskUserQuestion PermissionRequest blocks with a question and its 3 options', () => {
  const s = fold(FIXTURE.slice(0, 11));
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.kind, 'question');
  assert.equal(s.block?.tool, 'AskUserQuestion');
  assert.equal(s.block?.detail, 'Which fruit?');
  assert.deepEqual(s.block?.questions, [
    {
      question: 'Which fruit?',
      options: [
        { label: 'Apple', description: 'Apple' },
        { label: 'Banana', description: 'Banana' },
        { label: 'Cherry', description: 'Cherry' },
      ],
    },
  ]);
});

test('permission detail falls back to file_path, then JSON, capped at 200 chars', () => {
  const edit = { file_path: '/tmp/a.txt', old_string: 'a', new_string: 'b' };
  assert.equal(fold([pre('e1', 'Edit', edit), ask('Edit', edit)], started()).block?.detail, '/tmp/a.txt');
  const web = { url: 'https://example.com', prompt: 'x'.repeat(500) };
  const d = fold([pre('w1', 'WebFetch', web), ask('WebFetch', web)], started()).block?.detail ?? '';
  assert.ok(d.startsWith('{"url":"https://example.com"'));
  assert.ok(d.length <= 200);
  // The hook falls back to a plain string when an input cannot keep its shape.
  assert.equal(fold([ask('Bash', 'clipped…')], started()).block?.detail, 'clipped…');
});

test('denial path: PermissionRequest then a main UserPromptSubmit goes back to work with no block', () => {
  const s = fold([...FIXTURE.slice(0, 4), ev('UserPromptSubmit', { session: 's-0001', prompt: 'never mind', synthetic: false })]);
  assert.equal(s.state, 'work');
  assert.equal(s.block, undefined);
  assert.equal(s.task, 'Create an empty file hello.txt');
});

test('a main Stop clears a block', () => {
  const s = fold([...FIXTURE.slice(0, 4), ev('Stop', { session: 's-0001' })]);
  assert.equal(s.state, 'ready');
  assert.equal(s.block, undefined);
});

test('a Stop or UserPromptSubmit from a subagent leaves the block and the state alone', () => {
  const cmd = { command: 'touch q' };
  const blocked = fold([pre('m1', 'Bash', cmd), ask('Bash', cmd)], started());
  const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
  for (const l of [ev('Stop', sub), ev('UserPromptSubmit', { ...sub, prompt: 'x', synthetic: false }), ev('StopFailure', sub)]) {
    const s = reduce(blocked, l);
    assert.equal(s.state, 'blocked', l.event);
    assert.equal(s.block?.toolUseId, 'm1', l.event);
  }
});

test('waitingOn is capped at 200 chars', () => {
  const long = 'gh run watch ' + '9'.repeat(400);
  assert.ok((reduce(started(), pre('w9', 'Bash', { command: long })).waitingOn ?? '').length <= 200);
  assert.ok((reduce(started(), ev('MaitreStatus', { session: '', status: 'waiting', text: 'x'.repeat(400) })).waitingOn ?? '').length <= 200);
});

test('parallel tools: only the blocked call clears the block', () => {
  const a = { command: 'ls' };
  const b = { command: 'touch b' };
  let s = fold([pre('tA', 'Bash', a), pre('tB', 'Bash', b), ask('Bash', b)], started());
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.toolUseId, 'tB');
  s = reduce(s, pre('tC', 'Read', { file_path: '/x' }));
  assert.equal(s.state, 'blocked', 'a parallel PreToolUse does not clear the block');
  s = reduce(s, post('tA', 'Bash', a));
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.toolUseId, 'tB');
  s = reduce(s, post('tB', 'Bash', b));
  assert.equal(s.state, 'work');
  assert.equal(s.block, undefined);
});

test('PermissionRequest pairs with the most recent matching PreToolUse, never a finished one', () => {
  const cmd = { command: 'touch x' };
  let s = fold([pre('t1', 'Bash', cmd), post('t1', 'Bash', cmd), pre('t2', 'Bash', cmd), pre('t3', 'Bash', { command: 'other' })], started());
  s = reduce(s, ask('Bash', cmd));
  assert.equal(s.block?.toolUseId, 't2');
  s = reduce(s, post('t3', 'Bash', { command: 'other' }));
  assert.equal(s.state, 'blocked');
  s = reduce(s, ev('PostToolUseFailure', { tool: 'Bash', tool_use_id: 't2', response: { is_error: true } }));
  assert.equal(s.state, 'work');
  assert.equal(s.block, undefined);
});

test('a block with an unknown id clears on any PostToolUse, but not on PermissionDenied', () => {
  const blocked = fold([ask('Bash', { command: 'touch y' })], started());
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.block?.toolUseId, undefined);
  const denied = reduce(blocked, ev('PermissionDenied', { tool: 'Bash', tool_use_id: 'tz', input: { command: 'touch y' } }));
  assert.equal(denied.state, 'blocked');
  const cleared = reduce(blocked, post('tz', 'Bash', { command: 'touch y' }));
  assert.equal(cleared.state, 'work');
  assert.equal(cleared.block, undefined);
});

test('PermissionDenied clears only on the exact id and is a no-op without a block', () => {
  const cmd = { command: 'rm -rf ../outside' };
  const blocked = fold([pre('d1', 'Bash', cmd), ask('Bash', cmd)], started());
  assert.equal(reduce(blocked, ev('PermissionDenied', { tool: 'Bash', tool_use_id: 'other', input: cmd })).state, 'blocked');
  const cleared = reduce(blocked, ev('PermissionDenied', { tool: 'Bash', tool_use_id: 'd1', input: cmd }));
  assert.equal(cleared.state, 'work');
  assert.equal(cleared.block, undefined);
  const free = fold([pre('d2', 'Bash', cmd)], started());
  const after = reduce(free, ev('PermissionDenied', { tool: 'Bash', tool_use_id: 'd2', input: cmd }));
  assert.equal(after.state, 'work');
  assert.equal(after.since, free.since);
});

test('a PostToolUse without its PreToolUse is tolerated', () => {
  const s = reduce(started(), post('ghost', 'Bash', { command: 'ls' }));
  assert.equal(s.state, 'work');
  const fail = reduce(started(), ev('PostToolUseFailure', { tool: 'Bash', tool_use_id: 'ghost2' }));
  assert.equal(fail.state, 'work');
  const fresh = reduce(undefined, post('ghost3', 'Bash', { command: 'ls' }));
  assert.equal(fresh.state, 'work');
});

test('a subagent PermissionRequest blocks the room and its PostToolUse unblocks it', () => {
  const cmd = { command: 'npm test' };
  const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
  let s = fold([ev('Stop', { background_running: 1 }), pre('s1', 'Bash', cmd, sub), ask('Bash', cmd, sub)], started());
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.toolUseId, 's1');
  assert.equal(s.block?.detail, 'npm test');
  s = reduce(s, post('s1', 'Bash', cmd, sub));
  assert.equal(s.state, 'work');
  assert.equal(s.block, undefined);
});

test("a subagent's SubagentStop clears its own block, and the main Stop then leaves the room ready", () => {
  const cmd = { command: 'npm test' };
  const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
  const asked = fold([ev('Stop', { background_running: 1 }), pre('s1', 'Bash', cmd, sub), ask('Bash', cmd, sub)], started());
  assert.equal(asked.block?.agentId, 'a1');
  const other = reduce(asked, ev('SubagentStop', { agent_id: 'a2', agent_type: 'Explore' }));
  assert.equal(other.state, 'blocked', "another subagent's stop leaves the block");
  const done = reduce(asked, ev('SubagentStop', sub));
  assertBlockedInvariant(done, 'after SubagentStop');
  assert.equal(done.block, undefined);
  assert.equal(done.state, 'work');
  const stopped = reduce(done, ev('Stop'));
  assert.equal(stopped.state, 'ready');
  assert.equal(stopped.block, undefined);
  // Its pending call is gone too: a late request with the same input no longer pairs with it.
  const late = reduce(stopped, ask('Bash', cmd));
  assert.equal(late.block?.toolUseId, undefined);
  assert.equal(late.block?.agentId, undefined);
});

test('a SubagentStop leaves a declared block and the main agent\'s block alone', () => {
  const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
  const declared = fold([ev('MaitreStatus', { status: 'blocked', text: 'Which env?', options: ['dev'] }), ev('SubagentStop', sub)], started());
  assert.equal(declared.state, 'blocked');
  assert.equal(declared.block?.tool, 'maitre status');
  const mainAsk = fold([pre('m1', 'Bash', { command: 'ls' }), ask('Bash', { command: 'ls' }), ev('SubagentStop', sub)], started());
  assert.equal(mainAsk.state, 'blocked');
  assert.equal(mainAsk.block?.toolUseId, 'm1');
});

test('subagent tool calls push steps but leave the main state alone', () => {
  const s0 = reduce(started(), ev('Stop'));
  const s1 = reduce(s0, pre('s2', 'Grep', { pattern: 'TODO' }, { agent_id: 'a1', agent_type: 'Explore' }));
  assert.equal(s1.state, 'ready');
  assert.equal(s1.steps.at(-1), 'Grep: TODO');
});

test('steps keep the last 5 and inputs are shortened', () => {
  const long = 'echo ' + 'x'.repeat(300);
  const s = fold(
    [1, 2, 3, 4, 5, 6].map((n) => pre(`p${n}`, 'Bash', { command: n === 6 ? long : `echo ${n}` })),
    started(),
  );
  assert.equal(s.steps.length, 5);
  assert.equal(s.steps[0], 'Bash: echo 2');
  assert.ok(s.steps[4]!.startsWith('Bash: echo xxx'));
  assert.ok(s.steps[4]!.length <= 100);
});

test('the task is the first non-synthetic prompt, capped at 120 chars', () => {
  const s = fold([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt: '<task-notification>x</task-notification>', synthetic: true }),
    ev('UserPromptSubmit', { prompt: 'Fix the bug '.repeat(30), synthetic: false }),
    ev('UserPromptSubmit', { prompt: 'and then this', synthetic: false }),
  ]);
  assert.ok(s.task.startsWith('Fix the bug Fix'));
  assert.ok(s.task.length <= 120);
});

test("the task skips the reception brief's header line", () => {
  const s = fold([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt: '# Brief from the maître reception\n\nadd a README line saying hello', synthetic: false }),
  ]);
  assert.equal(s.task, 'add a README line saying hello');
});

test('watch commands set smoke until their own PostToolUse', () => {
  const watch = { command: 'gh pr checks 12 --watch' };
  let s = reduce(started(), pre('w1', 'Bash', watch));
  assert.equal(s.state, 'smoke');
  assert.equal(s.waitingOn, 'gh pr checks 12 --watch');
  s = reduce(s, pre('r1', 'Read', { file_path: '/x' }));
  assert.equal(s.state, 'smoke');
  s = reduce(s, post('r1', 'Read', { file_path: '/x' }));
  assert.equal(s.state, 'smoke');
  s = reduce(s, post('w1', 'Bash', watch));
  assert.equal(s.state, 'work');
  assert.equal(s.waitingOn, undefined);
  for (const cmd of ['gh run watch 99', 'kubectl get pods --watch', 'gh pr checks']) {
    assert.equal(reduce(started(), pre('w2', 'Bash', { command: cmd })).state, 'smoke', cmd);
  }
  assert.equal(reduce(started(), pre('w3', 'Bash', { command: 'gh pr view 12' })).state, 'work');
});

test('MaitreStatus waiting/working/blocked', () => {
  const waiting = reduce(started(), ev('MaitreStatus', { session: '', status: 'waiting', text: 'CI' }));
  assert.equal(waiting.state, 'smoke');
  assert.equal(waiting.waitingOn, 'CI');
  assert.equal(waiting.session, 's-1', 'a CLI line without the session id never resets the room');
  // The declaration runs inside a Bash call; that call's own PostToolUse keeps the room smoking.
  const postWait = reduce(waiting, post('m1', 'Bash', { command: 'maitre status waiting "CI"' }));
  assert.equal(postWait.state, 'smoke');
  assert.equal(reduce(postWait, pre('m2', 'Bash', { command: 'sleep 60' })).state, 'smoke');
  const working = reduce(postWait, ev('MaitreStatus', { session: '', status: 'working', text: 'fixing' }));
  assert.equal(working.state, 'work');
  assert.equal(working.waitingOn, undefined);
  const blocked = reduce(started(), ev('MaitreStatus', { session: '', status: 'blocked', text: 'Merge now?', options: ['Yes', 'No'] }));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.block?.kind, 'question');
  assert.equal(blocked.block?.detail, 'Merge now?');
  assert.deepEqual(blocked.block?.questions, [{ question: 'Merge now?', options: [{ label: 'Yes' }, { label: 'No' }] }]);
  assert.equal(blocked.block?.toolUseId, undefined);
});

const declare = (status: 'waiting' | 'working' | 'blocked', text: string, options?: string[]) =>
  ev('MaitreStatus', { session: '', status, text, ...(options ? { options } : {}) });

// The room runs `maitre status ...` through Bash: PreToolUse, the MaitreStatus line, then PostToolUse.
function declaredVia(status: 'waiting' | 'blocked', text: string): HookLine[] {
  const cmd = { command: `maitre status ${status} "${text}"` };
  return [pre('ms', 'Bash', cmd), declare(status, text), post('ms', 'Bash', cmd)];
}

test('a declared block survives its own Bash call, other tool results and a main Stop', () => {
  let s = fold(declaredVia('blocked', 'Merge now?'), started());
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.detail, 'Merge now?');
  s = fold(
    [
      post('unknown', 'Bash', { command: 'ls' }),
      ev('PostToolUseFailure', { tool: 'Bash', tool_use_id: 'other' }),
      ev('PermissionDenied', { tool: 'Bash', tool_use_id: 'other' }),
      ev('Stop'),
      ev('StopFailure'),
      ev('UserPromptSubmit', { prompt: '<task-notification>x</task-notification>', synthetic: true }),
    ],
    s,
  );
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.tool, 'maitre status');
});

test('a declared wait survives tool results and a main Stop keeps smoke', () => {
  let s = fold(declaredVia('waiting', 'CI'), started());
  assert.equal(s.state, 'smoke');
  s = fold([post('unknown', 'Bash', { command: 'ls' }), ev('PostToolUseFailure', { tool: 'Bash', tool_use_id: 'x' })], s);
  assert.equal(s.state, 'smoke');
  s = reduce(s, ev('Stop'));
  assert.equal(s.state, 'smoke');
  assert.equal(s.waitingOn, 'CI');
  s = reduce(s, ev('UserPromptSubmit', { prompt: '<task-notification>x</task-notification>', synthetic: true }));
  assert.equal(s.state, 'smoke');
  // A watch command does not take over a declared wait.
  s = fold([pre('w5', 'Bash', { command: 'gh pr checks --watch' }), post('w5', 'Bash', { command: 'gh pr checks --watch' })], s);
  assert.equal(s.state, 'smoke');
  assert.equal(s.waitingOn, 'CI');
});

test('a hook block keeps its own rules under a declared wait', () => {
  const cmd = { command: 'touch h' };
  let s = fold([declare('waiting', 'CI'), pre('h1', 'Bash', cmd), ask('Bash', cmd)], started());
  assert.equal(s.state, 'blocked');
  s = reduce(s, post('h1', 'Bash', cmd));
  assert.equal(s.state, 'smoke');
  s = fold([pre('h2', 'Bash', cmd), ask('Bash', cmd), ev('Stop')], s);
  assert.equal(s.state, 'smoke');
  assert.equal(s.block, undefined);
});

test('a new MaitreStatus replaces the declared state', () => {
  const blocked = fold([declare('blocked', 'Merge now?')], started());
  const working = reduce(blocked, declare('working', 'merging'));
  assert.equal(working.state, 'work');
  assert.equal(working.block, undefined);
  const waiting = reduce(blocked, declare('waiting', 'CI'));
  assert.equal(waiting.state, 'smoke');
  assert.equal(waiting.block, undefined);
  const reblocked = reduce(waiting, declare('blocked', 'Deploy?', ['Yes']));
  assert.equal(reblocked.state, 'blocked');
  assert.equal(reblocked.waitingOn, undefined);
  assert.equal(reblocked.block?.detail, 'Deploy?');
  // After working, the declaration no longer holds the room on Stop.
  assert.equal(reduce(reduce(waiting, declare('working', 'x')), ev('Stop')).state, 'ready');
});

test('a main non-synthetic prompt, an exit or a new session clears declared states', () => {
  for (const d of [declare('blocked', 'Merge now?'), declare('waiting', 'CI')]) {
    const s = fold([d], started());
    const spoke = reduce(s, ev('UserPromptSubmit', { prompt: 'go', synthetic: false }));
    assert.equal(spoke.state, 'work');
    assert.equal(spoke.block, undefined);
    assert.equal(spoke.waitingOn, undefined);
    assert.equal(reduce(spoke, ev('Stop')).state, 'ready');
    for (const end of [ev('SessionEnd'), ev('MaitreExit', { session: '' })]) {
      const gone = reduce(s, end);
      assert.equal(gone.state, 'exit');
      assert.equal(gone.block, undefined);
      assert.equal(gone.waitingOn, undefined);
    }
    const next = reduce(s, ev('SessionStart', { session: 's-2' }));
    assert.equal(next.state, 'coffee');
    assert.equal(next.block, undefined);
    assert.equal(next.waitingOn, undefined);
    assert.equal(reduce(next, ev('Stop', { session: 's-2' })).state, 'ready');
    // A same-session SessionStart (compact, resume) keeps the declaration.
    assert.notEqual(reduce(s, ev('SessionStart')).state, 'coffee');
  }
});

test('MaitreExit and SessionEnd leave the room', () => {
  assert.equal(reduce(started(), ev('MaitreExit', { session: '' })).state, 'exit');
  assert.equal(reduce(started(), ev('SessionEnd')).state, 'exit');
});

test('an exited room stays exited for its own late lines; a SessionStart or a new session reopens it', () => {
  const sid = { session: 's-0001' };
  const gone = fold(FIXTURE);
  assert.equal(gone.state, 'exit');
  const late = [
    post('late', 'Bash', { command: 'ls' }, sid),
    pre('late2', 'Bash', { command: 'ls' }, sid),
    ev('Stop', sid),
    ev('UserPromptSubmit', { ...sid, prompt: 'hi', synthetic: false }),
    ev('PermissionRequest', { ...sid, tool: 'Bash', input: { command: 'ls' } }),
    ev('Notification', { ...sid, notification_type: 'idle_prompt' }),
    ev('MaitreStatus', { session: '', status: 'working', text: 'x' }),
    ev('MaitreStatus', { session: '', status: 'blocked', text: 'x' }),
    ev('MaitreExit', { session: '' }),
    ev('PreToolUse', { session: '', tool: 'Bash', tool_use_id: 'e', input: {} }),
  ];
  for (const l of late) assert.equal(reduce(gone, l), gone, `${l.event} must not revive the room`);
  // --resume keeps the session id: its SessionStart reopens the room with a fresh state.
  const resumed = reduce(gone, ev('SessionStart', sid));
  assert.equal(resumed.state, 'coffee');
  assert.equal(resumed.session, 's-0001');
  assert.equal(resumed.since, resumed.updatedAt);
  assert.deepEqual(resumed.subagents, []);
  assert.deepEqual(resumed.steps, []);
  assert.equal(resumed.prUrl, undefined);
  assert.equal(resumed.task, '');
  assert.equal(resumed.model, 'haiku');
  const next = reduce(gone, ev('SessionStart', { session: 's-0002' }));
  assert.equal(next.state, 'coffee');
  assert.equal(next.session, 's-0002');
  assert.equal(next.since, next.updatedAt);
  assert.equal(reduce(gone, ev('UserPromptSubmit', { session: 's-0003', prompt: 'hi', synthetic: false })).state, 'work');
  assert.equal(reduce(gone, pre('n', 'Bash', { command: 'ls' }, { session: 's-0004' })).state, 'work');
  // A room that only ever saw the CLI's MaitreExit (no session id yet) reopens on the first hook session.
  const bare = reduce(undefined, ev('MaitreExit', { session: '' }));
  assert.equal(bare.state, 'exit');
  assert.equal(reduce(bare, ev('Stop', { session: '' })), bare);
  const opened = reduce(bare, ev('SessionStart', { session: 's-0005' }));
  assert.equal(opened.state, 'coffee');
  assert.equal(opened.session, 's-0005');
});

test('StopFailure goes ready with an error step', () => {
  const s = reduce(started(), ev('StopFailure'));
  assert.equal(s.state, 'ready');
  assert.equal(s.steps.at(-1), 'stopped with an error');
});

test('Notification changes nothing but updatedAt', () => {
  const s0 = started();
  const s1 = reduce(s0, ev('Notification', { notification_type: 'idle_prompt', message: 'waiting' }));
  assert.equal(s1.state, s0.state);
  assert.equal(s1.since, s0.since);
  assert.ok(s1.updatedAt > s0.updatedAt);
});

test('a new session id resets subagents, block, task and PR', () => {
  const old = fold(FIXTURE.slice(0, 18));
  const blocked = fold(
    [
      post('x0', 'Bash', { command: 'gh pr create' }, { session: 's-0001', response: { stdout: 'https://github.com/acme/app/pull/7' } }),
      ev('MaitreStatus', { session: '', status: 'waiting', text: 'CI' }),
      pre('x1', 'Bash', { command: 'touch z' }, { session: 's-0001' }),
      ask('Bash', { command: 'touch z' }, { session: 's-0001' }),
    ],
    old,
  );
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.subagents.length, 1);
  assert.equal(blocked.prUrl, 'https://github.com/acme/app/pull/7');
  assert.equal(blocked.waitingOn, 'CI');
  const s = reduce(blocked, ev('SessionStart', { session: 's-0002', model: 'claude-sonnet-4-6' }));
  assert.equal(s.session, 's-0002');
  assert.equal(s.state, 'coffee');
  assert.equal(s.block, undefined);
  assert.deepEqual(s.subagents, []);
  assert.deepEqual(s.steps, []);
  assert.equal(s.task, '');
  assert.equal(s.prUrl, undefined);
  assert.equal(s.waitingOn, undefined);
  assert.equal(s.model, 'sonnet');
  // The old session's pending calls are gone too: a matching request no longer correlates.
  assert.equal(reduce(s, ask('Bash', { command: 'touch z' }, { session: 's-0002' })).block?.toolUseId, undefined);
  // A lost SessionStart: any hook event with a new session id also resets.
  const s2 = reduce(blocked, ev('UserPromptSubmit', { session: 's-0003', prompt: 'hi', synthetic: false }));
  assert.equal(s2.session, 's-0003');
  assert.deepEqual(s2.subagents, []);
  assert.equal(s2.task, 'hi');
  assert.equal(s2.model, 'haiku', 'the model is kept when the new session did not announce one');
});

test('a SessionStart with the same session id keeps the room', () => {
  const s = reduce(fold(FIXTURE.slice(0, 18)), ev('SessionStart', { session: 's-0001' }));
  assert.equal(s.state, 'coffee');
  assert.equal(s.subagents.length, 1);
  assert.equal(s.task, 'Create an empty file hello.txt');
});

test('gh pr create stdout with a PR URL then Stop goes whisky', () => {
  const cmd = { command: 'gh pr create --fill' };
  const s = fold(
    [pre('p1', 'Bash', cmd), post('p1', 'Bash', cmd, { response: { stdout: 'Creating pull request\nhttps://github.com/acme/app/pull/34\n' } }), ev('Stop')],
    started(),
  );
  assert.equal(s.prUrl, 'https://github.com/acme/app/pull/34');
  assert.equal(s.state, 'whisky');
});

test('subagents register in either order and are removed on their SubagentStop', () => {
  const agent = { description: 'x', prompt: 'y', subagent_type: 'Explore' };
  const reg = post('g1', 'Agent', agent, { response: { agentId: 'a7', resolvedModel: 'claude-sonnet-4-6' } });
  const start = ev('SubagentStart', { agent_id: 'a7', agent_type: 'Explore' });
  const expected = [{ id: 'a7', type: 'Explore', model: 'sonnet' }];
  assert.deepEqual(fold([reg, start], started()).subagents, expected);
  assert.deepEqual(fold([start, reg], started()).subagents, expected);
  assert.deepEqual(fold([start], started()).subagents, [{ id: 'a7', type: 'Explore', model: 'unknown' }]);
  assert.deepEqual(fold([reg, start, ev('SubagentStop', { agent_id: 'a7', agent_type: 'Explore' })], started()).subagents, []);
});

test('a late PostToolUse(Agent) after its SubagentStop does not bring the guest back', () => {
  const agent = { description: 'x', prompt: 'y', subagent_type: 'Explore' };
  const late = (aid: string) => post(`g-${aid}`, 'Agent', agent, { response: { agentId: aid, resolvedModel: 'claude-haiku-5-5' } });
  const startA = (aid: string) => ev('SubagentStart', { agent_id: aid, agent_type: 'Explore' });
  const stopA = (aid: string) => ev('SubagentStop', { agent_id: aid, agent_type: 'Explore' });
  assert.deepEqual(fold([startA('f1'), stopA('f1'), late('f1')], started()).subagents, []);
  // Bounded: after 50 newer finished guests, the oldest id is forgotten.
  const many: HookLine[] = [startA('f0'), stopA('f0')];
  for (let i = 1; i <= 50; i++) many.push(startA(`n${i}`), stopA(`n${i}`));
  assert.deepEqual(fold([...many, late('n1')], started()).subagents, []);
  assert.deepEqual(fold([...many, late('f0')], started()).subagents.map((a) => a.id), ['f0']);
});

test('a subagent block survives the main Stop and synthetic prompts, and clears on its own result', () => {
  const cmd = { command: 'npm test' };
  const sub = { agent_id: 'a1', agent_type: 'general-purpose' };
  const launch = post('g1', 'Agent', { description: 'x', prompt: 'y' }, { response: { agentId: 'a1', resolvedModel: 'claude-haiku-5-5' } });
  let s = fold([pre('g1', 'Agent', { description: 'x', prompt: 'y' }), launch, ev('SubagentStart', sub), pre('s1', 'Bash', cmd, sub), ask('Bash', cmd, sub)], started());
  assert.equal(s.block?.agentId, 'a1');
  s = reduce(s, ev('Stop', { background_running: 1 }));
  assert.equal(s.state, 'blocked');
  assert.equal(s.block?.toolUseId, 's1');
  s = reduce(s, ev('UserPromptSubmit', { prompt: '<task-notification>x</task-notification>', synthetic: true }));
  assert.equal(s.state, 'blocked');
  s = reduce(s, ev('StopFailure'));
  assert.equal(s.state, 'blocked');
  const answered = reduce(s, post('s1', 'Bash', cmd, sub));
  assert.equal(answered.state, 'work');
  assert.equal(answered.block, undefined);
  const spoke = reduce(s, ev('UserPromptSubmit', { prompt: 'stop that', synthetic: false }));
  assert.equal(spoke.state, 'work');
  assert.equal(spoke.block, undefined);
  // A request that arrives with agent_id but without a pending call is still the subagent's.
  const orphan = fold([ask('Bash', { command: 'x' }, sub), ev('Stop', { background_running: 1 })], started());
  assert.equal(orphan.state, 'blocked');
});

test('a running background shell does not keep the room working', () => {
  const stop = (tasks: unknown[]) =>
    throughHook([JSON.stringify({ hook_event_name: 'Stop', session_id: 's-1', background_tasks: tasks })])[0]!;
  const shell = { id: 'b1', type: 'shell', status: 'running', description: 'npm run dev' };
  const agent = { id: 'a1', type: 'subagent', status: 'running', agent_type: 'Explore' };
  assert.equal(reduce(started(), stop([shell])).state, 'ready');
  assert.equal(reduce(started(), stop([shell, agent])).state, 'work');
});

test('events from an older session never reset or change the room', () => {
  const old = fold(FIXTURE.slice(0, 18));
  const cleared = reduce(old, ev('SessionStart', { session: 's-0002', model: 'claude-haiku-5-5' }));
  assert.equal(cleared.session, 's-0002');
  for (const late of ['SessionEnd', 'Stop', 'SubagentStop', 'PostToolUse', 'PermissionRequest', 'Notification']) {
    const s = reduce(cleared, ev(late, { session: 's-0001', agent_id: late === 'SubagentStop' ? 'a1' : undefined, agent_type: 'x', tool: 'Bash', tool_use_id: 't' }));
    assert.equal(s, cleared, late);
  }
  const after = fold([ev('SessionEnd', { session: 's-0001' }), ev('UserPromptSubmit', { session: 's-0002', prompt: 'hi', synthetic: false })], cleared);
  assert.equal(after.state, 'work');
  assert.equal(after.session, 's-0002');
  // PreToolUse with a new id opens a new session too (its SessionStart and prompt were lost).
  assert.equal(reduce(cleared, pre('n1', 'Bash', { command: 'ls' }, { session: 's-0003' })).session, 's-0003');
});

test('stale main pending calls are dropped on a new prompt and on Stop; subagent calls survive', () => {
  const cmd = { command: 'touch s' };
  const denied = fold([pre('t1', 'Bash', cmd), ask('Bash', cmd)], started());
  const reprompt = fold([ev('UserPromptSubmit', { prompt: 'again', synthetic: false }), ask('Bash', cmd)], denied);
  assert.equal(reprompt.block?.toolUseId, undefined);
  const stopped = fold([ev('Stop'), ask('Bash', cmd)], denied);
  assert.equal(stopped.block?.toolUseId, undefined);
  const sub = { agent_id: 'a1', agent_type: 'Explore' };
  const kept = fold([pre('s9', 'Bash', cmd, sub), ev('Stop', { background_running: 1 }), ask('Bash', cmd, sub)], started());
  assert.equal(kept.block?.toolUseId, 's9');
});

test('reduce is total: odd inputs never throw', () => {
  const junk = (extra: Record<string, unknown>) => ({ ...ev('Bogus'), ...extra }) as unknown as HookLine;
  const odd: HookLine[] = [
    junk({ event: undefined }),
    junk({ event: 42 }),
    junk({ event: 'MaitreStatus', status: 'blocked', text: 5, options: 'Yes' }),
    junk({ event: 'MaitreStatus', status: 'blocked', options: { a: 1 } }),
    junk({ event: 'MaitreStatus', status: 'waiting', text: { x: 1 } }),
    junk({ event: 'MaitreExit', session: 7 }),
    junk({ event: 'SessionStart', model: 7 }),
    junk({ event: 'PostToolUse', tool: 'Agent', response: { agentId: 5, resolvedModel: 3 } }),
    junk({ event: 'PostToolUse', tool: 'Bash', response: 'x' }),
    junk({ event: 'PostToolUse', tool: 'Bash', response: null }),
    junk({ event: 'PostToolUse', tool: 7, tool_use_id: 8 }),
    junk({ event: 'SubagentStart', agent_id: 'a1', agent_type: 5 }),
    junk({ event: 'UserPromptSubmit', prompt: 5 }),
    junk({ event: 'Stop', background_running: '3' }),
    junk({ event: 'PreToolUse', tool: 'Bash', tool_use_id: 'z', input: null }),
    ev('Bogus'),
    ev('PreToolUse'),
    ev('PreToolUse', { tool: 'Bash', input: 'a string' }),
    ev('PreToolUse', { tool: 'AskUserQuestion', tool_use_id: 'q', input: { questions: 'nope' } }),
    ev('PermissionRequest', { tool: 'AskUserQuestion', input: { questions: [null, { question: 1, options: [{}, 'x'] }] } }),
    ev('PermissionRequest'),
    ev('PostToolUse', { tool: 'Agent', response: {} }),
    ev('PostToolUse', { tool: 'Bash', response: { stdout: 'no url' } }),
    ev('SubagentStart'),
    ev('SubagentStop'),
    ev('MaitreStatus'),
    ev('MaitreStatus', { status: 'blocked' }),
    ev('UserPromptSubmit'),
  ];
  for (const l of odd) {
    assert.doesNotThrow(() => reduce(undefined, l), l.event);
    assert.doesNotThrow(() => reduce(started(), l), l.event);
  }
  for (const l of odd) {
    const s = reduce(started(), l);
    assertBlockedInvariant(s, l.event);
  }
});

test('pending correlation state stays off the wire', () => {
  const cmd = { command: 'touch w' };
  const s = fold([pre('j1', 'Bash', cmd), ask('Bash', cmd)], started());
  const wire = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  const allowed = new Set(['room', 'session', 'model', 'state', 'since', 'updatedAt', 'task', 'steps', 'block', 'subagents', 'prUrl', 'waitingOn']);
  for (const k of Object.keys(wire)) assert.ok(allowed.has(k), `unexpected key on the wire: ${k}`);
  assert.equal(JSON.stringify(wire).includes('"pending'), false);
});

test('the pending map is bounded to the last 20 calls', () => {
  const first = { command: 'touch first' };
  const calls = [pre('k0', 'Bash', first)];
  for (let i = 1; i <= 20; i++) calls.push(pre(`k${i}`, 'Read', { file_path: `/f${i}` }));
  const s = fold([...calls, ask('Bash', first)], started());
  assert.equal(s.block?.toolUseId, undefined, 'the 21st-oldest call was dropped');
  const s2 = fold([...calls.slice(0, 20), ask('Bash', first)], started());
  assert.equal(s2.block?.toolUseId, 'k0');
});

test("a subagent's hand-back prompt is synthetic: it keeps a declared wait", () => {
  const handBack = FIXTURE.find((l) => l.event === 'UserPromptSubmit' && (l.prompt ?? '').startsWith('<agent-message'));
  assert.ok(handBack);
  assert.equal(handBack.synthetic, true);
  const waiting = reduce(started(), ev('MaitreStatus', { session: '', status: 'waiting', text: 'CI' }));
  assert.equal(waiting.state, 'smoke');
  const after = reduce(deepFreeze(waiting), { ...handBack, session: 's-1', ts: clock + 10 });
  assert.equal(after.state, 'smoke');
  assert.equal(after.waitingOn, 'CI');
});

test('a starting block from maître clears on the room\'s SessionStart; a declared block does not', () => {
  const starting = fold([ev('MaitreStatus', { session: '', status: 'blocked', text: 'Room is still starting — check its tab', options: [], starting: true })]);
  assert.equal(starting.state, 'blocked');
  const up = reduce(starting, ev('SessionStart', { model: 'claude-haiku-5-5' }));
  assert.equal(up.state, 'coffee');
  assert.equal(up.block, undefined);

  const viaPrompt = reduce(starting, ev('UserPromptSubmit', { prompt: 'go', synthetic: false }));
  assert.equal(viaPrompt.block, undefined);

  const declared = fold([declare('blocked', 'Merge now?', ['Yes'])], started());
  assert.equal(reduce(declared, ev('SessionStart', {})).state, 'blocked', 'only a starting block clears on SessionStart');
  const replaced = fold([ev('MaitreStatus', { session: '', status: 'blocked', text: 's', starting: true }), declare('blocked', 'Merge now?')]);
  assert.equal(reduce(replaced, ev('SessionStart', {})).state, 'blocked', 'a later declared block is not a starting one');
});

test('Stop keeps the last reply; the next prompt clears it', () => {
  const s1 = reduce(started(), ev('Stop', { last_message: 'São 14:52 de quinta.' }));
  assert.equal(s1.reply, 'São 14:52 de quinta.');
  assert.equal(reduce(s1, ev('Stop', { last_message: '   ' })).reply, 'São 14:52 de quinta.');
  assert.equal(reduce(s1, ev('UserPromptSubmit', { prompt: 'e amanhã?' })).reply, undefined);
  assert.equal(reduce(s1, ev('UserPromptSubmit', { prompt: '<task-notification>', synthetic: true })).reply, 'São 14:52 de quinta.');
  const long = reduce(started(), ev('Stop', { last_message: `  \n${'x'.repeat(900)}` })).reply ?? '';
  assert.equal(long.length, 500);
  assert.ok(long.startsWith('x') && long.endsWith('…'));
  assert.equal(reduce(started(), ev('Stop', { last_message: '  \nok\n' })).reply, 'ok');
  assert.equal(reduce(started(), ev('Stop', { last_message: '😀'.repeat(600) })).reply, `${'😀'.repeat(499)}…`);
  assert.equal(reduce(started(), ev('Stop', { agent_id: 'a1', last_message: 'from a subagent' })).reply, undefined);
});
