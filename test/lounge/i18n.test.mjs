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

test('the building strings (view switcher, lift, chip, floor list) exist in both languages', () => {
  const keys = [
    'view.facade', 'view.floor', 'view.lobby', 'lift.label', 'lift.lobby', 'lift.roof', 'lift.floor',
    'chip.needsYou', 'chip.needsYouAlone', 'chip.more', 'floors.title', 'floors.row', 'facade.roof', 'facade.roofSub', 'facade.lobby', 'facade.lobbySub',
    'facade.rooms.one', 'facade.rooms.many', 'facade.needsYou', 'floor.title', 'floor.wentDown', 'tip.level', 'neon.terrace',
    'theme.hall', 'theme.casino', 'theme.deco', 'theme.tiki', 'theme.karaoke', 'theme.garden',
    'theme.button', 'theme.buttonLocked', 'theme.config', 'theme.scratch', 'theme.failed',
  ];
  for (const lang of ['en', 'pt-BR']) {
    for (const k of keys) {
      assert.equal(typeof STRINGS[lang][k], 'string', `${lang} ${k}`);
      assert.ok(STRINGS[lang][k].trim().length > 0, `${lang} ${k}`);
    }
  }
  for (const k of ['view.facade', 'view.lobby', 'chip.needsYou', 'floors.title', 'floor.wentDown', 'theme.button', 'theme.config', 'theme.scratch', 'theme.failed']) assert.notEqual(t(k, 'pt-BR'), t(k, 'en'), `${k} is translated`);
  assert.equal(t('lift.floor', 'en', { n: 3, project: 'api' }), 'floor 3 · api');
  assert.match(t('chip.needsYou', 'pt-BR', { name: 'r1', project: 'api' }), /r1.*api/);
});

test('the lift buttons and the facade name the roof and the lobby with the same letter', () => {
  for (const lang of ['en', 'pt-BR']) {
    assert.ok(t('facade.roof', lang).startsWith(`${t('lift.roofKey', lang)} · `), `${lang}: ${t('facade.roof', lang)}`);
    assert.ok(t('facade.lobby', lang).startsWith(`${t('lift.lobbyKey', lang)} · `), `${lang}: ${t('facade.lobby', lang)}`);
  }
});

test('the en and pt-BR tables have the same keys', () => {
  assert.deepEqual(Object.keys(STRINGS['pt-BR']).sort(), Object.keys(STRINGS.en).sort());
});
