import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, writeJsonAtomic } from './config.js';
import { findBinary, unitFile } from './open-app.js';

export const MARKER = '# Managed by maitre setup';
export const KEYBINDING_PATH = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/maitre/';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAITRE_BIN = join(REPO, 'bin', 'maitre');
const MISSING = 'Node.js or the maître folder is missing; run ./setup again from the maître folder';
const ICON_SIZES = [192, 512];
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM = `${MEDIA_KEYS}.custom-keybinding`;
const TRAY_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY_KEY = 'toggle-message-tray';
const RELEASABLE = '<super>m';
const BINDING_SCHEMAS = ['org.gnome.desktop.wm.keybindings', TRAY_SCHEMA, 'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings', MEDIA_KEYS];
const ACCEL = /^(<[A-Za-z0-9_]+>)*[A-Za-z0-9_]+$/;
const TOOL_MS = 10_000;
const RUN_MS = 120_000;
const SETUP_USAGE = 'usage: maitre setup [--roots <a,b>] [--shortcut <accel>] [--no-shortcut] [--no-service] [--yes] [--dry-run] [--uninstall]';

export interface SetupOptions {
  roots?: string[];
  shortcut: string;
  noShortcut: boolean;
  noService: boolean;
  yes: boolean;
  dryRun: boolean;
  uninstall: boolean;
}

export type Action =
  | { kind: 'write'; path: string; mode: number; content: string }
  | { kind: 'copy'; from: string; to: string }
  | { kind: 'run'; argv: string[] }
  | { kind: 'gset'; schema: string; path?: string; key: string; value: string; previous?: string }
  | { kind: 'remove'; path: string }
  | { kind: 'note'; text: string };

export interface Probe {
  read(path: string): string | undefined;
  sha256(path: string): string | undefined;
  which(name: string): string | undefined;
  gsettings(args: string[]): string | undefined;
}

interface FileEntry {
  path: string;
  sha256?: string;
}

interface SettingEntry {
  schema: string;
  path?: string;
  key: string;
  previous?: string;
}

export interface Manifest {
  files: FileEntry[];
  settings: SettingEntry[];
}

interface Paths {
  mh: string;
  wrapper: string;
  local: string;
  unit: string;
  desktop: string;
  data: string;
  manifest: string;
}

function setupPaths(env: NodeJS.ProcessEnv): Paths {
  const home = env.HOME || homedir();
  const mh = env.MAITRE_HOME ? resolve(env.MAITRE_HOME) : join(home, '.maitre');
  const data = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const paths = {
    mh,
    wrapper: join(mh, 'bin', 'maitre'),
    local: join(home, '.local', 'bin', 'maitre'),
    unit: unitFile(env),
    desktop: join(data, 'applications', 'maitre.desktop'),
    data,
    manifest: join(mh, 'installed.json'),
  };
  for (const p of [...Object.values(paths), process.execPath, REPO]) {
    if (/[\n\r]/.test(p)) throw new Error(`cannot set up with a line break in a path: ${JSON.stringify(p)}`);
  }
  return paths;
}

const splitRoots = (s: string): string[] => s.split(',').map((r) => r.trim()).filter((r) => r !== '');

export function parseSetupArgs(argv: string[]): SetupOptions | { error: string } {
  const out: SetupOptions = { shortcut: '<Super>m', noShortcut: false, noService: false, yes: false, dryRun: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--roots') {
      const roots = splitRoots(argv[++i] ?? '');
      if (roots.length === 0) return { error: SETUP_USAGE };
      out.roots = roots;
    } else if (a === '--shortcut') {
      const accel = argv[++i];
      if (accel === undefined || !ACCEL.test(accel)) return { error: 'the shortcut must be a GNOME accelerator such as <Super>m' };
      out.shortcut = accel;
    } else if (a === '--no-shortcut') out.noShortcut = true;
    else if (a === '--no-service') out.noService = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--uninstall') out.uninstall = true;
    else return { error: SETUP_USAGE };
  }
  return out;
}

const hasMarker = (text: string): boolean => text.split('\n').includes(MARKER);
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const PLAIN = /^[A-Za-z0-9_/.,:@+=-]+$/;
const shellWord = (s: string): string => (PLAIN.test(s) ? s : shQuote(s));

// systemd expands % specifiers everywhere and $ in ExecStart; quotes are only needed around blanks.
function unitWord(s: string): string {
  return PLAIN.test(s) ? s : `"${s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/%/g, '%%').replace(/\$/g, () => '$$')}"`;
}

function unitEnv(name: string, value: string): string {
  const v = `${name}=${value.replace(/%/g, '%%')}`;
  return /[\s"'\\]/.test(v) ? `Environment="${v.replace(/[\\"]/g, (c) => `\\${c}`)}"` : `Environment=${v}`;
}

// Desktop Exec values are unescaped as strings first (\\ → \), then split with shell-like double quotes.
function desktopExec(words: string[]): string {
  const quoted = words.map((w) => (PLAIN.test(w) ? w : `"${w.replace(/[\\"`$]/g, (c) => `\\${c}`)}"`));
  return quoted.join(' ').replace(/\\/g, '\\\\').replace(/%/g, '%%');
}

function parseQuoted(t: string, start: number): [string, number] | undefined {
  const q = t[start];
  if (q !== "'" && q !== '"') return undefined;
  let s = '';
  let i = start + 1;
  while (i < t.length && t[i] !== q) {
    if (t[i] === '\\' && i + 1 < t.length) {
      const c = t[i + 1];
      s += c === 'n' ? '\n' : c === 't' ? '\t' : c;
      i += 2;
    } else {
      s += t[i++];
    }
  }
  return i < t.length ? [s, i + 1] : undefined;
}

// Reads the GVariant text gsettings prints for a string ('a') or a string array (['a', 'b'], @as []).
export function parseStrings(text: string): string[] | undefined {
  const t = text.trim().replace(/^@as\s+/, '');
  if (!t.startsWith('[')) {
    const one = parseQuoted(t, 0);
    return one !== undefined && one[1] === t.length ? [one[0]] : undefined;
  }
  const out: string[] = [];
  let i = 1;
  for (;;) {
    while (t[i] === ' ') i++;
    if (t[i] === ']' && out.length === 0) return i === t.length - 1 ? out : undefined;
    const item = parseQuoted(t, i);
    if (item === undefined) return undefined;
    out.push(item[0]);
    i = item[1];
    while (t[i] === ' ') i++;
    if (t[i] === ']') return i === t.length - 1 ? out : undefined;
    if (t[i] !== ',') return undefined;
    i++;
  }
}

const gvString = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const gvList = (a: string[]): string => (a.length === 0 ? '@as []' : `[${a.map(gvString).join(', ')}]`);
const sameAccel = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function parseManifest(text: string | undefined): Manifest {
  if (text === undefined) return { files: [], settings: [] };
  let raw: Partial<Manifest>;
  try {
    raw = JSON.parse(text) as Partial<Manifest>;
  } catch (err) {
    throw new Error(`cannot read installed.json: ${(err as Error).message}`);
  }
  return {
    files: Array.isArray(raw.files) ? raw.files.filter((f) => typeof f?.path === 'string') : [],
    settings: Array.isArray(raw.settings) ? raw.settings.filter((s) => typeof s?.schema === 'string' && typeof s?.key === 'string') : [],
  };
}

function onPath(dir: string, path: string | undefined): boolean {
  return (path ?? '').split(delimiter).some((d) => d !== '' && resolve(d) === dir);
}

interface Holders {
  others: string[];
  tray?: string;
}

function accelHolders(accel: string, customList: string[], probe: Probe): Holders {
  const out: Holders = { others: [] };
  for (const path of customList) {
    if (path === KEYBINDING_PATH) continue;
    const binding = parseStrings(probe.gsettings(['get', `${CUSTOM}:${path}`, 'binding']) ?? '')?.[0];
    if (binding === undefined || !sameAccel(binding, accel)) continue;
    const name = parseStrings(probe.gsettings(['get', `${CUSTOM}:${path}`, 'name']) ?? '')?.[0];
    out.others.push(`the custom shortcut "${name || path}"`);
  }
  for (const schema of BINDING_SCHEMAS) {
    for (const line of (probe.gsettings(['list-recursively', schema]) ?? '').split('\n')) {
      const m = /^(\S+) (\S+) (.*)$/.exec(line);
      if (m === null || !(parseStrings(m[3]) ?? []).some((v) => sameAccel(v, accel))) continue;
      if (m[1] === TRAY_SCHEMA && m[2] === TRAY_KEY && sameAccel(accel, RELEASABLE)) out.tray = m[3];
      else out.others.push(`${m[1]} ${m[2]}`);
    }
  }
  return out;
}

function planShortcut(opts: SetupOptions, env: NodeJS.ProcessEnv, probe: Probe, p: Paths): Action[] {
  const command = `${shellWord(p.wrapper)} prompt`;
  if (!(env.XDG_CURRENT_DESKTOP ?? '').includes('GNOME') || probe.which('gsettings') === undefined) {
    return [{ kind: 'note', text: `to open the prompt with a shortcut, bind this command in your desktop's keyboard settings: ${command}` }];
  }
  const listText = probe.gsettings(['get', MEDIA_KEYS, 'custom-keybindings']);
  const list = parseStrings(listText ?? '');
  if (listText === undefined || list === undefined) return [{ kind: 'note', text: 'skipping the shortcut: cannot read the GNOME custom shortcuts' }];
  const holders = accelHolders(opts.shortcut, list, probe);
  if (holders.others.length > 0) {
    return [{ kind: 'note', text: `skipping the shortcut: ${opts.shortcut} is held by ${holders.others.join(', ')}; pick another with --shortcut <accel>` }];
  }
  const actions: Action[] = [];
  if (holders.tray !== undefined) {
    const freed = (parseStrings(holders.tray) ?? []).filter((v) => !sameAccel(v, RELEASABLE));
    actions.push({ kind: 'gset', schema: TRAY_SCHEMA, key: TRAY_KEY, value: gvList(freed), previous: holders.tray });
    actions.push({ kind: 'note', text: `freed ${opts.shortcut} from GNOME's message tray (${TRAY_KEY}); --uninstall gives it back` });
  }
  if (!list.includes(KEYBINDING_PATH)) {
    actions.push({ kind: 'gset', schema: MEDIA_KEYS, key: 'custom-keybindings', value: gvList([...list, KEYBINDING_PATH]), previous: listText });
  }
  for (const [key, value] of [
    ['name', 'maître'],
    ['command', command],
    ['binding', opts.shortcut],
  ]) {
    actions.push({ kind: 'gset', schema: CUSTOM, path: KEYBINDING_PATH, key, value: gvString(value) });
  }
  return actions;
}

function unitContent(env: NodeJS.ProcessEnv, p: Paths): string {
  const lines = [
    MARKER,
    '[Unit]',
    'Description=maître lounge',
    // Started with the session's display, so a herdr server the lounge starts gives rooms DISPLAY too.
    'After=graphical-session.target',
    '',
    '[Service]',
    `ExecStart=${unitWord(p.wrapper)} serve`,
    'Restart=on-failure',
    'RestartSec=2',
    // Rooms and the herdr server the lounge starts must outlive a restart or stop of the service.
    'KillMode=process',
  ];
  if (env.PATH) lines.push(unitEnv('PATH', env.PATH));
  if (env.MAITRE_HOME) lines.push(unitEnv('MAITRE_HOME', p.mh));
  lines.push('', '[Install]', 'WantedBy=graphical-session.target', '');
  return lines.join('\n');
}

function desktopContent(p: Paths): string {
  return [
    MARKER,
    '[Desktop Entry]',
    'Type=Application',
    'Name=maître',
    'Comment=Watch your Claude Code rooms and send the maître a request',
    `Exec=${desktopExec([p.wrapper, 'open'])}`,
    'Icon=maitre',
    'Terminal=false',
    'Categories=Development;',
    'StartupWMClass=maitre',
    'Actions=terminal;',
    '',
    '[Desktop Action terminal]',
    'Name=Open in terminal',
    `Exec=${desktopExec(['x-terminal-emulator', '-e', p.wrapper])}`,
    '',
  ].join('\n');
}

export function planSetup(opts: SetupOptions, env: NodeJS.ProcessEnv, probe: Probe): Action[] {
  const p = setupPaths(env);
  const manifest = parseManifest(probe.read(p.manifest));
  const ours = (path: string): boolean => {
    const text = probe.read(path);
    return text === undefined || hasMarker(text);
  };
  const left = (path: string, why: string): Action => ({ kind: 'note', text: `left ${path}: it was not written by maitre setup; ${why}` });
  if (!ours(p.wrapper)) throw new Error(`${p.wrapper} was not written by maitre setup; move it away and run setup again`);

  const actions: Action[] = [];
  if (opts.roots !== undefined && opts.roots.length > 0) {
    actions.push({ kind: 'run', argv: [process.execPath, MAITRE_BIN, 'index', ...opts.roots.flatMap((r) => ['--root', r])] });
  }
  // A home chosen at setup reaches the app entry and the shortcut too, which run without the caller's env.
  const home = env.MAITRE_HOME ? [`export MAITRE_HOME="\${MAITRE_HOME:-${p.mh.replace(/[\\"$`]/g, (c) => `\\${c}`)}}"`] : [];
  const node = shQuote(process.execPath), bin = shQuote(MAITRE_BIN);
  // Under systemd, Restart=on-failure would repeat a desktop notification every RestartSec.
  const wrapper = [
    '#!/bin/sh',
    MARKER,
    ...home,
    `if [ ! -x ${node} ] || [ ! -f ${bin} ]; then`,
    `  echo ${shQuote(`maitre: ${MISSING}`)} >&2`,
    `  [ "$1" = serve ] || notify-send ${shQuote('maître')} ${shQuote(MISSING)} 2>/dev/null`,
    '  exit 1',
    'fi',
    `exec ${node} ${bin} "$@"`,
    '',
  ].join('\n');
  actions.push({ kind: 'write', path: p.wrapper, mode: 0o755, content: wrapper });
  if (!ours(p.local)) actions.push(left(p.local, `the app and the service use ${p.wrapper}`));
  else {
    actions.push({ kind: 'write', path: p.local, mode: 0o755, content: wrapper });
    if (!onPath(dirname(p.local), env.PATH)) actions.push({ kind: 'note', text: `${dirname(p.local)} is not on your PATH; add it to run maitre from a terminal` });
  }

  if (!opts.noService) {
    if (!ours(p.unit)) actions.push(left(p.unit, 'the service is not installed'));
    else {
      actions.push({ kind: 'write', path: p.unit, mode: 0o644, content: unitContent(env, p) });
      if (probe.which('systemctl') === undefined) actions.push({ kind: 'note', text: 'systemctl not found: the service is written but not started; maitre open starts the lounge when needed' });
      else {
        actions.push({ kind: 'run', argv: ['systemctl', '--user', 'daemon-reload'] }, { kind: 'run', argv: ['systemctl', '--user', 'enable', '--now', 'maitre'] });
        // enable --now leaves a running unit alone; KillMode=process keeps the rooms through the restart.
        if (probe.read(p.unit) !== undefined) actions.push({ kind: 'run', argv: ['systemctl', '--user', 'try-restart', 'maitre'] });
      }
    }
  }

  for (const size of ICON_SIZES) {
    const from = join(REPO, 'docs', 'assets', `icon-${size}.png`);
    const to = join(p.data, 'icons', 'hicolor', `${size}x${size}`, 'apps', 'maitre.png');
    const current = probe.sha256(to);
    const mine = current === undefined || current === probe.sha256(from) || manifest.files.some((f) => f.path === to && f.sha256 === current);
    actions.push(mine ? { kind: 'copy', from, to } : left(to, 'the app uses the icon found there'));
  }
  actions.push(ours(p.desktop) ? { kind: 'write', path: p.desktop, mode: 0o644, content: desktopContent(p) } : left(p.desktop, 'the app entry is not installed'));

  if (!opts.noShortcut) actions.push(...planShortcut(opts, env, probe, p));
  return actions;
}

export function planUninstall(manifest: Manifest, env: NodeJS.ProcessEnv, probe: Probe): Action[] {
  const p = setupPaths(env);
  const actions: Action[] = [];
  const systemctl = probe.which('systemctl') !== undefined;
  const files = [...manifest.files].sort((a, b) => Number(b.path === p.unit) - Number(a.path === p.unit));
  for (const f of files) {
    let state: 'gone' | 'ours' | 'changed';
    if (f.sha256 !== undefined) {
      const h = probe.sha256(f.path);
      state = h === undefined ? 'gone' : h === f.sha256 ? 'ours' : 'changed';
    } else {
      const text = probe.read(f.path);
      state = text === undefined ? 'gone' : hasMarker(text) ? 'ours' : 'changed';
    }
    if (state === 'gone') continue;
    if (state === 'changed') {
      actions.push({ kind: 'note', text: `left ${f.path}: it changed since setup` });
      continue;
    }
    const unit = f.path === p.unit;
    if (unit && systemctl) actions.push({ kind: 'run', argv: ['systemctl', '--user', 'disable', '--now', 'maitre'] });
    else if (unit) actions.push({ kind: 'note', text: 'systemctl not found: stop the lounge service by hand' });
    actions.push({ kind: 'remove', path: f.path });
    if (unit && systemctl) actions.push({ kind: 'run', argv: ['systemctl', '--user', 'daemon-reload'] });
  }

  const isKeybinding = (s: SettingEntry) => (s.schema === MEDIA_KEYS && s.key === 'custom-keybindings') || (s.schema === CUSTOM && s.path === KEYBINDING_PATH);
  const isTray = (s: SettingEntry) => s.schema === TRAY_SCHEMA && s.key === TRAY_KEY && s.previous !== undefined;
  const keybinding = manifest.settings.some(isKeybinding);
  const tray = manifest.settings.find(isTray);
  // Settings that could not be undone stay in installed.json, so a later --uninstall can finish the job.
  const pending: string[] = [];
  let keepKeybinding = false;
  let keepTray = false;
  const gsettings = probe.which('gsettings') !== undefined;
  if (keybinding) {
    const list = gsettings ? parseStrings(probe.gsettings(['get', MEDIA_KEYS, 'custom-keybindings']) ?? '') : undefined;
    if (list === undefined) {
      keepKeybinding = true;
      pending.push(`the maître shortcut (${gsettings ? 'cannot read custom-keybindings' : 'gsettings not found'})`);
    } else {
      if (list.includes(KEYBINDING_PATH)) {
        actions.push({ kind: 'gset', schema: MEDIA_KEYS, key: 'custom-keybindings', value: gvList(list.filter((x) => x !== KEYBINDING_PATH)) });
      }
      for (const key of ['name', 'command', 'binding']) actions.push({ kind: 'run', argv: ['gsettings', 'reset', `${CUSTOM}:${KEYBINDING_PATH}`, key] });
    }
  }
  if (tray?.previous !== undefined) {
    const current = gsettings ? parseStrings(probe.gsettings(['get', TRAY_SCHEMA, TRAY_KEY]) ?? '') : undefined;
    if (current === undefined) {
      keepTray = true;
      pending.push(`${TRAY_KEY} (${gsettings ? 'cannot read it' : 'gsettings not found'}; it was ${tray.previous})`);
    } else if (!current.some((v) => sameAccel(v, RELEASABLE))) actions.push({ kind: 'gset', schema: TRAY_SCHEMA, key: TRAY_KEY, value: tray.previous });
    else actions.push({ kind: 'note', text: `left ${TRAY_KEY} as it is: <Super>m is already back in it` });
  }
  actions.push({ kind: 'note', text: `kept ${p.mh} (config, project index, rooms and requests); delete it by hand if you want it gone` });
  if (pending.length === 0) actions.push({ kind: 'remove', path: p.manifest });
  else {
    const left: Manifest = {
      files: [],
      settings: manifest.settings.filter((s) => (keepKeybinding && isKeybinding(s)) || (keepTray && isTray(s))),
    };
    actions.push({ kind: 'write', path: p.manifest, mode: 0o600, content: JSON.stringify(left, null, 2) + '\n' });
    actions.push({ kind: 'note', text: `kept ${p.manifest}: could not undo ${pending.join('; ')}; run maitre setup --uninstall again once that works` });
  }
  return actions;
}

export function describe(a: Action): string {
  if (a.kind === 'write') return `write ${a.path} (0${a.mode.toString(8)})`;
  if (a.kind === 'copy') return `copy ${a.from} -> ${a.to}`;
  if (a.kind === 'run') return `run ${a.argv.join(' ')}`;
  if (a.kind === 'gset') return `gset ${a.schema}${a.path !== undefined ? `:${a.path}` : ''} ${a.key} ${a.value}`;
  if (a.kind === 'remove') return `remove ${a.path}`;
  return a.text;
}

const errCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

export function systemProbe(env: NodeJS.ProcessEnv): Probe {
  const bytes = (path: string): Buffer | undefined => {
    try {
      return readFileSync(path);
    } catch (err) {
      if (errCode(err) === 'ENOENT' || errCode(err) === 'ENOTDIR') return undefined;
      throw err;
    }
  };
  return {
    read: (path) => bytes(path)?.toString('utf8'),
    sha256: (path) => {
      const b = bytes(path);
      return b === undefined ? undefined : createHash('sha256').update(b).digest('hex');
    },
    which: (name) => findBinary(name, env),
    gsettings: (args) => {
      const bin = findBinary('gsettings', env);
      if (bin === undefined) return undefined;
      const r = spawnSync(bin, args, { env, encoding: 'utf8', timeout: TOOL_MS, stdio: ['ignore', 'pipe', 'ignore'] });
      return r.status === 0 ? r.stdout.trim() : undefined;
    },
  };
}

// Commands are resolved on env.PATH and spawned by absolute path: a bare name could reach the real desktop tools.
function runArgv(argv: string[], env: NodeJS.ProcessEnv): void {
  const [cmd, ...rest] = argv;
  const bin = isAbsolute(cmd) ? cmd : findBinary(cmd, env);
  if (bin === undefined) throw new Error(`${cmd} not found on PATH`);
  const r = spawnSync(bin, rest, { env, stdio: ['ignore', 'inherit', 'inherit'], timeout: RUN_MS });
  if (r.status !== 0) throw new Error(`${argv.join(' ')} failed${r.error ? `: ${r.error.message}` : ''}`);
}

function writeFile(path: string, content: string | Buffer, mode: number, mh: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: path.startsWith(mh + sep) ? 0o700 : 0o755 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function apply(actions: Action[], env: NodeJS.ProcessEnv, record: boolean, log: (line: string) => void): void {
  const p = setupPaths(env);
  const manifest = parseManifest(systemProbe(env).read(p.manifest));
  const keep = (file?: FileEntry, setting?: SettingEntry): void => {
    if (!record) return;
    if (file !== undefined) manifest.files = [...manifest.files.filter((f) => f.path !== file.path), file];
    if (setting !== undefined) {
      const same = (s: SettingEntry) => s.schema === setting.schema && s.path === setting.path && s.key === setting.key;
      const old = manifest.settings.find(same);
      // The first recorded value is the user's own; a re-run must not replace it with maître's.
      if (old === undefined) manifest.settings.push(setting);
      else if (old.previous === undefined && setting.previous !== undefined) old.previous = setting.previous;
    }
    writeJsonAtomic(p.manifest, manifest);
  };
  for (const a of actions) {
    log(describe(a));
    if (a.kind === 'write') {
      keep({ path: a.path });
      writeFile(a.path, a.content, a.mode, p.mh);
    } else if (a.kind === 'copy') {
      const content = readFileSync(a.from);
      keep({ path: a.to, sha256: createHash('sha256').update(content).digest('hex') });
      writeFile(a.to, content, 0o644, p.mh);
    } else if (a.kind === 'gset') {
      const setting: SettingEntry = { schema: a.schema, key: a.key };
      if (a.path !== undefined) setting.path = a.path;
      if (a.previous !== undefined) setting.previous = a.previous;
      keep(undefined, setting);
      runArgv(['gsettings', 'set', a.path !== undefined ? `${a.schema}:${a.path}` : a.schema, a.key, a.value], env);
    } else if (a.kind === 'run') {
      runArgv(a.argv, env);
    } else if (a.kind === 'remove') {
      rmSync(a.path, { force: true });
    }
  }
}

export function applySetup(actions: Action[], env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): void {
  apply(actions, env, true, log);
}

export function applyUninstall(actions: Action[], env: NodeJS.ProcessEnv, log: (line: string) => void = console.log): void {
  apply(actions, env, false, log);
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

async function chooseRoots(opts: SetupOptions, env: NodeJS.ProcessEnv): Promise<string[]> {
  const home = env.HOME || homedir();
  const configured = loadConfig(env).roots;
  const fallback = configured.length > 0 ? configured : [dirname(REPO)];
  let roots = opts.roots;
  if (roots === undefined && !opts.yes && process.stdin.isTTY && process.stdout.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = splitRoots(await rl.question(`Where do your repos live? Comma-separated [${fallback.join(', ')}]: `));
      if (answer.length > 0) roots = answer;
    } finally {
      rl.close();
    }
  }
  const chosen = (roots ?? fallback).map((r) => resolve(r === '~' ? home : r.startsWith('~/') ? join(home, r.slice(2)) : r));
  const missing = chosen.find((r) => !isDir(r));
  if (missing !== undefined) throw new Error(`root not found: ${missing}`);
  return chosen;
}

export async function runSetup(opts: SetupOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const probe = systemProbe(env);
    let actions: Action[];
    if (opts.uninstall) {
      const manifest = setupPaths(env).manifest;
      const text = probe.read(manifest);
      if (text === undefined) {
        console.log(`maitre: nothing to uninstall (${manifest} not found)`);
        return 0;
      }
      actions = planUninstall(parseManifest(text), env, probe);
    } else {
      actions = planSetup({ ...opts, roots: await chooseRoots(opts, env) }, env, probe);
    }
    if (opts.dryRun) {
      console.log('maitre setup --dry-run: nothing is changed; this is what setup would do');
      for (const a of actions) console.log(describe(a));
    } else if (opts.uninstall) {
      applyUninstall(actions, env);
    } else {
      applySetup(actions, env);
      const shortcut = actions.some((a) => a.kind === 'gset' && a.key === 'binding');
      console.log(`maitre: set up; open maître from the app grid${shortcut ? ` or press ${opts.shortcut}` : ''}`);
    }
    return 0;
  } catch (err) {
    console.error(`maitre: ${(err as Error).message}`);
    return 1;
  }
}
