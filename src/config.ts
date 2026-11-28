import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { maitreHome } from './paths.js';

// In the order new floors pick them.
export const THEME_IDS = ['casino', 'deco', 'tiki', 'karaoke', 'garden', 'hall'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export function isThemeId(x: unknown): x is ThemeId {
  return typeof x === 'string' && (THEME_IDS as readonly string[]).includes(x);
}

export interface ProjectOverride {
  base?: string;
  branchPrefix?: string;
  theme?: string;
}

export type UiLang = 'en' | 'pt-BR';

export interface MaitreConfig {
  roots: string[];
  projects: Record<string, ProjectOverride>;
  lang?: UiLang;
  capacity?: number;
  janitor?: { idleHours?: number; intervalMinutes?: number };
  vault?: string;
  seat?: { releaseMinutes?: number };
  pr?: { autoWake?: boolean; danceMinutes?: number; pollMinutes?: number };
}

export interface Settings {
  capacity: number;
  idleMs: number;
  intervalMs: number;
  vault: string;
  releaseMs: number;
  autoWake: boolean;
  danceMs: number;
  pollMs: number;
  warnings: string[];
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'config.json');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MaitreConfig {
  const raw = readJson(configPath(env)) as Partial<MaitreConfig> | undefined;
  const roots = Array.isArray(raw?.roots) ? raw.roots.filter((r): r is string => typeof r === 'string') : [];
  const projects = raw?.projects && typeof raw.projects === 'object' && !Array.isArray(raw.projects) ? raw.projects : {};
  const cfg: MaitreConfig = { roots, projects };
  if (raw?.lang === 'en' || raw?.lang === 'pt-BR') cfg.lang = raw.lang;
  // Kept as written, valid or not: settings() validates and warns, and a save must not drop what the user typed.
  if (raw?.capacity !== undefined) cfg.capacity = raw.capacity;
  if (raw?.janitor !== undefined) cfg.janitor = raw.janitor;
  if (raw?.vault !== undefined) cfg.vault = raw.vault;
  if (raw?.seat !== undefined) cfg.seat = raw.seat;
  if (raw?.pr !== undefined) cfg.pr = raw.pr;
  return cfg;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

export function settings(env: NodeJS.ProcessEnv = process.env): Settings {
  const cfg = loadConfig(env);
  const warnings: string[] = [];
  const pick = <T>(name: string, v: unknown, ok: (x: unknown) => x is T, fallback: T, want: string): T => {
    if (v === undefined) return fallback;
    if (ok(v)) return v;
    warnings.push(`config: ${name} must be ${want}; using ${String(fallback)}`);
    return fallback;
  };
  const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x > 0;
  const janitor = cfg.janitor !== null && typeof cfg.janitor === 'object' && !Array.isArray(cfg.janitor) ? cfg.janitor : {};
  if (cfg.janitor !== undefined && janitor !== cfg.janitor) warnings.push('config: janitor must be an object; using the defaults');
  const section = (name: 'seat' | 'pr', v: unknown): Record<string, unknown> => {
    if (v === undefined) return {};
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    warnings.push(`config: ${name} must be an object; using the defaults`);
    return {};
  };
  const seat = section('seat', cfg.seat);
  const pr = section('pr', cfg.pr);
  const capacity = pick('capacity', cfg.capacity, (x): x is number => Number.isInteger(x) && (x as number) >= 1, 6, 'an integer of at least 1');
  const idleHours = pick('janitor.idleHours', janitor.idleHours, positive, 4, 'a number above 0');
  const intervalMinutes = pick('janitor.intervalMinutes', janitor.intervalMinutes, positive, 5, 'a number above 0');
  const vault = pick('vault', cfg.vault, (x): x is string => typeof x === 'string' && isAbsolute(x), join(maitreHome(env), 'memory'), 'an absolute path');
  const releaseMinutes = pick('seat.releaseMinutes', seat.releaseMinutes, positive, 30, 'a number above 0');
  const autoWake = pick('pr.autoWake', pr.autoWake, (x): x is boolean => typeof x === 'boolean', false, 'true or false');
  const danceMinutes = pick('pr.danceMinutes', pr.danceMinutes, positive, 3, 'a number above 0');
  const pollMinutes = pick('pr.pollMinutes', pr.pollMinutes, positive, 2, 'a number above 0');
  return {
    capacity,
    idleMs: idleHours * HOUR_MS,
    intervalMs: intervalMinutes * MINUTE_MS,
    vault,
    releaseMs: releaseMinutes * MINUTE_MS,
    autoWake,
    danceMs: danceMinutes * MINUTE_MS,
    pollMs: pollMinutes * MINUTE_MS,
    warnings,
  };
}

export function saveConfig(cfg: MaitreConfig, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(configPath(env), cfg);
}

// projects.<name>.theme, kept only when it is one of the six; anything else is told and ignored.
export function themeOverrides(cfg: MaitreConfig): { themes: Map<string, ThemeId>; warnings: string[] } {
  const themes = new Map<string, ThemeId>();
  const warnings: string[] = [];
  for (const [name, o] of Object.entries(cfg.projects)) {
    const theme: unknown = typeof o === 'object' && o !== null && !Array.isArray(o) ? o.theme : undefined;
    if (theme === undefined) continue;
    if (isThemeId(theme)) themes.set(name, theme);
    else warnings.push(`config: projects.${name}.theme must be one of ${THEME_IDS.join(', ')}; ignoring it`);
  }
  return { themes, warnings };
}
