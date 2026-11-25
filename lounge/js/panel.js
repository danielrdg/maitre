import { t } from './i18n.js';
import { MODEL } from './sprites.js';

// Every piece of agent-sourced text goes through textContent.

export function panelModel(agent, lang = 'en') {
  const info = agent.info || {};
  const modelKey = MODEL[agent.look.model] && agent.look.model !== 'tux' ? agent.look.model : 'queued';
  const block = agent.state === 'blocked' && info.block ? {
    reason: info.block.reason,
    options: info.block.options.map((o, i) => ({ key: 'ABC'[i], text: o.text, detail: o.detail, recommended: !!o.recommended })),
  } : undefined;
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
function appendMarked(doc, parent, text) {
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

export function renderPanel(root, model, onAnswer, { lang = 'en', portrait = null, onClose = null } = {}) {
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
    el(doc, 'div', 'lbl', t('panel.inRoom', lang)),
    el(doc, 'div', null, t('panel.usage', lang, { minutes: model.minutes, tokens: model.tokens })),
  );

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
