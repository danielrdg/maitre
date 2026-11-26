import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KEYBINDING_PATH, MARKER, parseSetupArgs, parseStrings, planSetup, type Probe } from '../src/setup.js';
import { fakeBin } from './fake-bin.js';

const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const MAITRE = join(REPO, 'bin', 'maitre');
const FAKE_GSETTINGS = join(REPO, 'test', 'fixtures', 'fake-gsettings.mjs');
const FAKE_SYSTEMCTL = join(REPO, 'test', 'fixtures', 'fake-systemctl.mjs');
const MK = 'org.gnome.settings-daemon.plugins.media-keys';
const OURS = `${MK}.custom-keybinding:${KEYBINDING_PATH}`;
const TRAY = 'org.gnome.shell.keybindings';

const MISSING = 'Node.js or the maître folder is missing; run ./setup again from the maître folder';
const wrapperOf = (home: string) =>
  [
    '#!/bin/sh',
    MARKER,
    ...(home ? [`export MAITRE_HOME="\${MAITRE_HOME:-${home}}"`] : []),
    `if [ ! -x '${process.execPath}' ] || [ ! -f '${MAITRE}' ]; then`,
    `  echo 'maitre: ${MISSING}' >&2`,
    `  [ "$1" = serve ] || notify-send 'maître' '${MISSING}' 2>/dev/null`,
    '  exit 1',
    'fi',
    `exec '${process.execPath}' '${MAITRE}' "$@"`,
    '',
  ].join('\n');

const cleanups: (() => void)[] = [];
after(() => {
  for (const c of cleanups) c();
});

type Db = Record<string, Record<string, string>>;

interface Box {
  root: string;
  home: string;
  mh: string;
  config: string;
  data: string;
  code: string;
  fakes: string;
  db: string;
  env: NodeJS.ProcessEnv;
  run(...args: string[]): { status: number | null; out: string };
  readDb(): Db;
  calls(name: 'gsettings' | 'systemctl'): string[][];
}

const SEED: Db = {
  [TRAY]: { 'toggle-message-tray': "['<Super>v', '<Super>m']", 'toggle-overview': "['<Super>s']" },
  [MK]: { 'custom-keybindings': '@as []', home: "['<Super>e']" },
  'org.gnome.desktop.wm.keybindings': { minimize: "['<Super>h']" },
};

// Only the fakes are on PATH: the real gsettings and systemctl talk to the session's dconf and user manager,
// which no temp HOME isolates.
function sandbox(opts: { db?: Db; xdg?: boolean } = {}): Box {
  const root = mkdtempSync(join(tmpdir(), 'maitre-setup-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  const mh = join(home, '.maitre');
  const config = opts.xdg === false ? join(home, '.config') : join(root, 'xdg-config');
  const data = opts.xdg === false ? join(home, '.local', 'share') : join(root, 'xdg-data');
  const code = join(root, 'code');
  const fakes = join(root, 'fakes');
  const logs = join(root, 'logs');
  const db = join(root, 'dconf.json');
  for (const d of [home, join(code, 'alpha', '.git'), fakes, logs]) mkdirSync(d, { recursive: true });
  writeFileSync(db, JSON.stringify(opts.db ?? SEED, null, 2) + '\n');
  const fake = (name: string, script: string, args: string[]) => {
    writeFileSync(join(fakes, name), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${args.map((a) => `'${a}'`).join(' ')} "$@"\n`);
    chmodSync(join(fakes, name), 0o755);
  };
  fake('gsettings', FAKE_GSETTINGS, [db, join(logs, 'gsettings.log')]);
  fake('systemctl', FAKE_SYSTEMCTL, [join(logs, 'systemctl.log')]);
  const env: NodeJS.ProcessEnv = { HOME: home, MAITRE_HOME: mh, PATH: fakes, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', LANG: 'C.UTF-8' };
  if (opts.xdg !== false) {
    env.XDG_CONFIG_HOME = config;
    env.XDG_DATA_HOME = data;
  }
  const calls = (name: string): string[][] => {
    const log = join(logs, `${name}.log`);
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[]) : [];
  };
  return {
    root,
    home,
    mh,
    config,
    data,
    code,
    fakes,
    db,
    env,
    run: (...args) => {
      const r = spawnSync(process.execPath, [MAITRE, 'setup', ...args], { env, encoding: 'utf8', input: '' });
      return { status: r.status, out: r.stdout + r.stderr };
    },
    readDb: () => JSON.parse(readFileSync(db, 'utf8')) as Db,
    calls,
  };
}

const paths = (b: Box) => ({
  wrapper: join(b.mh, 'bin', 'maitre'),
  local: join(b.home, '.local', 'bin', 'maitre'),
  unit: join(b.config, 'systemd', 'user', 'maitre.service'),
  desktop: join(b.data, 'applications', 'maitre.desktop'),
  icon192: join(b.data, 'icons', 'hicolor', '192x192', 'apps', 'maitre.png'),
  icon512: join(b.data, 'icons', 'hicolor', '512x512', 'apps', 'maitre.png'),
});

function snapshot(dir: string, out: Record<string, string> = {}): Record<string, string> {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      out[p] = `dir ${(st.mode & 0o777).toString(8)}`;
      snapshot(p, out);
    } else {
      out[p] = `${(st.mode & 0o777).toString(8)} ${readFileSync(p).toString('base64')}`;
    }
  }
  return out;
}

const state = (b: Box) => ({ ...snapshot(b.home), ...snapshot(b.config), ...snapshot(b.data), db: readFileSync(b.db, 'utf8') });
const mode = (p: string) => statSync(p).mode & 0o777;
const read = (p: string) => readFileSync(p, 'utf8');

test('parseSetupArgs reads every flag and rejects bad input', () => {
  assert.deepEqual(parseSetupArgs([]), { shortcut: '<Super>m', noShortcut: false, noService: false, yes: false, dryRun: false, uninstall: false });
  assert.deepEqual(parseSetupArgs(['--roots', '/a, /b ,', '--shortcut', '<Super><Alt>k', '--no-service', '--yes', '--dry-run']), {
    roots: ['/a', '/b'],
    shortcut: '<Super><Alt>k',
    noShortcut: false,
    noService: true,
    yes: true,
    dryRun: true,
    uninstall: false,
  });
  assert.equal(parseSetupArgs(['--uninstall', '--no-shortcut']).hasOwnProperty('error'), false);
  for (const bad of [['--roots'], ['--roots', ''], ['--shortcut'], ['--shortcut', 'Super+M'], ['--shortcut', "<Super>m' ; x"], ['--bogus'], ['extra']]) {
    assert.ok('error' in parseSetupArgs(bad), bad.join(' '));
  }
});

test('parseStrings reads the GVariant text gsettings prints', () => {
  assert.deepEqual(parseStrings('@as []'), []);
  assert.deepEqual(parseStrings('[]'), []);
  assert.deepEqual(parseStrings("['<Super>v', '<Super>m']"), ['<Super>v', '<Super>m']);
  assert.deepEqual(parseStrings(`['a\\\\b', "it's"]`), ['a\\b', "it's"]);
  assert.deepEqual(parseStrings("'maître'"), ['maître']);
  assert.equal(parseStrings('uint32 0'), undefined);
  assert.equal(parseStrings("['a'"), undefined);
});

test('fresh install writes every file with the marker, the unit runs an absolute node with the setup-time PATH', () => {
  const b = sandbox();
  const p = paths(b);
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /indexed 1 project/);
  assert.deepEqual(JSON.parse(read(join(b.mh, 'config.json'))).roots, [b.code]);

  const wrapper = wrapperOf(b.mh);
  assert.equal(read(p.wrapper), wrapper);
  assert.equal(mode(p.wrapper), 0o755);
  assert.equal(read(p.local), wrapper);
  assert.equal(mode(p.local), 0o755);
  assert.match(r.out, /\.local\/bin is not on your PATH/);
  const version = spawnSync(p.wrapper, ['--version'], { env: b.env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);

  const unit = read(p.unit);
  assert.equal(mode(p.unit), 0o644);
  for (const line of [
    MARKER,
    `ExecStart=${p.wrapper} serve`,
    'Restart=on-failure',
    'RestartSec=2',
    'KillMode=process',
    `Environment=PATH=${b.fakes}`,
    `Environment=MAITRE_HOME=${b.mh}`,
    'After=graphical-session.target',
    'WantedBy=graphical-session.target',
  ]) {
    assert.ok(unit.split('\n').includes(line), `unit lacks ${line}:\n${unit}`);
  }
  assert.ok(unit.indexOf('After=graphical-session.target') < unit.indexOf('[Service]'), unit);
  assert.ok(!unit.includes('default.target'), unit);
  assert.deepEqual(b.calls('systemctl'), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'maitre'],
  ]);

  const desktop = read(p.desktop);
  assert.equal(mode(p.desktop), 0o644);
  for (const line of [MARKER, 'Name=maître', `Exec=${p.wrapper} open`, 'Icon=maitre', 'StartupWMClass=maitre', 'Actions=terminal;', '[Desktop Action terminal]', `Exec=x-terminal-emulator -e ${p.wrapper}`]) {
    assert.ok(desktop.split('\n').includes(line), `desktop lacks ${line}:\n${desktop}`);
  }
  assert.deepEqual(readFileSync(p.icon192), readFileSync(join(REPO, 'docs', 'assets', 'icon-192.png')));
  assert.deepEqual(readFileSync(p.icon512), readFileSync(join(REPO, 'docs', 'assets', 'icon-512.png')));
  assert.equal(mode(p.icon192), 0o644);

  const db = b.readDb();
  assert.equal(db[MK]['custom-keybindings'], `['${KEYBINDING_PATH}']`);
  assert.deepEqual(db[OURS], { name: "'maître'", command: `'${p.wrapper} prompt'`, binding: "'<Super>m'" });
  assert.equal(db[TRAY]['toggle-message-tray'], "['<Super>v']");
  assert.equal(db[TRAY]['toggle-overview'], "['<Super>s']");
  assert.match(r.out, /toggle-message-tray/);
  assert.ok(b.calls('gsettings').length > 0);
});

test('the wrapper says to re-run setup when Node or the clone is gone, and stays quiet on the desktop for the service', () => {
  const b = sandbox();
  assert.equal(b.run('--yes', '--roots', b.code, '--no-service', '--no-shortcut').status, 0);
  const fb = fakeBin();
  cleanups.push(fb.cleanup);
  fb.add('notify-send');
  const text = read(paths(b).wrapper);
  const broken = (name: string, from: string, to: string) => {
    const path = join(b.root, name);
    writeFileSync(path, text.replaceAll(from, to), { mode: 0o755 });
    return path;
  };
  const noNode = broken('no-node', process.execPath, join(b.root, 'gone', 'node'));
  const noClone = broken('no-clone', MAITRE, join(b.root, 'gone', 'bin', 'maitre'));
  const env = { ...b.env, PATH: fb.bin };

  const a = spawnSync(noNode, ['prompt'], { env, encoding: 'utf8' });
  assert.equal(a.status, 1);
  assert.equal(a.stderr, `maitre: ${MISSING}\n`);
  assert.deepEqual(fb.calls('notify-send'), [['maître', MISSING]]);

  const s = spawnSync(noClone, ['serve'], { env, encoding: 'utf8' });
  assert.equal(s.status, 1);
  assert.equal(s.stderr, `maitre: ${MISSING}\n`);
  assert.equal(fb.calls('notify-send').length, 1);

  const quiet = spawnSync(noClone, ['open'], { env: { ...b.env, PATH: join(b.root, 'empty') }, encoding: 'utf8' });
  assert.equal(quiet.status, 1);
  assert.equal(quiet.stderr, `maitre: ${MISSING}\n`);
});

test('running setup twice changes nothing more, and install → install → uninstall restores the message tray', () => {
  const b = sandbox();
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  const first = state(b);
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(state(b), first);
  assert.deepEqual(b.calls('systemctl'), [
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'maitre'],
    ['--user', 'daemon-reload'],
    ['--user', 'enable', '--now', 'maitre'],
    ['--user', 'try-restart', 'maitre'],
  ]);
  const dry = b.run('--yes', '--roots', b.code, '--dry-run');
  assert.ok(dry.out.split('\n').includes('run systemctl --user try-restart maitre'), dry.out);
  assert.equal(b.readDb()[MK]['custom-keybindings'], `['${KEYBINDING_PATH}']`);
  const u = b.run('--uninstall');
  assert.equal(u.status, 0, u.out);
  assert.equal(b.readDb()[TRAY]['toggle-message-tray'], "['<Super>v', '<Super>m']");
});

test('a foreign ~/.local/bin/maitre is left alone; the unit, the app and the shortcut use maître\'s own wrapper', () => {
  const b = sandbox();
  const p = paths(b);
  mkdirSync(dirname(p.local), { recursive: true });
  writeFileSync(p.local, '#!/bin/sh\necho mine\n', { mode: 0o700 });
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(p.local), '#!/bin/sh\necho mine\n');
  assert.equal(mode(p.local), 0o700);
  assert.match(r.out, new RegExp(`left ${p.local.replace(/[.]/g, '\\.')}`));
  assert.ok(read(p.unit).includes(`ExecStart=${p.wrapper} serve`));
  assert.ok(read(p.desktop).includes(`Exec=${p.wrapper} open`));
  assert.equal(b.readDb()[OURS].command, `'${p.wrapper} prompt'`);

  const u = b.run('--uninstall');
  assert.equal(u.status, 0, u.out);
  assert.equal(read(p.local), '#!/bin/sh\necho mine\n');
});

test('another custom keybinding on <Super>m skips the shortcut and changes no setting', () => {
  const other = '/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/custom0/';
  const db: Db = {
    ...SEED,
    [MK]: { 'custom-keybindings': `['${other}']` },
    [`${MK}.custom-keybinding:${other}`]: { name: "'Music'", command: "'player'", binding: "'<Super>M'" },
  };
  const b = sandbox({ db });
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /skipping the shortcut: <Super>m is held by the custom shortcut "Music"/);
  assert.deepEqual(b.readDb(), db);
  assert.ok(b.calls('gsettings').every((c) => c[0] !== 'set' && c[0] !== 'reset'));
});

test('another GNOME binding on the chosen accelerator skips the shortcut', () => {
  const b = sandbox();
  const r = b.run('--yes', '--roots', b.code, '--shortcut', '<Super>h');
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /<Super>h is held by org\.gnome\.desktop\.wm\.keybindings minimize/);
  assert.deepEqual(b.readDb(), SEED);
});

test('--dry-run prints one line per action and leaves every temp dir byte-identical', () => {
  const b = sandbox({ xdg: false });
  const before = state(b);
  const r = b.run('--yes', '--roots', b.code, '--dry-run');
  assert.equal(r.status, 0, r.out);
  assert.deepEqual(state(b), before);
  assert.deepEqual(b.calls('systemctl'), []);
  assert.ok(b.calls('gsettings').every((c) => c[0] === 'get' || c[0] === 'list-recursively'));
  const p = paths(b);
  for (const line of [
    `run ${process.execPath} ${MAITRE} index --root ${b.code}`,
    `write ${p.wrapper} (0755)`,
    `write ${p.local} (0755)`,
    `write ${join(b.home, '.config', 'systemd', 'user', 'maitre.service')} (0644)`,
    'run systemctl --user daemon-reload',
    'run systemctl --user enable --now maitre',
    `copy ${join(REPO, 'docs', 'assets', 'icon-192.png')} -> ${p.icon192}`,
    `write ${p.desktop} (0644)`,
    `gset ${MK} custom-keybindings ['${KEYBINDING_PATH}']`,
    `gset ${TRAY} toggle-message-tray ['<Super>v']`,
  ]) {
    assert.ok(r.out.split('\n').includes(line), `missing "${line}" in:\n${r.out}`);
  }
});

test('uninstall removes every maître file, the unit and the keybinding, and keeps config.json', () => {
  const b = sandbox();
  const p = paths(b);
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  const config = read(join(b.mh, 'config.json'));
  const r = b.run('--uninstall');
  assert.equal(r.status, 0, r.out);
  for (const f of Object.values(p)) assert.equal(existsSync(f), false, f);
  assert.equal(existsSync(join(b.mh, 'installed.json')), false);
  assert.equal(read(join(b.mh, 'config.json')), config);
  assert.ok(existsSync(join(b.mh, 'state', 'projects.json')));
  assert.match(r.out, /kept .*\.maitre/);
  assert.deepEqual(b.calls('systemctl').slice(2), [
    ['--user', 'disable', '--now', 'maitre'],
    ['--user', 'daemon-reload'],
  ]);
  assert.deepEqual(b.readDb(), SEED);
});

test('uninstall leaves the message tray alone when the user gave <Super>m back to it', () => {
  const b = sandbox();
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  const db = b.readDb();
  assert.equal(db[TRAY]['toggle-message-tray'], "['<Super>v']");
  db[TRAY]['toggle-message-tray'] = "['<Super>m']";
  writeFileSync(b.db, JSON.stringify(db));
  const r = b.run('--uninstall');
  assert.equal(r.status, 0, r.out);
  assert.equal(b.readDb()[TRAY]['toggle-message-tray'], "['<Super>m']");
});

test('uninstall keeps a file that lost the marker after setup', () => {
  const b = sandbox();
  const p = paths(b);
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  writeFileSync(p.desktop, '[Desktop Entry]\nName=mine\n');
  const r = b.run('--uninstall');
  assert.equal(r.status, 0, r.out);
  assert.equal(read(p.desktop), '[Desktop Entry]\nName=mine\n');
  assert.equal(existsSync(p.unit), false);
});

test('a foreign unit is never overwritten and the service is not touched', () => {
  const b = sandbox();
  const p = paths(b);
  mkdirSync(dirname(p.unit), { recursive: true });
  writeFileSync(p.unit, '[Service]\nExecStart=/bin/true\n');
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 0, r.out);
  assert.equal(read(p.unit), '[Service]\nExecStart=/bin/true\n');
  assert.deepEqual(b.calls('systemctl'), []);
  assert.match(r.out, /left .*maitre\.service/);
});

test('a foreign file at maître\'s own wrapper stops setup before anything is written', () => {
  const b = sandbox();
  const p = paths(b);
  mkdirSync(dirname(p.wrapper), { recursive: true });
  writeFileSync(p.wrapper, '#!/bin/sh\n');
  const before = state(b);
  const r = b.run('--yes', '--roots', b.code);
  assert.equal(r.status, 1, r.out);
  assert.deepEqual(state(b), before);
});

test('planSetup outside GNOME prints the command to bind by hand and plans no setting', () => {
  const probe: Probe = { read: () => undefined, sha256: () => 'x', which: (n) => `/fake/${n}`, gsettings: () => undefined };
  const env = { HOME: '/h', MAITRE_HOME: '/h/.maitre', PATH: '/h/.local/bin:/usr/bin', XDG_CURRENT_DESKTOP: 'KDE' };
  const actions = planSetup({ ...(parseSetupArgs(['--yes']) as Exclude<ReturnType<typeof parseSetupArgs>, { error: string }>), roots: ['/code'] }, env, probe);
  assert.equal(actions.filter((a) => a.kind === 'gset').length, 0);
  assert.ok(actions.some((a) => a.kind === 'note' && a.text.includes('/h/.maitre/bin/maitre prompt')));
  assert.ok(!actions.some((a) => a.kind === 'note' && a.text.includes('not on your PATH')));
});

test('a message tray without <Super>m is never touched, by setup or by uninstall', () => {
  const db: Db = { ...SEED, [TRAY]: { 'toggle-message-tray': "['<Super>v']" } };
  const b = sandbox({ db });
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  assert.equal(b.readDb()[OURS].binding, "'<Super>m'");
  assert.ok(!b.calls('gsettings').some((c) => c[0] === 'set' && c[1] === TRAY));
  const manifest = JSON.parse(read(join(b.mh, 'installed.json'))) as { settings: { schema: string }[] };
  assert.ok(!manifest.settings.some((s) => s.schema === TRAY));
  assert.equal(b.run('--uninstall').status, 0);
  assert.deepEqual(b.readDb(), db);
});

test('planSetup quotes paths with blanks and leaves MAITRE_HOME out of the unit when it is not set', () => {
  const probe: Probe = {
    read: () => undefined,
    sha256: () => 'x',
    which: (n) => `/fake/${n}`,
    gsettings: (args) => (args[0] === 'get' ? '@as []' : undefined),
  };
  const env = { HOME: '/home/a b', PATH: '/usr/bin', XDG_CURRENT_DESKTOP: 'GNOME' };
  const opts = parseSetupArgs(['--yes']) as Exclude<ReturnType<typeof parseSetupArgs>, { error: string }>;
  const actions = planSetup(opts, env, probe);
  const content = (suffix: string) => {
    const a = actions.find((x) => x.kind === 'write' && x.path.endsWith(suffix));
    assert.ok(a !== undefined && a.kind === 'write', suffix);
    return a.content.split('\n');
  };
  const wrapper = '/home/a b/.maitre/bin/maitre';
  assert.ok(content('maitre.service').includes(`ExecStart="${wrapper}" serve`));
  assert.ok(!content('maitre.service').some((l) => l.includes('MAITRE_HOME')));
  assert.ok(content('maitre.desktop').includes(`Exec="${wrapper}" open`));
  assert.ok(content('maitre.desktop').includes(`Exec=x-terminal-emulator -e "${wrapper}"`));
  assert.equal(content('.maitre/bin/maitre').join('\n'), wrapperOf(''));
  assert.ok(!content('.maitre/bin/maitre').some((l) => l.includes('MAITRE_HOME')));
  assert.ok(!actions.some((a) => a.kind === 'run' && a.argv.includes('try-restart')));
  const command = actions.find((a) => a.kind === 'gset' && a.key === 'command');
  assert.ok(command?.kind === 'gset');
  assert.equal(command.value, `'\\'${wrapper}\\' prompt'`);
});

const manifestOf = (b: Box) => JSON.parse(read(join(b.mh, 'installed.json'))) as { files: unknown[]; settings: { schema: string; key: string; previous?: string }[] };

test('uninstall without gsettings keeps the settings it could not undo, and a later uninstall finishes', () => {
  const b = sandbox();
  const p = paths(b);
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  const installed = b.readDb();
  renameSync(join(b.fakes, 'gsettings'), join(b.root, 'gsettings.off'));
  const r = b.run('--uninstall');
  assert.equal(r.status, 0, r.out);
  for (const f of Object.values(p)) assert.equal(existsSync(f), false, f);
  assert.deepEqual(b.readDb(), installed);
  assert.match(r.out, /kept .*installed\.json: could not undo the maître shortcut \(gsettings not found\); toggle-message-tray/);
  const left = manifestOf(b);
  assert.deepEqual(left.files, []);
  assert.equal(left.settings.find((s) => s.key === 'toggle-message-tray')?.previous, "['<Super>v', '<Super>m']");
  assert.ok(left.settings.some((s) => s.key === 'custom-keybindings'));

  renameSync(join(b.root, 'gsettings.off'), join(b.fakes, 'gsettings'));
  const again = b.run('--uninstall');
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(b.readDb(), SEED);
  assert.equal(existsSync(join(b.mh, 'installed.json')), false);
});

test('an unreadable message tray is kept in installed.json, not taken as already restored', () => {
  const b = sandbox();
  assert.equal(b.run('--yes', '--roots', b.code).status, 0);
  const db = b.readDb();
  delete db[TRAY]['toggle-message-tray'];
  writeFileSync(b.db, JSON.stringify(db));
  const r = b.run('--uninstall');
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /already back/);
  assert.match(r.out, /could not undo toggle-message-tray \(cannot read it/);
  assert.equal(b.readDb()[MK]['custom-keybindings'], '@as []');
  assert.equal(b.readDb()[OURS], undefined);
  assert.deepEqual(manifestOf(b).settings, [{ schema: TRAY, key: 'toggle-message-tray', previous: "['<Super>v', '<Super>m']" }]);

  const fixed = b.readDb();
  fixed[TRAY]['toggle-message-tray'] = "['<Super>v']";
  writeFileSync(b.db, JSON.stringify(fixed));
  const again = b.run('--uninstall');
  assert.equal(again.status, 0, again.out);
  assert.equal(b.readDb()[TRAY]['toggle-message-tray'], "['<Super>v', '<Super>m']");
  assert.equal(existsSync(join(b.mh, 'installed.json')), false);
});
