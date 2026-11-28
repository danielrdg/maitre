import { t } from './i18n.js';
import { post } from './reception.js';
import { nextTheme } from './themes.js';

const isSaved = (f, project, theme) => !!f && typeof f === 'object' && f.project === project && f.theme === theme
  && Number.isInteger(f.floor) && f.floor > 0;

// Resolves to { ok: true, floor } with the floor as saved, or { ok: false, message }.
export async function saveFloorTheme(project, theme, fetchImpl = fetch, lang = 'en') {
  let res;
  try {
    res = await post(`api/floors/${encodeURIComponent(project)}/theme`, { theme }, fetchImpl);
  } catch {
    return { ok: false, message: t('reception.offline', lang) };
  }
  const b = res.body;
  if (res.ok && b?.kind === 'ok' && isSaved(b.floor, project, theme)) {
    return { ok: true, floor: { project, floor: b.floor.floor, theme, locked: b.floor.locked === true } };
  }
  const message = !res.ok && typeof b?.message === 'string' ? b.message : t('reception.badReply', lang, { status: res.status });
  return { ok: false, message };
}

// The theme button's clicks: one save at a time, and the last failure, by project. The floor list is never
// changed here: the caller repaints from the `floors` event (or from the answer, through withSavedTheme).
// `seen(view)` follows the view: an error stays while its floor is on screen and is dropped when the user
// leaves it; a save that fails after they left records nothing.
export function themeSwitch({ save }) {
  let busy = null, error = null, here;
  return {
    get busy() { return busy; },
    get error() { return error; },
    seen(view) {
      here = view.view === 'floor' ? view.project : null;
      if (error && error.project !== here) error = null;
    },
    async cycle(floors, project) {
      const f = floors.find(x => x.project === project);
      if (!f || f.locked || busy) return null;
      const from = f.theme;
      busy = project; error = null;
      let r;
      try {
        r = await save(project, nextTheme(from));
      } catch (e) {
        r = { ok: false, message: String(e?.message ?? e) };
      } finally {
        busy = null;
      }
      if (!r?.ok) { if (here === undefined || here === project) error = { project, message: r?.message ?? '' }; return null; }
      return { from, floor: r.floor };
    },
  };
}

// The list with the saved theme in, or null when a newer list already moved the floor off the theme it was changed from.
export function withSavedTheme(floors, { from, floor }) {
  const i = floors.findIndex(f => f.project === floor.project);
  if (i < 0 || floors[i].theme !== from) return null;
  return floors.map((f, k) => (k === i ? { ...f, theme: floor.theme, locked: floor.locked } : f));
}
