import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../src/cli.js';
import { openApp } from '../src/open-app.js';

test('parseArgs parses lounge flags', () => {
  assert.deepEqual(parseArgs(['lounge', '--demo', '--port', '9000', '--no-open', '--lang', 'pt-BR']), {
    cmd: 'lounge',
    demo: true,
    port: 9000,
    open: false,
    lang: 'pt-BR',
  });
});

test('parseArgs defaults', () => {
  assert.deepEqual(parseArgs(['lounge']), { cmd: 'lounge', demo: false, port: 8737, open: true, lang: 'en' });
  assert.equal(parseArgs([]).cmd, 'help');
  assert.equal(parseArgs(['--version']).cmd, 'version');
});

test('openApp returns false without a display', () => {
  assert.equal(openApp('http://x', {}), false);
});

test('bin/maitre asks for a build when dist/ is missing', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dir = mkdtempSync(join(tmpdir(), 'maitre-bin-'));
  try {
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(root, 'bin', 'maitre'), join(dir, 'bin', 'maitre'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    const r = spawnSync(process.execPath, [join(dir, 'bin', 'maitre'), '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Run `npm run build` first/);
    assert.doesNotMatch(r.stderr, /ERR_MODULE_NOT_FOUND/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
