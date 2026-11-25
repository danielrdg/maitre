import { t } from './i18n.js';

export const LEGEND = [
  { key: 'model.haiku', color: '#5fd39a' },
  { key: 'model.sonnet', color: '#5b9cf5' },
  { key: 'model.opus', color: '#a77bf0' },
  { key: 'model.fable', color: '#f2c03a' },
  { key: 'legend.queued', color: '#8f8b9c' },
  { key: 'legend.staff', color: '#24242e' },
];

export const DEMO_ACTIONS = ['block', 'merge', 'newRoom'];

export function hudModel({ demo = false } = {}) {
  return {
    buttons: ['sound', 'names', 'help', ...(demo ? ['demo'] : [])],
    demoActions: demo ? [...DEMO_ACTIONS] : [],
  };
}

function el(doc, tag, cls, text) {
  const e = doc.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Returns the created buttons by name; `actions` only holds what the model lists.
export function renderHud(root, model, lang = 'en') {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const out = { actions: {} };
  for (const name of model.buttons) {
    const b = el(doc, 'button', name);
    b.type = 'button';
    if (name === 'help') { b.textContent = '?'; b.title = t('btn.help', lang); b.setAttribute('aria-label', b.title); }
    if (name === 'demo') {
      b.textContent = t('btn.demo', lang);
      b.setAttribute('aria-haspopup', 'true');
      b.setAttribute('aria-expanded', 'false');
      const wrap = el(doc, 'div', 'wrap');
      const menu = el(doc, 'div', 'menu');
      for (const a of model.demoActions) {
        const item = el(doc, 'button', null, t(`btn.${a}`, lang));
        item.type = 'button';
        menu.append(item);
        out.actions[a] = item;
      }
      wrap.append(b, menu);
      root.append(wrap);
      out.demoMenu = menu;
    } else {
      root.append(b);
    }
    out[name] = b;
  }
  return out;
}

export function renderHelp(root, { lang = 'en', onClose = null } = {}) {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const close = el(doc, 'button', 'x', '×');
  close.title = t('panel.close', lang);
  close.addEventListener('click', () => onClose && onClose());
  const list = el(doc, 'div', 'legend');
  for (const { key, color } of LEGEND) {
    const row = el(doc, 'span', 'item');
    const sw = el(doc, 'span', 'sw');
    sw.style.background = color;
    row.append(sw, doc.createTextNode(t(key, lang)));
    list.append(row);
  }
  root.append(close, el(doc, 'h4', null, t('help.title', lang)), list, el(doc, 'div', 'hintline', t('help.hint', lang)));
}
