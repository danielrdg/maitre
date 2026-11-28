import { t } from './i18n.js';
import { SCRATCH } from './building.js';
import { THEME_IDS, nextTheme } from './themes.js';

export { nextTheme };

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

// The floor view's "floor N theme: … ▸" button. A locked floor shows its theme and why it is fixed, and does nothing.
// `busy` is the project being saved; `error` ({ project, message }) shows under its own floor's button only.
export function themeButtonModel(floor, { busy = null, error = null } = {}, lang = 'en') {
  if (!floor) return null;
  const vars = { n: floor.floor, name: t(`theme.${THEME_IDS.includes(floor.theme) ? floor.theme : 'hall'}`, lang) };
  const locked = floor.locked === true;
  return {
    project: floor.project,
    text: t(locked ? 'theme.buttonLocked' : 'theme.button', lang, vars),
    note: locked ? t(floor.project === SCRATCH ? 'theme.scratch' : 'theme.config', lang) : null,
    next: locked ? null : nextTheme(floor.theme),
    disabled: locked || busy === floor.project,
    error: error?.project === floor.project ? t('theme.failed', lang, { message: error.message }) : null,
  };
}

// The building's controls: the view switcher, the lift, whose buttons list every open floor
// from the roof down to the lobby, and on a floor its theme button. `here` is the lift key of the level shown (or ridden to).
export function viewsModel(floors, current, here, theme = null, lang = 'en') {
  const sorted = [...floors].sort((a, b) => b.floor - a.floor);
  return {
    theme: current.view === 'floor' ? theme : null,
    views: ['facade', 'floor', 'lobby'].map(view => ({ view, on: current.view === view, disabled: view === 'floor' && !floors.length })),
    lift: [
      { key: 'roof', label: t('lift.roofKey', lang) },
      ...sorted.map(f => ({ key: f.floor, label: String(f.floor), project: f.project })),
      { key: 'lobby', label: t('lift.lobbyKey', lang) },
    ].map(b => ({ ...b, on: b.key === here })),
  };
}

export function renderViews(root, model, lang = 'en') {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const out = { views: {}, lift: [] };
  const row = el(doc, 'div', 'row');
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', t('view.switch', lang));
  for (const v of model.views) {
    const b = el(doc, 'button', v.on ? 'on' : null, t(`view.${v.view}`, lang));
    b.type = 'button';
    if (v.disabled) b.disabled = true;
    row.append(b);
    out.views[v.view] = b;
  }
  const lift = el(doc, 'div', 'lift');
  lift.append(el(doc, 'span', null, t('lift.label', lang)));
  for (const k of model.lift) {
    const b = el(doc, 'button', k.on ? 'on' : null, k.label);
    b.type = 'button';
    b.title = k.key === 'roof' ? t('lift.roof', lang) : k.key === 'lobby' ? t('lift.lobby', lang) : t('lift.floor', lang, { n: k.key, project: k.project });
    b.setAttribute('aria-label', b.title);
    lift.append(b);
    out.lift.push({ key: k.key, button: b });
  }
  root.append(row, lift);
  const th = model.theme;
  if (th) {
    const b = el(doc, 'button', 'themebtn' + (th.note ? ' locked' : ''), th.text);
    b.type = 'button';
    if (th.disabled) b.disabled = true;
    if (th.note) { b.append(el(doc, 'small', null, th.note)); b.setAttribute('aria-label', `${th.text} · ${th.note}`); }
    root.append(b);
    if (th.error) root.append(el(doc, 'div', 'themeerr', th.error));
    out.theme = b;
  }
  return out;
}

// The red chip: the room that has needed you longest, among those already at the bell if any are.
export function chipModel(agents) {
  const blocked = agents.filter(a => a.state === 'blocked');
  if (!blocked.length) return null;
  const since = a => (Number.isFinite(a.info?.since) ? a.info.since : Infinity);
  const atBell = blocked.filter(a => !a.walking);
  const agent = (atBell.length ? atBell : blocked).reduce((p, q) => (since(q) < since(p) ? q : p));
  return { agent, project: agent.info?.project || null, more: blocked.length - 1 };
}

// A room still starting has no project yet: the chip names the room alone.
export function chipText(m, lang = 'en') {
  const text = t(m.project ? 'chip.needsYou' : 'chip.needsYouAlone', lang, { name: m.agent.label, project: m.project });
  return m.more ? `${text} ${t('chip.more', lang, { n: m.more })}` : text;
}

// How far a name tag rises above its agent so neighbours' tags don't overlap. In the lobby the tags carry the
// project, so the terrace's two smokers and the two rooms at the bell take turns.
export function tagRise(a, withProject = false) {
  if (withProject && a.state === 'smoke') return a.spot % 2 ? 0 : 8;
  if (withProject && a.state === 'blocked') return a.spot % 2 ? 9 : 0;
  return (a.state === 'work' && (a.spot % 2 || a.spot === 4)) || (a.state === 'smoke' && a.spot === 1) || (a.state === 'coffee' && a.spot === 1)
    || (a.state === 'dance' && a.spot === 1) || (a.state === 'ready' && !a.walking) ? 9 : 0;
}
