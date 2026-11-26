import { t, normalizeLang } from './i18n.js';

// Talks to the lounge service's reception. Every piece of server text is shown with textContent.

export const CLOSE_AFTER_MS = 3000;
export const PROMPT_W = 560;
export const PROMPT_H = 180;
export const LOUNGE_W = 1280;
export const LOUNGE_H = 800;

const HEADERS = { 'content-type': 'application/json', 'x-maitre-request': '1' };

const isStr = v => typeof v === 'string';

function asReply(body) {
  if (body === null || typeof body !== 'object') return null;
  if (body.kind === 'question' && isStr(body.id) && isStr(body.text)) return { kind: 'question', id: body.id, text: body.text };
  if (body.kind === 'dispatched' && isStr(body.id) && isStr(body.room) && Array.isArray(body.lines) && body.lines.every(isStr)
    && typeof body.needsYou === 'boolean') {
    return { kind: 'dispatched', id: body.id, room: body.room, lines: [...body.lines], needsYou: body.needsYou };
  }
  if (body.kind === 'error' && isStr(body.message)) return { kind: 'error', message: body.message };
  return null;
}

async function post(url, body, fetchImpl) {
  const res = await fetchImpl(url, { method: 'POST', credentials: 'same-origin', headers: { ...HEADERS }, body: JSON.stringify(body) });
  let parsed = null;
  try { parsed = await res.json(); } catch { /* the server's own 403/404 answers are plain text */ }
  return { status: res.status, ok: res.ok, body: parsed };
}

// `answers` is the id of the question being answered; the key is left out when there is none.
export async function sendRequest(text, answers, fetchImpl = fetch, lang = 'en') {
  let res;
  try {
    res = await post('api/reception', answers == null ? { text } : { text, answers }, fetchImpl);
  } catch {
    return { kind: 'error', message: t('reception.offline', lang) };
  }
  return asReply(res.body) ?? { kind: 'error', message: t('reception.badReply', lang, { status: res.status }) };
}

export function replyView(reply, lang = 'en') {
  if (reply?.kind === 'dispatched') {
    const balloon = reply.lines.length ? reply.lines.join('\n') : reply.room;
    return reply.needsYou ? { balloon, keepOpen: true } : { balloon, keepOpen: false, closeAfterMs: CLOSE_AFTER_MS };
  }
  if (reply?.kind === 'question') return { balloon: reply.text, keepOpen: true, answers: reply.id };
  if (reply?.kind === 'error') return { balloon: reply.message, keepOpen: true };
  return { balloon: t('reception.offline', lang), keepOpen: true };
}

// One conversation with the maître. A question's id rides on the next request; an error keeps it,
// so a retry after "busy" still answers the question. A second submit while one is in flight is
// dropped: the server would store and dispatch it twice.
export function receptionSession({ lang = 'en', fetchImpl } = {}) {
  let answers, busy = false;
  return {
    get busy() { return busy; },
    reset() { answers = undefined; },
    async submit(text) {
      if (busy || !String(text).trim()) return null;
      busy = true;
      try {
        const reply = await sendRequest(text, answers, fetchImpl, lang);
        if (reply.kind === 'question') answers = reply.id;
        else if (reply.kind === 'dispatched') answers = undefined;
        return { kind: reply.kind, view: replyView(reply, lang) };
      } finally {
        busy = false;
      }
    },
  };
}

export async function openTerminal(room, fetchImpl = fetch, lang = 'en') {
  let res;
  try {
    res = await post(`api/rooms/${encodeURIComponent(room)}/terminal`, {}, fetchImpl);
  } catch {
    return { ok: false, message: t('reception.offline', lang) };
  }
  if (res.ok && res.body?.kind === 'ok') return { ok: true };
  const message = isStr(res.body?.message) ? res.body.message : t('reception.badReply', lang, { status: res.status });
  return { ok: false, message };
}

// Chrome ignores size and position flags when the profile already runs, so the page places itself.
export function promptPlacement(screen) {
  const left = screen.availLeft ?? 0, top = screen.availTop ?? 0;
  return { x: Math.round(left + (screen.availWidth - PROMPT_W) / 2), y: Math.round(top + (screen.availHeight - PROMPT_H) / 2) };
}

// A lounge window opened while the prompt keeps the profile warm inherits the prompt's 560x180.
// Only a window that small is resized, so a window the user sized is left alone.
export function loungePlacement(outer, screen) {
  const { outerWidth: ow, outerHeight: oh } = outer;
  if (!(ow > 0 && oh > 0) || (ow >= 640 && oh >= 400)) return null;
  if (!(screen.availWidth > 0 && screen.availHeight > 0)) return null;
  const w = Math.min(LOUNGE_W, screen.availWidth), h = Math.min(LOUNGE_H, screen.availHeight);
  const left = screen.availLeft ?? 0, top = screen.availTop ?? 0;
  return { w, h, x: Math.round(left + (screen.availWidth - w) / 2), y: Math.round(top + (screen.availHeight - h) / 2) };
}

export function bootPrompt(doc = document) {
  const win = doc.defaultView;
  const lang = normalizeLang(new URLSearchParams(win.location.search).get('lang') || 'en');
  const tr = (key, vars) => t(key, lang, vars);
  doc.documentElement.lang = lang;
  doc.title = tr('prompt.title');
  try {
    win.resizeTo(PROMPT_W, PROMPT_H);
    const { x, y } = promptPlacement(win.screen);
    win.moveTo(x, y);
  } catch { /* an unplaced window still works */ }

  const input = doc.getElementById('ask');
  const say = doc.getElementById('say');
  input.placeholder = tr('reception.placeholder');
  const session = receptionSession({ lang });
  const show = (text, cls = '') => { say.textContent = text; say.className = cls ? `say ${cls}` : 'say'; };

  // On the document: the input is disabled while a request is in flight.
  doc.addEventListener('keydown', e => { if (e.key === 'Escape') win.close(); });
  input.addEventListener('keydown', async e => {
    if (e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    if (session.busy || !input.value.trim()) return;
    input.disabled = true;
    show(tr('reception.thinking'), 'thinking');
    const done = await session.submit(input.value);
    if (!done) { input.disabled = false; return; }
    const { kind, view } = done;
    show(view.balloon, kind);
    if (view.closeAfterMs) {
      input.value = '';
      win.setTimeout(() => {
        win.close();
        win.setTimeout(() => { show(`${view.balloon}\n${tr('prompt.done')}`); input.disabled = false; input.focus(); }, 500);
      }, view.closeAfterMs);
      return;
    }
    if (kind !== 'error') input.value = '';
    input.disabled = false;
    input.focus();
  });
  input.focus();
}
