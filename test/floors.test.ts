import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FloorError, THEME_IDS, isThemeId, openFloors, pickTheme, readFloors, setTheme } from '../src/floors.js';

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function home(): { env: NodeJS.ProcessEnv; warnings: string[]; warn: (w: string) => void; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'maitre-floors-'));
  made.push(dir);
  const warnings: string[] = [];
  return { env: { MAITRE_HOME: dir }, warnings, warn: (w) => void warnings.push(w), file: join(dir, 'state', 'floors.json') };
}

const stored = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));
const short = (fs: { project: string; floor: number; theme: string; locked: boolean }[]) => fs.map((f) => [f.project, f.floor, f.theme, f.locked]);

function config(env: NodeJS.ProcessEnv, value: unknown): void {
  mkdirSync(env.MAITRE_HOME!, { recursive: true });
  writeFileSync(join(env.MAITRE_HOME!, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}

test('THEME_IDS are the six themes in pick order; isThemeId accepts only them', () => {
  assert.deepEqual([...THEME_IDS], ['casino', 'deco', 'tiki', 'karaoke', 'garden', 'hall']);
  for (const t of THEME_IDS) assert.equal(isThemeId(t), true);
  for (const t of ['disco', 'Hall', '', null, 3, undefined, 'constructor']) assert.equal(isThemeId(t), false, String(t));
});

test('the first project gets floor 1 casino, the second floor 2 deco; written to state/floors.json', () => {
  const h = home();
  assert.deepEqual(short(openFloors(['webshop'], h.env, h.warn)), [['webshop', 1, 'casino', false]]);
  assert.deepEqual(short(openFloors(['webshop', 'api'], h.env, h.warn)), [
    ['webshop', 1, 'casino', false],
    ['api', 2, 'deco', false],
  ]);
  assert.deepEqual(stored(h.file), { webshop: { floor: 1, theme: 'casino' }, api: { floor: 2, theme: 'deco' } });
  assert.deepEqual(readFloors(h.env, h.warn), { webshop: { floor: 1, theme: 'casino' }, api: { floor: 2, theme: 'deco' } });
});

test('scratch gets its own number and always hall, never the pick, sent as locked', () => {
  const h = home();
  assert.deepEqual(short(openFloors(['webshop', 'scratch'], h.env, h.warn)), [
    ['webshop', 1, 'casino', false],
    ['scratch', 2, 'hall', true],
  ]);
  const first = home();
  assert.deepEqual(short(openFloors(['scratch'], first.env, first.warn)), [['scratch', 1, 'hall', true]]);
  assert.deepEqual(short(openFloors(['scratch', 'api'], first.env, first.warn)), [
    ['scratch', 1, 'hall', true],
    ['api', 2, 'casino', false],
  ]);
});

test('a closed floor leaves the list; reopening keeps its number and theme; numbers are never reused', () => {
  const h = home();
  openFloors(['webshop', 'api'], h.env, h.warn);
  assert.deepEqual(short(openFloors(['api'], h.env, h.warn)), [['api', 2, 'deco', false]]);
  assert.deepEqual(short(openFloors(['mobile', 'api'], h.env, h.warn)), [
    ['api', 2, 'deco', false],
    ['mobile', 3, 'casino', false],
  ], 'a theme freed by a closed floor is reused by a new project');
  assert.deepEqual(short(openFloors(['webshop', 'mobile', 'api'], h.env, h.warn)), [
    ['webshop', 1, 'casino', false],
    ['api', 2, 'deco', false],
    ['mobile', 3, 'casino', false],
  ], 'the closed floor keeps its own theme and number');
  assert.deepEqual(stored(h.file), {
    webshop: { floor: 1, theme: 'casino' },
    api: { floor: 2, theme: 'deco' },
    mobile: { floor: 3, theme: 'casino' },
  });
});

test('nothing is written when no entry is added, and no open project reads or writes nothing', () => {
  const h = home();
  assert.deepEqual(openFloors([], h.env, h.warn), []);
  assert.equal(existsSync(h.file), false);
  assert.deepEqual(h.warnings, []);
  openFloors(['webshop'], h.env, h.warn);
  const before = statSync(h.file);
  openFloors(['webshop'], h.env, h.warn);
  openFloors([], h.env, h.warn);
  const now = statSync(h.file);
  assert.equal(now.mtimeMs, before.mtimeMs);
  assert.equal(now.ino, before.ino);
});

test('with all six themes worn, a 7th project gets a stable hash pick, the same on every call and home', () => {
  const h = home();
  const six = ['webshop', 'api', 'mobile', 'docs', 'site', 'scratch'];
  const floors = openFloors(six, h.env, h.warn);
  assert.deepEqual(floors.map((f) => f.theme).sort(), [...THEME_IDS].sort());
  const all = new Set<string>(THEME_IDS);
  const pick = pickTheme(all, 'billing');
  assert.equal(isThemeId(pick), true);
  for (let i = 0; i < 5; i++) assert.equal(pickTheme(new Set(THEME_IDS), 'billing'), pick);
  const seventh = openFloors([...six, 'billing'], h.env, h.warn).find((f) => f.project === 'billing');
  assert.deepEqual(seventh, { project: 'billing', floor: 7, theme: pick, locked: false });
  const spread = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((p) => pickTheme(all, p)));
  assert.ok(spread.size > 1, 'the hash spreads names over the themes');
  assert.equal(pickTheme(new Set(['casino']), 'billing'), 'deco', 'free themes come first, in pick order');
});

test('a config theme wins for display, locked; the stored theme stays; a bad override warns and is ignored', () => {
  const h = home();
  config(h.env, { projects: { webshop: { theme: 'tiki' }, api: { theme: 'disco' }, mobile: null, docs: 'x' } });
  const floors = openFloors(['webshop', 'api', 'mobile', 'docs'], h.env, h.warn);
  assert.deepEqual(short(floors), [
    ['webshop', 1, 'tiki', true],
    ['api', 2, 'casino', false],
    ['mobile', 3, 'deco', false],
    ['docs', 4, 'karaoke', false],
  ], 'the pick skips themes worn by open floors as shown (tiki from config)');
  assert.deepEqual((stored(h.file) as Record<string, unknown>).webshop, { floor: 1, theme: 'casino' });
  assert.equal(h.warnings.filter((w) => w.includes('projects.api.theme')).length, 1, h.warnings.join('\n'));
  openFloors(['webshop', 'api'], h.env, h.warn);
  assert.equal(h.warnings.filter((w) => w.includes('projects.api.theme')).length, 1, 'warned once per config file version');
});

test('a config theme for scratch is ignored: the scratch floor is always hall', () => {
  const h = home();
  config(h.env, { projects: { scratch: { theme: 'tiki' } } });
  assert.deepEqual(short(openFloors(['scratch'], h.env, h.warn)), [['scratch', 1, 'hall', true]]);
});

test('a corrupt config.json never throws: no overrides and a warning', () => {
  const h = home();
  config(h.env, '{nope');
  assert.deepEqual(short(openFloors(['webshop'], h.env, h.warn)), [['webshop', 1, 'casino', false]]);
  assert.ok(h.warnings.some((w) => w.includes('config.json')), h.warnings.join('\n'));
});

test('a missing floors.json reads as {} with a warning; a corrupt one too, kept as floors.json.bad-<time> by the next write', () => {
  const h = home();
  assert.deepEqual(readFloors(h.env, h.warn), {});
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0]!, /floors\.json/);
  const c = home();
  mkdirSync(join(c.env.MAITRE_HOME!, 'state'), { recursive: true });
  writeFileSync(c.file, '{broken');
  assert.deepEqual(readFloors(c.env, c.warn), {});
  assert.equal(c.warnings.length, 1);
  assert.match(c.warnings[0]!, /floors\.json/);
  assert.deepEqual(short(openFloors(['api'], c.env, c.warn)), [['api', 1, 'casino', false]]);
  assert.deepEqual(stored(c.file), { api: { floor: 1, theme: 'casino' } });
  const kept = readdirSync(join(c.env.MAITRE_HOME!, 'state')).filter((n) => n.startsWith('floors.json.bad-'));
  assert.equal(kept.length, 1, kept.join(', '));
  assert.match(kept[0]!, /^floors\.json\.bad-\d+$/);
  assert.equal(readFileSync(join(c.env.MAITRE_HOME!, 'state', kept[0]!), 'utf8'), '{broken');
  assert.match(c.warnings[0]!, new RegExp(kept[0]!.replace(/\./g, '\\.').replace(/\d+$/, '\\d+')));
  assert.equal(c.warnings.length, 1, 'warned once');
  openFloors(['api', 'docs'], c.env, c.warn);
  assert.equal(readdirSync(join(c.env.MAITRE_HOME!, 'state')).filter((n) => n.startsWith('floors.json.bad-')).length, 1, 'a sound file is not kept');
  for (const bad of ['[1,2]', 'null', '"x"']) {
    writeFileSync(c.file, bad);
    assert.deepEqual(readFloors(c.env, c.warn), {}, bad);
  }
});

test('odd entries in floors.json are dropped with a warning; the next number follows the valid ones', () => {
  const h = home();
  mkdirSync(join(h.env.MAITRE_HOME!, 'state'), { recursive: true });
  writeFileSync(
    h.file,
    '{"webshop":{"floor":4,"theme":"tiki"},"api":{"floor":0,"theme":"deco"},"mobile":{"floor":2,"theme":"disco"},"docs":"x","__proto__":{"floor":3,"theme":"hall"}}',
  );
  const read = readFloors(h.env, h.warn);
  assert.deepEqual(Object.keys(read).sort(), ['__proto__', 'webshop']);
  assert.equal(Object.getPrototypeOf(read), Object.prototype, 'a project named __proto__ is a plain entry');
  assert.deepEqual(read.webshop, { floor: 4, theme: 'tiki' });
  assert.equal(h.warnings.length, 3, h.warnings.join('\n'));
  assert.deepEqual(short(openFloors(['api'], h.env, h.warn)), [['api', 5, 'casino', false]]);
});

test('setTheme stores the theme in floors.json only; unknown project or theme, or a locked one, throw FloorError', () => {
  const h = home();
  config(h.env, { projects: { api: { theme: 'garden' } } });
  const cfgBefore = readFileSync(join(h.env.MAITRE_HOME!, 'config.json'), 'utf8');
  openFloors(['webshop', 'api'], h.env, h.warn);
  assert.deepEqual(setTheme('webshop', 'karaoke', h.env, h.warn), { project: 'webshop', floor: 1, theme: 'karaoke', locked: false });
  assert.deepEqual((stored(h.file) as Record<string, unknown>).webshop, { floor: 1, theme: 'karaoke' });
  assert.deepEqual(short(openFloors(['webshop'], h.env, h.warn)), [['webshop', 1, 'karaoke', false]]);
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof FloorError, String(err));
      return err.code;
    }
    return 'no error';
  };
  assert.equal(code(() => setTheme('ghost', 'tiki', h.env, h.warn)), 'unknown-project');
  assert.equal(code(() => setTheme('constructor', 'tiki', h.env, h.warn)), 'unknown-project');
  assert.equal(code(() => setTheme('webshop', 'disco', h.env, h.warn)), 'unknown-theme');
  assert.equal(code(() => setTheme('api', 'tiki', h.env, h.warn)), 'locked');
  assert.equal(readFileSync(join(h.env.MAITRE_HOME!, 'config.json'), 'utf8'), cfgBefore);
  const floorsBefore = readFileSync(h.file, 'utf8');
  for (const theme of ['tiki', 'hall']) assert.equal(code(() => setTheme('scratch', theme, h.env, h.warn)), 'locked', `scratch ${theme}`);
  assert.equal(readFileSync(h.file, 'utf8'), floorsBefore, 'no scratch entry and no number minted');
  assert.deepEqual(short(openFloors(['scratch'], h.env, h.warn)), [['scratch', 3, 'hall', true]]);
  openFloors(['scratch'], h.env, h.warn);
  assert.equal(code(() => setTheme('scratch', 'hall', h.env, h.warn)), 'locked', 'stored or not');
});
