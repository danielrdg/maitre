import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { sendRequest, replyView, openTerminal, wakeRoom, receptionSession, promptPlacement, loungePlacement, CLOSE_AFTER_MS } from '../../lounge/js/reception.js';
import { t } from '../../lounge/js/i18n.js';

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === 'function' ? reply(url, init) : reply;
  };
  fn.calls = calls;
  return fn;
}

test('sendRequest posts JSON with the maître header and no answers key when there is none', async () => {
  const f = fakeFetch(json(200, { kind: 'question', id: '7', text: 'Which repo?' }));
  const reply = await sendRequest('fix the login', undefined, f);
  assert.deepEqual(reply, { kind: 'question', id: '7', text: 'Which repo?' });
  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'api/reception');
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers['x-maitre-request'], '1');
  assert.deepEqual(JSON.parse(init.body), { text: 'fix the login' });
  assert.equal('answers' in JSON.parse(init.body), false);
});

test('sendRequest sends answers when it answers a question', async () => {
  const f = fakeFetch(json(200, { kind: 'dispatched', id: '7', room: 'api', lines: ['sent to api'], needsYou: false }));
  await sendRequest('the api repo', '7', f);
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'the api repo', answers: '7' });
});

test('sendRequest maps a rejected fetch to the offline message', async () => {
  const f = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await sendRequest('hi', undefined, f), { kind: 'error', message: t('reception.offline') });
  assert.deepEqual(await sendRequest('hi', undefined, f, 'pt-BR'), { kind: 'error', message: t('reception.offline', 'pt-BR') });
});

test('sendRequest passes the server error shape through on a non-200', async () => {
  const f = fakeFetch(json(429, { kind: 'error', message: 'the maître is busy, try again' }));
  assert.deepEqual(await sendRequest('hi', undefined, f), { kind: 'error', message: 'the maître is busy, try again' });
});

test('sendRequest turns a body that is not a reply into an error instead of throwing', async () => {
  const notJson = { ok: false, status: 403, json: async () => { throw new SyntaxError('Unexpected token'); } };
  const r1 = await sendRequest('hi', undefined, fakeFetch(notJson));
  assert.equal(r1.kind, 'error');
  assert.ok(r1.message.length > 0);
  const r2 = await sendRequest('hi', undefined, fakeFetch(json(200, { kind: 'surprise' })));
  assert.equal(r2.kind, 'error');
  const r3 = await sendRequest('hi', undefined, fakeFetch(json(200, { kind: 'dispatched', id: '1', room: 'r', lines: 'nope', needsYou: false })));
  assert.equal(r3.kind, 'error');
});

test('replyView: a dispatched reply with nothing to look at closes after 3 s', () => {
  const v = replyView({ kind: 'dispatched', id: '3', room: 'api', lines: ['room api created', 'sent'], needsYou: false }, 'en');
  assert.deepEqual(v, { balloon: 'room api created\nsent', keepOpen: false, closeAfterMs: 3000 });
  assert.equal(CLOSE_AFTER_MS, 3000);
});

test('replyView: a dispatched reply that needs you stays open', () => {
  const v = replyView({ kind: 'dispatched', id: '3', room: 'api', lines: ['room api created', 'answer the folder-trust question in its terminal'], needsYou: true }, 'en');
  assert.deepEqual(v, { balloon: 'room api created\nanswer the folder-trust question in its terminal', keepOpen: true });
  assert.equal('closeAfterMs' in v, false);
});

test('replyView: a question stays open and carries the id to answer', () => {
  assert.deepEqual(replyView({ kind: 'question', id: '12', text: 'Which repo?' }, 'en'),
    { balloon: 'Which repo?', keepOpen: true, answers: '12' });
});

test('replyView: an error stays open with its message', () => {
  assert.deepEqual(replyView({ kind: 'error', message: 'the maître is busy, try again' }, 'en'),
    { balloon: 'the maître is busy, try again', keepOpen: true });
});

test('receptionSession threads the question id into the answer and ignores a double submit', async () => {
  let release;
  const replies = [
    json(200, { kind: 'question', id: '4', text: 'Which repo?' }),
    json(429, { kind: 'error', message: 'the maître is busy, try again' }),
    json(200, { kind: 'dispatched', id: '4', room: 'api', lines: ['sent'], needsYou: false }),
    json(200, { kind: 'question', id: '5', text: 'And then?' }),
  ];
  const f = fakeFetch(() => new Promise(r => { release = () => r(replies.shift()); }));
  const s = receptionSession({ fetchImpl: f });

  const first = s.submit('fix the login');
  assert.equal(s.busy, true);
  assert.equal(await s.submit('again'), null, 'a second submit while one is in flight is dropped');
  assert.equal(await s.submit('   '), null);
  release();
  assert.deepEqual(await first, { kind: 'question', view: { balloon: 'Which repo?', keepOpen: true, answers: '4' } });
  assert.equal(s.busy, false);

  const busy = s.submit('the api repo'); release(); await busy;
  const ok = s.submit('the api repo'); release(); await ok;
  assert.deepEqual(f.calls.map(c => JSON.parse(c.init.body)), [
    { text: 'fix the login' },
    { text: 'the api repo', answers: '4' },
    { text: 'the api repo', answers: '4' },
  ], 'an error keeps the pending answer, a dispatch clears it');

  const next = s.submit('new thing'); release(); await next;
  assert.deepEqual(JSON.parse(f.calls[3].init.body), { text: 'new thing' });
  s.reset();
  const after = s.submit('fresh'); release(); await after;
  assert.deepEqual(JSON.parse(f.calls[4].init.body), { text: 'fresh' }, 'reset drops the pending question');
});

test('receptionSession frees itself when the fetch throws', async () => {
  const s = receptionSession({ fetchImpl: async () => { throw new Error('down'); } });
  const v = await s.submit('hi');
  assert.deepEqual(v, { kind: 'error', view: { balloon: t('reception.offline'), keepOpen: true } });
  assert.equal(s.busy, false);
});

test('openTerminal posts to the room terminal endpoint and reports errors', async () => {
  const ok = fakeFetch(json(200, { kind: 'ok' }));
  assert.deepEqual(await openTerminal('my room', ok), { ok: true });
  assert.equal(ok.calls[0].url, 'api/rooms/my%20room/terminal');
  assert.equal(ok.calls[0].init.method, 'POST');
  assert.equal(ok.calls[0].init.headers['x-maitre-request'], '1');
  assert.equal(ok.calls[0].init.headers['content-type'], 'application/json');
  assert.equal(ok.calls[0].init.body, '{}');

  assert.deepEqual(await openTerminal('api', fakeFetch(json(409, { kind: 'error', message: 'api is not running' }))),
    { ok: false, message: 'api is not running' });
  const down = await openTerminal('api', async () => { throw new TypeError('Failed to fetch'); });
  assert.deepEqual(down, { ok: false, message: t('reception.offline') });
  const odd = await openTerminal('api', fakeFetch({ ok: false, status: 404, json: async () => { throw new SyntaxError('x'); } }));
  assert.equal(odd.ok, false);
  assert.ok(odd.message.length > 0);
});

test('promptPlacement centers 560x180 in the work area, offsets included', () => {
  assert.deepEqual(promptPlacement({ availLeft: 66, availTop: 32, availWidth: 1854, availHeight: 1048 }), { x: 713, y: 466 });
  assert.deepEqual(promptPlacement({ availWidth: 1920, availHeight: 1080 }), { x: 680, y: 450 });
});

test('loungePlacement grows a window that opened at the prompt size to 1280x800, centered in the work area', () => {
  const screen = { availLeft: 66, availTop: 32, availWidth: 1854, availHeight: 1048 };
  assert.deepEqual(loungePlacement({ outerWidth: 560, outerHeight: 180 }, screen), { w: 1280, h: 800, x: 353, y: 156 });
  assert.deepEqual(loungePlacement({ outerWidth: 1000, outerHeight: 300 }, { availWidth: 1920, availHeight: 1080 }), { w: 1280, h: 800, x: 320, y: 140 });
  assert.deepEqual(loungePlacement({ outerWidth: 600, outerHeight: 700 }, { availWidth: 1920, availHeight: 1080 }), { w: 1280, h: 800, x: 320, y: 140 });
});

test('loungePlacement clamps to a small work area', () => {
  assert.deepEqual(loungePlacement({ outerWidth: 560, outerHeight: 180 }, { availLeft: 0, availTop: 27, availWidth: 1024, availHeight: 741 }), { w: 1024, h: 741, x: 0, y: 27 });
});

test('loungePlacement leaves a window the user sized alone, and does nothing when the size is unknown', () => {
  const screen = { availWidth: 1920, availHeight: 1080 };
  assert.equal(loungePlacement({ outerWidth: 640, outerHeight: 400 }, screen), null);
  assert.equal(loungePlacement({ outerWidth: 1920, outerHeight: 1080 }, screen), null);
  assert.equal(loungePlacement({ outerWidth: 0, outerHeight: 0 }, screen), null);
  assert.equal(loungePlacement({}, screen), null);
  assert.equal(loungePlacement({ outerWidth: 560, outerHeight: 180 }, {}), null);
  assert.equal(loungePlacement({ outerWidth: 560, outerHeight: 180 }, { availWidth: 0, availHeight: 0 }), null);
});

test('the lounge and the prompt ask Chrome not to offer a translation', () => {
  for (const page of ['index.html', 'prompt.html']) {
    const html = readFileSync(new URL(`../../lounge/${page}`, import.meta.url), 'utf8');
    assert.match(html, /<html lang="en" translate="no">/, page);
    assert.match(html, /<meta name="google" content="notranslate">/, page);
  }
});

test('wakeRoom posts to the room wake endpoint and hands back the wake lines or the error', async () => {
  const ok = fakeFetch(json(200, { kind: 'woken', room: 'my room', lines: ['woke my room: resumed its session'], needsYou: false }));
  assert.deepEqual(await wakeRoom('my room', ok), { ok: true, lines: ['woke my room: resumed its session'] });
  assert.equal(ok.calls[0].url, 'api/rooms/my%20room/wake');
  assert.equal(ok.calls[0].init.method, 'POST');
  assert.equal(ok.calls[0].init.headers['x-maitre-request'], '1');
  assert.deepEqual(await wakeRoom('p', fakeFetch(json(409, { kind: 'error', message: 'p is closing' }))), { ok: false, message: 'p is closing' });
  assert.deepEqual(await wakeRoom('p', async () => { throw new TypeError('Failed to fetch'); }), { ok: false, message: t('reception.offline') });
  const odd = await wakeRoom('p', fakeFetch(json(200, { kind: 'woken', lines: [5] })));
  assert.equal(odd.ok, false);
  assert.ok(odd.message.length > 0);
});

test('a reply the user never saw is held: a hidden question never captures the next text', async () => {
  const replies = [
    json(200, { kind: 'question', id: '7', text: 'Which repo?' }),
    json(200, { kind: 'dispatched', id: '8', room: 'x', lines: ['ok'], needsYou: false }),
  ];
  const f = fakeFetch(() => replies.shift());
  const s = receptionSession({ fetchImpl: f });
  const reply = await s.submit('fix the login');
  s.hold(reply);
  assert.equal(s.held, reply, 'kept for the next time the box opens');
  await s.submit('something else');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { text: 'something else' }, 'not an answer to a question it never showed');
  assert.equal(s.held, null, 'a new request supersedes the unseen reply');
});

test('a held question, once shown, takes the next text as its answer', async () => {
  const f = fakeFetch(() => json(200, { kind: 'question', id: '7', text: 'Which repo?' }));
  const s = receptionSession({ fetchImpl: f });
  const reply = await s.submit('fix the login');
  s.hold(reply);
  assert.equal(s.take(), reply, 'shown when the box reopens or the lobby comes back');
  assert.equal(s.take(), null, 'only once');
  await s.submit('the api repo');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { text: 'the api repo', answers: '7' });
});

test('closing the box while a request is in flight does not drop the question it brings back', async () => {
  let release;
  const f = fakeFetch(() => (release ? json(200, { kind: 'dispatched', id: '9', room: 'x', lines: [], needsYou: false })
    : new Promise(r => { release = () => r(json(200, { kind: 'question', id: '9', text: 'Sure?' })); })));
  const s = receptionSession({ fetchImpl: f });
  const pending = s.submit('do it');
  s.reset();
  release();
  const reply = await pending;
  s.hold(reply);
  assert.equal(s.take(), reply);
  await s.submit('yes');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { text: 'yes', answers: '9' }, 'the answer still reaches its question');
});

test('resetting the box while a question is held keeps it: it is answered once shown', async () => {
  const f = fakeFetch(() => json(200, { kind: 'question', id: '41', text: 'Which project?' }));
  const s = receptionSession({ fetchImpl: f });
  s.hold(await s.submit('fix the test'));
  s.reset();
  assert.equal(s.take().view.answers, '41');
  await s.submit('webshop');
  assert.deepEqual(JSON.parse(f.calls[1].init.body), { text: 'webshop', answers: '41' });
});
