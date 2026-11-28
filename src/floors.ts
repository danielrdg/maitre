import { readFileSync, renameSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { THEME_IDS, configPath, isThemeId, loadConfig, themeOverrides, writeJsonAtomic, type ThemeId } from './config.js';
import { maitreHome } from './paths.js';

export { THEME_IDS, isThemeId, type ThemeId };

export const SCRATCH = 'scratch';
const SCRATCH_THEME: ThemeId = 'hall';

export interface Floor {
  project: string;
  floor: number;
  theme: string;
  locked: boolean;
}

interface Entry {
  floor: number;
  theme: ThemeId;
}

export type Warn = (w: string) => void;

const said = new Set<string>();
export const warnOnce: Warn = (w) => {
  if (said.has(w)) return;
  said.add(w);
  console.error(`maitre: warning: ${w}`);
};

export type FloorErrorCode = 'unknown-project' | 'unknown-theme' | 'locked';

export class FloorError extends Error {
  constructor(
    readonly code: FloorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FloorError';
  }
}

export function floorsFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'state', 'floors.json');
}

function stampOf(path: string): string {
  try {
    const st = statSync(path);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch {
    return '';
  }
}

// Both files are read on every poll of the live loop: each is parsed again only when it changes.
// `keep`: where a corrupt floors.json goes before the next write replaces it.
const stores = new Map<string, { stamp: string; floors: Map<string, Entry>; keep?: string }>();
const configs = new Map<string, { stamp: string; themes: Map<string, ThemeId> }>();

function parseFloors(path: string, exists: boolean, warn: Warn): { floors: Map<string, Entry>; keep?: string } {
  const out = new Map<string, Entry>();
  if (!exists) {
    warn('state/floors.json not found; floors are numbered afresh');
    return { floors: out };
  }
  const corrupt = (why: string) => {
    const keep = `${path}.bad-${Date.now()}`;
    warn(`state/floors.json ${why}; floors are numbered afresh, and the next write keeps it as ${basename(keep)}`);
    return { floors: out, keep };
  };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return corrupt(`cannot be read (${(err as Error).message})`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return corrupt('is not an object');
  for (const [project, v] of Object.entries(raw)) {
    const e = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    if (Number.isSafeInteger(e.floor) && (e.floor as number) >= 1 && isThemeId(e.theme)) out.set(project, { floor: e.floor as number, theme: e.theme });
    else warn(`state/floors.json: ignoring the odd entry for ${JSON.stringify(project)}`);
  }
  return { floors: out };
}

function load(env: NodeJS.ProcessEnv, warn: Warn): Map<string, Entry> {
  const path = floorsFile(env);
  const stamp = stampOf(path);
  const hit = stores.get(path);
  if (hit?.stamp === stamp) return hit.floors;
  const parsed = parseFloors(path, stamp !== '', warn);
  stores.set(path, { stamp, ...parsed });
  return parsed.floors;
}

function save(env: NodeJS.ProcessEnv, floors: Map<string, Entry>): void {
  const path = floorsFile(env);
  const hit = stores.get(path);
  if (hit?.keep !== undefined && hit.stamp === stampOf(path)) renameSync(path, hit.keep);
  writeJsonAtomic(path, Object.fromEntries(floors));
  // Cached as written: two themes of one length can leave mtime and size as they were.
  stores.set(path, { stamp: stampOf(path), floors });
}

function locks(env: NodeJS.ProcessEnv, warn: Warn): Map<string, ThemeId> {
  const path = configPath(env);
  const stamp = stampOf(path);
  const hit = configs.get(path);
  if (hit?.stamp === stamp) return hit.themes;
  let themes = new Map<string, ThemeId>();
  try {
    const found = themeOverrides(loadConfig(env));
    themes = found.themes;
    themes.delete(SCRATCH);
    for (const w of found.warnings) warn(w);
  } catch (err) {
    warn(`${(err as Error).message}; no floor theme comes from config`);
  }
  configs.set(path, { stamp, themes });
  return themes;
}

const nextFloor = (floors: Map<string, Entry>): number => Math.max(0, ...[...floors.values()].map((e) => e.floor)) + 1;

export function readFloors(env: NodeJS.ProcessEnv = process.env, warn: Warn = warnOnce): Record<string, { floor: number; theme: string }> {
  return Object.fromEntries([...load(env, warn)].map(([p, e]) => [p, { ...e }]));
}

// FNV-1a: the same name lands on the same theme in every process and on every machine.
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (const b of Buffer.from(s, 'utf8')) h = Math.imul(h ^ b, 0x01000193) >>> 0;
  return h;
}

export function pickTheme(taken: Set<string>, project: string): string {
  return THEME_IDS.find((t) => !taken.has(t)) ?? THEME_IDS[hash(project) % THEME_IDS.length]!;
}

export function openFloors(openProjects: string[], env: NodeJS.ProcessEnv = process.env, warn: Warn = warnOnce): Floor[] {
  const open = [...new Set(openProjects)];
  if (open.length === 0) return [];
  const stored = load(env, warn);
  const config = locks(env, warn);
  const shown = (p: string, e: Entry): string => config.get(p) ?? e.theme;
  const taken = new Set(open.filter((p) => stored.has(p)).map((p) => shown(p, stored.get(p)!)));
  let next: Map<string, Entry> | undefined;
  for (const p of open) {
    if (stored.has(p) || next?.has(p)) continue;
    next ??= new Map(stored);
    const e: Entry = { floor: nextFloor(next), theme: p === SCRATCH ? SCRATCH_THEME : (pickTheme(taken, p) as ThemeId) };
    next.set(p, e);
    taken.add(shown(p, e));
  }
  const floors = next ?? stored;
  if (next !== undefined) {
    try {
      save(env, next);
    } catch (err) {
      // Shown all the same: the same numbers are picked again on the next try.
      warn(`cannot write state/floors.json: ${(err as Error).message}`);
    }
  }
  return open
    .map((p) => ({ project: p, floor: floors.get(p)!.floor, theme: shown(p, floors.get(p)!), locked: config.has(p) || p === SCRATCH }))
    .sort((a, b) => a.floor - b.floor || (a.project < b.project ? -1 : a.project > b.project ? 1 : 0));
}

export function setTheme(project: string, theme: string, env: NodeJS.ProcessEnv = process.env, warn: Warn = warnOnce): Floor {
  const stored = load(env, warn);
  const was = stored.get(project);
  if (was === undefined && project !== SCRATCH) throw new FloorError('unknown-project', `no floor for project ${JSON.stringify(project)}`);
  if (!isThemeId(theme)) throw new FloorError('unknown-theme', `unknown theme ${JSON.stringify(theme)}; one of ${THEME_IDS.join(', ')}`);
  if (project === SCRATCH) throw new FloorError('locked', `the scratch floor is always ${SCRATCH_THEME}`);
  if (locks(env, warn).has(project)) throw new FloorError('locked', `the theme of ${project} is set in config.json`);
  const e: Entry = { floor: was!.floor, theme };
  if (was!.theme !== theme) save(env, new Map(stored).set(project, e));
  return { project, floor: e.floor, theme, locked: false };
}
