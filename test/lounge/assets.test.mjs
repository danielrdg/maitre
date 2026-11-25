import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');

const HEADINGS = [
  'What is it', 'Features', 'Quick start', 'How it works', 'The lounge', 'States',
  'Configuration', 'maître vs firstmate', 'FAQ', 'Roadmap', 'License',
];

const IMAGES = ['docs/assets/banner.png', 'docs/assets/lounge.gif', 'docs/assets/states.png'];

test('README has every required section heading', () => {
  const found = new Set(
    readme().split('\n').filter(l => /^#{2,3} /.test(l)).map(l => l.replace(/^#+ /, '').trim()),
  );
  const missing = HEADINGS.filter(h => !found.has(h));
  assert.deepEqual(missing, []);
});

test('README references the generated art', () => {
  const md = readme();
  const missing = IMAGES.filter(p => !md.includes(p));
  assert.deepEqual(missing, []);
});

test('every local image the README shows exists', () => {
  const srcs = [...readme().matchAll(/<img [^>]*src="([^"]+)"|!\[[^\]]*\]\(([^)\s]+)/g)].map(m => m[1] || m[2]);
  const local = srcs.filter(s => !/^https?:/.test(s));
  assert.ok(local.length >= 15, `only ${local.length} local images`);
  assert.deepEqual(local.filter(s => !existsSync(join(ROOT, s))), []);
});

test('every Features row has its sprite', () => {
  const md = readme();
  const table = md.slice(md.indexOf('## Features'), md.indexOf('## Quick start'));
  const rows = table.split('\n').filter(l => l.startsWith('| <img'));
  assert.equal(rows.length, 11);
  for (const r of rows) assert.match(r, /^\| <img src="docs\/assets\/sprites\/[a-z]+\.png" width="48" alt="[^"]+" \/> \| \*\*/);
});

test('the banner is 1280x320 and the GIF is 960 wide and under 8 MB', () => {
  const png = readFileSync(join(ROOT, 'docs', 'assets', 'banner.png'));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1280, 320]);
  const gif = readFileSync(join(ROOT, 'docs', 'assets', 'lounge.gif'));
  assert.equal(gif.toString('ascii', 0, 6), 'GIF89a');
  assert.equal(gif.readUInt16LE(6), 960);
  assert.ok(gif.length <= 8 * 1024 * 1024, `${gif.length} bytes`);
});

test('README has a mermaid diagram', () => {
  assert.match(readme(), /```mermaid\n[\s\S]+?\n```/);
});

test('docs/design.md and CONTRIBUTING.md exist', () => {
  assert.ok(existsSync(join(ROOT, 'docs', 'design.md')), 'docs/design.md');
  assert.ok(existsSync(join(ROOT, 'CONTRIBUTING.md')), 'CONTRIBUTING.md');
});

const words = (process.env.MAITRE_FORBIDDEN_WORDS ?? '')
  .split(',').map(w => w.trim()).filter(Boolean);

test('no tracked file contains a forbidden word', {
  skip: words.length === 0 && 'set MAITRE_FORBIDDEN_WORDS (comma-separated) to run this check',
}, () => {
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(words.map(escape).join('|'), 'i');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  const hits = [];
  for (const f of files) {
    const p = join(ROOT, f);
    if (pattern.test(f)) hits.push(`${f} (path)`);
    if (!existsSync(p)) continue;
    if (pattern.test(readFileSync(p, 'utf8'))) hits.push(f);
  }
  assert.deepEqual(hits, []);
});
