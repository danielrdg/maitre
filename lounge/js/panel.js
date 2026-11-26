import { t } from './i18n.js';
import { MODEL } from './sprites.js';

// Every piece of agent-sourced text goes through textContent.

const letter = i => String.fromCharCode(65 + i);

// A live block is read-only: answering from the lounge comes later, so the room's terminal answers.
function liveBlock(b, lang) {
  const questions = (b.questions || []).map(q => ({
    text: q.question,
    options: (q.options || []).map((o, i) => ({ key: letter(i), text: o.label, detail: o.description || '' })),
  }));
  return {
    readOnly: true,
    intro: b.kind === 'permission' ? t('panel.permission', lang, { tool: b.tool }) : null,
    reason: questions.length ? null : b.detail,
    questions,
    note: t('panel.answerInTerminal', lang),
  };
}

function usageFor(info, lang, now) {
  if (!info.live) {
    return { usageLabel: t('panel.inRoom', lang), usage: t('panel.usage', lang, { minutes: info.minutes ?? 0, tokens: info.tokens ?? '—' }) };
  }
  if (!Number.isFinite(info.since)) return { usageLabel: undefined, usage: undefined };
  const minutes = Math.max(0, Math.floor((now - info.since) / 60000));
  return { usageLabel: t('panel.inState', lang), usage: t('panel.minutes', lang, { minutes }) };
}

export function panelModel(agent, lang = 'en', now = Date.now()) {
  const info = agent.info || {};
  const modelKey = MODEL[agent.look.model] && agent.look.model !== 'tux' ? agent.look.model : 'queued';
  const b = agent.state === 'blocked' ? info.block : undefined;
  // Only a live room's main agent has a terminal; a subagent's id is `<room>/<id>`.
  const room = info.live && !String(agent.id).includes('/') ? String(agent.id) : undefined;
  const block = !b ? undefined : b.kind ? liveBlock(b, lang) : {
    reason: b.reason,
    options: b.options.map((o, i) => ({ key: 'ABC'[i], text: o.text, detail: o.detail, recommended: !!o.recommended })),
  };
  return {
    title: agent.label === 'haiku' ? agent.id : agent.label,
    model: t(`model.${modelKey}`, lang),
    modelColor: MODEL[modelKey][0],
    stateKey: agent.state,
    state: t(`state.${agent.state}`, lang),
    task: info.task || '—',
    where: info.where || '—',
    steps: [...(info.steps || [])],
    minutes: info.minutes ?? 0,
    tokens: info.tokens ?? '—',
    ...usageFor(info, lang, now),
    ...(room === undefined ? {} : { terminal: true, room }),
    block,
  };
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// `code` spans in agent text become bold, still as text nodes.
export function appendMarked(doc, parent, text) {
  String(text).split('`').forEach((part, i) => {
    if (!part) return;
    parent.append(i % 2 ? el(doc, 'b', null, part) : doc.createTextNode(part));
  });
}

// Fills a translated template where some {vars} are DOM nodes.
function appendTemplate(doc, parent, template, vars) {
  for (const part of template.split(/(\{\w+\})/)) {
    const m = /^\{(\w+)\}$/.exec(part);
    const v = m ? vars[m[1]] : part;
    if (v == null || v === '') continue;
    parent.append(typeof v === 'string' ? doc.createTextNode(v) : v);
  }
}

// onTerminal() resolves to null when the terminal opened, else to the error message.
function terminalRow(doc, lang, onTerminal, error) {
  const row = el(doc, 'div', 'term');
  const btn = el(doc, 'button', 'opt', t('panel.openTerminal', lang));
  const err = el(doc, 'div', 'termerr');
  const showError = message => {
    err.textContent = message ? t('panel.terminalFailed', lang, { message }) : '';
    err.style.display = message ? '' : 'none';
  };
  showError(error);
  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    new Promise(r => r(onTerminal()))
      .then(showError, e => showError(String(e?.message ?? e)))
      .finally(() => { btn.disabled = false; });
  });
  row.append(btn, err);
  return row;
}

export function renderPanel(root, model, onAnswer, { lang = 'en', portrait = null, onClose = null, onTerminal = null, terminalError = null } = {}) {
  const doc = root.ownerDocument;
  root.replaceChildren();

  const close = el(doc, 'button', 'x', '×');
  close.title = t('panel.close', lang);
  close.addEventListener('click', () => onClose && onClose());

  const head = el(doc, 'div', 'head');
  const pic = el(doc, 'div');
  if (portrait) pic.append(portrait);
  const id = el(doc, 'div');
  const modelChip = el(doc, 'span', 'chip', model.model);
  modelChip.style.background = model.modelColor;
  const stateChip = el(doc, 'span', 'chip', model.state);
  stateChip.style.background = model.block ? '#ff8b7b' : '#f7e7c6';
  id.append(el(doc, 'h4', null, model.title), modelChip, stateChip);
  head.append(pic, id);

  const list = el(doc, 'ul');
  for (const s of model.steps) list.append(el(doc, 'li', null, s));

  root.append(
    close, head,
    el(doc, 'div', 'lbl', t('panel.doing', lang)), el(doc, 'div', null, model.task),
    el(doc, 'div', 'lbl', t('panel.where', lang)), el(doc, 'div', null, model.where),
    el(doc, 'div', 'lbl', t('panel.steps', lang)), list,
  );
  if (model.usage != null) root.append(el(doc, 'div', 'lbl', model.usageLabel), el(doc, 'div', null, model.usage));
  if (model.terminal && onTerminal) root.append(terminalRow(doc, lang, onTerminal, terminalError));

  if (model.block?.readOnly) {
    root.append(readOnlyBlock(doc, model.block, lang));
    return;
  }

  const done = el(doc, 'div');
  if (model.block) {
    const stuck = el(doc, 'div', 'stuck');
    stuck.append(el(doc, 'b', null, t('panel.blocked', lang)), doc.createTextNode(' '));
    appendMarked(doc, stuck, model.block.reason);

    const answer = (key, text) => {
      stuck.remove();
      const msg = el(doc, 'div', 'done');
      appendTemplate(doc, msg, t('panel.done', lang), { name: el(doc, 'b', null, model.title), key, text });
      done.replaceChildren(msg);
      onAnswer({ key, text });
    };

    for (const o of model.block.options) {
      const b = el(doc, 'button', 'opt');
      b.append(el(doc, 'span', 'k', o.key), doc.createTextNode(o.text));
      if (o.recommended) b.append(el(doc, 'span', 'rec', t('panel.recommended', lang)));
      b.append(el(doc, 'small', null, o.detail));
      b.addEventListener('click', () => answer(o.key, o.text));
      stuck.append(b);
    }

    const other = el(doc, 'div', 'other');
    const input = el(doc, 'input');
    input.placeholder = t('panel.other', lang);
    const send = el(doc, 'button', 'send', t('panel.send', lang));
    const submit = () => { const v = input.value.trim(); if (v) answer(t('panel.freeText', lang), v); };
    send.addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    other.append(input, send);
    stuck.append(other);
    root.append(stuck);
  }
  root.append(done);
}

// Agent text stays verbatim here: a command's backticks are not markup.
function readOnlyBlock(doc, block, lang) {
  const stuck = el(doc, 'div', 'stuck');
  const head = el(doc, 'div', null);
  head.append(el(doc, 'b', null, t('panel.blocked', lang)));
  if (block.intro) head.append(doc.createTextNode(' ' + block.intro));
  stuck.append(head);
  if (block.reason) stuck.append(el(doc, 'div', block.intro ? 'cmd' : 'q', block.reason));
  for (const q of block.questions) {
    if (q.text) stuck.append(el(doc, 'div', 'q', q.text));
    for (const o of q.options) {
      const row = el(doc, 'div', 'ro');
      row.append(el(doc, 'span', 'k', o.key), doc.createTextNode(o.text));
      if (o.detail) row.append(el(doc, 'small', null, o.detail));
      stuck.append(row);
    }
  }
  stuck.append(el(doc, 'div', 'note', block.note));
  return stuck;
}

export const MUSIC_STYLES = ['off', 'jazz', 'house'];

export function musicMenuModel(style, volume, lang = 'en') {
  return {
    title: t('music.title', lang),
    quip: t('quip.sax', lang),
    options: MUSIC_STYLES.map(key => ({ key, label: t(`music.${key}`, lang), selected: key === style })),
    volume: Math.round(Math.max(0, Math.min(1, volume)) * 100),
    volumeLabel: t('music.volume', lang),
    close: t('panel.close', lang),
  };
}

export function renderMusicMenu(root, model, { onStyle = null, onVolume = null, onClose = null } = {}) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const close = el(doc, 'button', 'x', '×');
  close.title = model.close;
  close.addEventListener('click', () => onClose && onClose());

  const row = el(doc, 'div', 'seg');
  for (const o of model.options) {
    const b = el(doc, 'button', 'opt' + (o.selected ? ' on' : ''), o.label);
    b.setAttribute('aria-pressed', String(o.selected));
    b.addEventListener('click', () => onStyle && onStyle(o.key));
    row.append(b);
  }

  const vol = el(doc, 'input', 'vol');
  vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.step = '1';
  vol.value = String(model.volume);
  vol.setAttribute('aria-label', model.volumeLabel);
  vol.addEventListener('input', () => onVolume && onVolume(Number(vol.value) / 100));

  root.append(close, el(doc, 'h4', null, model.title), el(doc, 'div', 'quip', model.quip), row,
    el(doc, 'div', 'lbl', model.volumeLabel), vol);
}
