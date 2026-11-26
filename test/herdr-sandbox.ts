import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-herdr.mjs', import.meta.url));
const FAKE_KEYS = /^FAKE_HERDR_|^MAITRE_/;

export interface FakeState {
  next: number;
  workspaces: Record<string, { label: string; cwd?: string; env?: Record<string, string> }>;
  panes: Record<string, { ws: string; agent: string; trust?: boolean; screen?: string; ran?: string[] }>;
}

export interface HerdrSandbox {
  dir: string;
  home: string;
  bin: string;
  log: string;
  stateFile: string;
  env: NodeJS.ProcessEnv;
  calls(): string[][];
  state(): FakeState;
  setState(s: FakeState): void;
  restore(): void;
}

// A stateful fake herdr first on PATH, a temp MAITRE_HOME and a non-default session, on process.env
// (most herdr calls read it). `env` is the same setup for spawned CLIs, with a minimal PATH.
export function herdrSandbox(): HerdrSandbox {
  const saved = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), 'maitre-rooms-'));
  const bin = join(dir, 'bin');
  const home = join(dir, 'home');
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(join(bin, 'herdr'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(join(bin, 'herdr'), 0o755);
  const log = join(dir, 'argv.log');
  const stateFile = join(dir, 'herdr-state.json');
  for (const k of Object.keys(process.env)) if (FAKE_KEYS.test(k)) delete process.env[k];
  // Window URLs carry the locale's language: tests must not depend on the machine's.
  for (const k of ['LC_ALL', 'LC_MESSAGES', 'LANG']) delete process.env[k];
  const vars = { FAKE_HERDR_LOG: log, FAKE_HERDR_STATE: stateFile, MAITRE_HOME: home, MAITRE_HERDR_SESSION: 'maitre-test' };
  Object.assign(process.env, vars, { PATH: `${bin}${delimiter}${saved.PATH}` });
  const env: NodeJS.ProcessEnv = { ...vars, PATH: [bin, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter) };
  return {
    dir,
    home,
    bin,
    log,
    stateFile,
    env,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => (JSON.parse(l) as string[]).slice(2))
        : [],
    state: () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { next: 1, workspaces: {}, panes: {} }),
    setState: (s) => writeFileSync(stateFile, JSON.stringify(s)),
    restore: () => {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
