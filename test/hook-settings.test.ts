import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOOK_EVENTS } from '../src/events.js';
import { hookSettings, writeHookSettings } from '../src/hook-settings.js';
import { maitreHome, roomDir, roomSlug } from '../src/paths.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PermissionDenied',
];

interface Settings {
  hooks: Record<string, { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]>;
}

test('HOOK_EVENTS is exactly the 13 registered events', () => {
  assert.deepEqual([...HOOK_EVENTS].sort(), [...EVENTS].sort());
});

test('hookSettings registers exactly the 13 events, each with one quoted absolute command', () => {
  const s = hookSettings('/opt/maitre/hooks/maitre-hook.mjs', '/opt/node/bin/node') as Settings;
  assert.deepEqual(Object.keys(s), ['hooks']);
  assert.deepEqual(Object.keys(s.hooks).sort(), [...EVENTS].sort());
  for (const ev of EVENTS) {
    assert.deepEqual(s.hooks[ev], [
      { hooks: [{ type: 'command', command: '"/opt/node/bin/node" "/opt/maitre/hooks/maitre-hook.mjs"' }] },
    ], ev);
  }
});

test('hookSettings defaults to the running Node binary and resolves a relative script path', () => {
  const s = hookSettings('hooks/maitre-hook.mjs') as Settings;
  const cmd = s.hooks.Stop![0]!.hooks[0]!.command;
  const m = /^"([^"]+)" "([^"]+)"$/.exec(cmd);
  assert.ok(m, cmd);
  assert.equal(m[1], process.execPath);
  assert.ok(isAbsolute(m[2]!));
  assert.equal(m[2], join(process.cwd(), 'hooks', 'maitre-hook.mjs'));
});

test('hookSettings refuses paths that would break the shell quoting', () => {
  for (const bad of ['/tmp/a"b/hook.mjs', '/tmp/$HOME/hook.mjs', '/tmp/a`b`/hook.mjs', '/tmp/a\\b/hook.mjs']) {
    assert.throws(() => hookSettings(bad, '/usr/bin/node'), /unsafe path/);
    assert.throws(() => hookSettings('/tmp/hook.mjs', bad), /unsafe path/);
  }
});

test('writeHookSettings writes room-hooks.json under MAITRE_HOME pointing at the repo hook', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-settings-'));
  try {
    const path = writeHookSettings({ MAITRE_HOME: home });
    assert.equal(path, join(home, 'settings', 'room-hooks.json'));
    const s = JSON.parse(readFileSync(path, 'utf8')) as Settings;
    assert.deepEqual(s, hookSettings(join(ROOT, 'hooks', 'maitre-hook.mjs')));
    assert.ok(existsSync(join(ROOT, 'hooks', 'maitre-hook.mjs')));
    assert.equal(writeHookSettings({ MAITRE_HOME: home }), path, 'rewriting is fine');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the generated command runs through sh -c the way Claude Code runs it', () => {
  const home = mkdtempSync(join(tmpdir(), 'maitre-settings-'));
  try {
    const s = hookSettings(join(ROOT, 'hooks', 'maitre-hook.mjs')) as Settings;
    const input = JSON.stringify({ hook_event_name: 'Stop', session_id: 's-0001', background_tasks: [] });
    const r = spawnSync('sh', ['-c', s.hooks.Stop![0]!.hooks[0]!.command], {
      input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', MAITRE_ROOM: 't1', MAITRE_HOME: home },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
    const lines = readFileSync(join(roomDir('t1', { MAITRE_HOME: home }), 'events.jsonl'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).event, 'Stop');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('maitreHome uses MAITRE_HOME or ~/.maitre', () => {
  assert.equal(maitreHome({ MAITRE_HOME: '/tmp/mh' }), '/tmp/mh');
  assert.equal(maitreHome({}), join(homedir(), '.maitre'));
  assert.equal(maitreHome({ MAITRE_HOME: '' }), join(homedir(), '.maitre'));
});

test('maitreHome resolves a relative MAITRE_HOME to an absolute path', () => {
  assert.equal(maitreHome({ MAITRE_HOME: 'rel/home' }), join(process.cwd(), 'rel', 'home'));
  assert.ok(isAbsolute(roomDir('t1', { MAITRE_HOME: 'rel/home' })));
});

test('roomDir is $MAITRE_HOME/state/rooms/<slug>', () => {
  assert.equal(roomDir('Nf Bug!', { MAITRE_HOME: '/tmp/mh' }), '/tmp/mh/state/rooms/nf-bug');
});

test('roomSlug lowercases, keeps [a-z0-9-], caps at 40 and rejects empty names', () => {
  assert.equal(roomSlug('Nf Bug!'), 'nf-bug');
  assert.equal(roomSlug('t1'), 't1');
  assert.equal(roomSlug('  --Fix   the__API--  '), 'fix-the-api');
  assert.equal(roomSlug('../../etc/passwd'), 'etc-passwd');
  const long = roomSlug('a'.repeat(39) + '-bcdef');
  assert.equal(long, 'a'.repeat(39));
  assert.ok(roomSlug('x'.repeat(100)).length <= 40);
  assert.throws(() => roomSlug(''), /invalid room name/);
  assert.throws(() => roomSlug('!!!'), /invalid room name/);
  assert.throws(() => roomSlug('Ação'.replace(/[a-z]/gi, '')), /invalid room name/);
});
