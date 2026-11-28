import { test } from 'node:test';
import assert from 'node:assert/strict';
import { saveFloorTheme, themeSwitch, withSavedTheme } from '../../lounge/js/floors-api.js';
import { themeButtonModel } from '../../lounge/js/hud.js';
import { t } from '../../lounge/js/i18n.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const text = status => ({ ok: false, status, json: async () => { throw new SyntaxError('not json'); } });
function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return typeof reply === 'function' ? reply(url, init) : reply; };
  fn.calls = calls;
  return fn;
}
const fl = (project, floor, theme, locked = false) => ({ project, floor, theme, locked });

test("saveFloorTheme posts the theme with the lounge's headers and returns the saved floor", async () => {
  const f = fakeFetch(json(200, { kind: 'ok', floor: fl('web shop', 2, 'deco') }));
  const r = await saveFloorTheme('web shop', 'deco', f);
  assert.deepEqual(r, { ok: true, floor: fl('web shop', 2, 'deco') });
  const { url, init } = f.calls[0];
  assert.equal(url, 'api/floors/web%20shop/theme');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-maitre-request'], '1');
  assert.deepEqual(JSON.parse(init.body), { theme: 'deco' });
});

test('saveFloorTheme: a 409, a plain-text 403, a bad body or no lounge are errors with a message', async () => {
  assert.deepEqual(await saveFloorTheme('api', 'deco', fakeFetch(json(409, { kind: 'error', message: 'the theme of api is set in config.json' }))),
    { ok: false, message: 'the theme of api is set in config.json' });
  assert.deepEqual(await saveFloorTheme('api', 'deco', fakeFetch(text(403))), { ok: false, message: t('reception.badReply', 'en', { status: 403 }) });
  assert.equal((await saveFloorTheme('api', 'deco', fakeFetch(json(200, { kind: 'ok', floor: { project: 'api' } })))).ok, false);
  assert.equal((await saveFloorTheme('api', 'deco', fakeFetch(json(200, { kind: 'ok', floor: fl('docs', 4, 'deco') })))).ok, false, 'another floor');
  assert.deepEqual(await saveFloorTheme('api', 'deco', async () => { throw new TypeError('fetch failed'); }, 'pt-BR'),
    { ok: false, message: t('reception.offline', 'pt-BR') });
});

test('a failed save leaves the shown theme unchanged and shows an error line', async () => {
  const floors = [fl('webshop', 1, 'casino')];
  const sw = themeSwitch({ save: async () => ({ ok: false, message: 'the lounge restarted' }) });
  assert.equal(await sw.cycle(floors, 'webshop'), null);
  assert.deepEqual(floors, [fl('webshop', 1, 'casino')]);
  const m = themeButtonModel(floors[0], sw, 'en');
  assert.equal(m.text, 'floor 1 theme: Neon casino ▸');
  assert.equal(m.error, 'Theme not saved: the lounge restarted');
  assert.equal(m.disabled, false, 'free to try again');
});

test('quick double clicks send one save; the button stays disabled until it answers', async () => {
  const floors = [fl('webshop', 1, 'casino')];
  let release, saves = [];
  const sw = themeSwitch({ save: (project, theme) => { saves.push(theme); return new Promise(r => { release = () => r({ ok: true, floor: fl(project, 1, theme) }); }); } });
  const first = sw.cycle(floors, 'webshop');
  assert.equal(themeButtonModel(floors[0], sw, 'en').disabled, true);
  assert.equal(await sw.cycle(floors, 'webshop'), null, 'the second click is dropped');
  assert.deepEqual(saves, ['deco']);
  release();
  assert.deepEqual(await first, { from: 'casino', floor: fl('webshop', 1, 'deco') });
  assert.equal(sw.busy, null);
  assert.equal(themeButtonModel(floors[0], sw, 'en').error, null);
});

test('a locked floor or one that is gone saves nothing', async () => {
  let saves = 0;
  const sw = themeSwitch({ save: async () => { saves++; return { ok: true }; } });
  assert.equal(await sw.cycle([fl('api', 2, 'tiki', true)], 'api'), null);
  assert.equal(await sw.cycle([fl('api', 2, 'tiki')], 'docs'), null);
  assert.equal(saves, 0);
});

test('the saved floor applies only while the list still shows the theme it was changed from', () => {
  const floors = [fl('webshop', 1, 'casino'), fl('api', 2, 'tiki')];
  const saved = { from: 'casino', floor: fl('webshop', 1, 'deco') };
  assert.deepEqual(withSavedTheme(floors, saved), [fl('webshop', 1, 'deco'), fl('api', 2, 'tiki')], 'the answer came before the floors event');
  assert.deepEqual(floors[0].theme, 'casino', 'a new list, the old one untouched');
  assert.equal(withSavedTheme([fl('webshop', 1, 'deco'), fl('api', 2, 'tiki')], saved), null, 'the event came first');
  assert.equal(withSavedTheme([fl('webshop', 1, 'garden')], saved), null, 'something newer is shown');
  assert.equal(withSavedTheme([fl('api', 2, 'tiki')], saved), null, 'the floor closed meanwhile');
});

test('the error stays on its floor until the user leaves it, and a save that fails after they left shows nothing', async () => {
  const floors = [fl('webshop', 1, 'casino'), fl('api', 2, 'deco')];
  const sw = themeSwitch({ save: async () => ({ ok: false, message: 'nope' }) });
  sw.seen({ view: 'floor', project: 'webshop' });
  await sw.cycle(floors, 'webshop');
  assert.deepEqual(sw.error, { project: 'webshop', message: 'nope' });
  assert.equal(sw.busy, null, 'busy clears when the answer arrives');
  sw.seen({ view: 'floor', project: 'webshop' });
  assert.notEqual(sw.error, null, 'still on that floor: the error stays');
  sw.seen({ view: 'lobby' });
  assert.equal(sw.error, null, 'leaving the floor drops it');
  sw.seen({ view: 'floor', project: 'webshop' });
  assert.equal(themeButtonModel(floors[0], sw, 'en').error, null, 'coming back shows a clean button');

  let fail;
  const late = themeSwitch({ save: () => new Promise(r => { fail = () => r({ ok: false, message: 'late' }); }) });
  late.seen({ view: 'floor', project: 'webshop' });
  const pending = late.cycle(floors, 'webshop');
  late.seen({ view: 'floor', project: 'api' });
  fail();
  assert.equal(await pending, null);
  assert.equal(late.error, null, 'the user had left: no stale error waits for them');
  assert.equal(late.busy, null);
});

test('busy clears when the save throws', async () => {
  const sw = themeSwitch({ save: async () => { throw new Error('boom'); } });
  assert.equal(await sw.cycle([fl('webshop', 1, 'casino')], 'webshop'), null);
  assert.equal(sw.busy, null);
  assert.deepEqual(sw.error, { project: 'webshop', message: 'boom' });
});

test('floors-api takes nextTheme from themes.js', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../lounge/js/floors-api.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bnextTheme\b[^}]*\} from '\.\/themes\.js'/);
});
