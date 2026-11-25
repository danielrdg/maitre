import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, extname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOUNGE = join(ROOT, 'lounge');

const walk = dir => readdirSync(dir).flatMap(n => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test('lounge text assets have no external URLs or CDN references', () => {
  const files = walk(LOUNGE).filter(f => ['.html', '.css', '.js'].includes(extname(f)));
  assert.ok(files.length > 0);
  const hits = files.filter(f => /googleapis|gstatic|cdn|https?:\/\//i.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits.map(f => f.slice(ROOT.length + 1)), []);
});

test('font files and OFL licenses are bundled', () => {
  for (const f of ['PixelifySans[wght].ttf', 'Silkscreen-Regular.ttf', 'Silkscreen-Bold.ttf']) {
    assert.ok(existsSync(join(LOUNGE, 'fonts', f)), f);
  }
  for (const f of ['OFL-PixelifySans.txt', 'OFL-Silkscreen.txt']) {
    const p = join(LOUNGE, 'fonts', f);
    assert.ok(existsSync(p), f);
    assert.match(readFileSync(p, 'utf8'), /SIL Open Font License/);
  }
});

test('style.css declares @font-face for each bundled file with swap', () => {
  const css = readFileSync(join(LOUNGE, 'style.css'), 'utf8');
  const faces = css.match(/@font-face\s*{[^}]*}/g) ?? [];
  assert.equal(faces.length, 3);
  for (const f of ['PixelifySans%5Bwght%5D.ttf', 'Silkscreen-Regular.ttf', 'Silkscreen-Bold.ttf']) {
    assert.ok(faces.some(b => b.includes(`url('fonts/${f}')`)), f);
  }
  assert.ok(faces.every(b => /font-display:\s*swap/.test(b)));
  assert.match(css, /font-weight:\s*400 700/);
});
