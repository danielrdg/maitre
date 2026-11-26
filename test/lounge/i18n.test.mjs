import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATE_KEYS, STRINGS, t } from '../../lounge/js/i18n.js';

const EXPECTED = ['queue', 'coffee', 'work', 'slot', 'smoke', 'visitor', 'boss', 'blocked', 'ready', 'whisky', 'dance', 'sleep', 'exit'];

test('STATE_KEYS lists the 13 states in order', () => {
  assert.deepEqual([...STATE_KEYS], EXPECTED);
});

test('every state has non-empty en and pt-BR strings', () => {
  for (const k of STATE_KEYS) {
    for (const lang of ['en', 'pt-BR']) {
      const s = STRINGS[lang][`state.${k}`];
      assert.equal(typeof s, 'string', `${lang} state.${k}`);
      assert.ok(s.trim().length > 0, `${lang} state.${k}`);
    }
    assert.notEqual(t(`state.${k}`, 'pt-BR'), t(`state.${k}`, 'en'), `state.${k} is translated`);
  }
});

test('pt-BR covers every en key', () => {
  const missing = Object.keys(STRINGS.en).filter(k => !(k in STRINGS['pt-BR']));
  assert.deepEqual(missing, []);
});

test('t interpolates and falls back to English', () => {
  assert.equal(t('state.work'), 'Working');
  assert.equal(t('state.work', 'xx'), 'Working');
  assert.match(t('queue.many', 'en', { n: 3 }), /3/);
});

test('the reception, prompt and terminal strings exist in both languages', () => {
  const keys = ['reception.placeholder', 'reception.thinking', 'reception.offline', 'prompt.title', 'prompt.done', 'panel.openTerminal', 'panel.terminalFailed'];
  for (const lang of ['en', 'pt-BR']) {
    for (const k of keys) {
      assert.equal(typeof STRINGS[lang][k], 'string', `${lang} ${k}`);
      assert.ok(STRINGS[lang][k].trim().length > 0, `${lang} ${k}`);
    }
  }
  assert.match(t('panel.terminalFailed', 'en', { message: 'boom' }), /boom/);
  assert.match(t('panel.terminalFailed', 'pt-BR', { message: 'boom' }), /boom/);
});
