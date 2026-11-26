import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = fileURLToPath(new URL('../../test/fixtures/fake-bin.mjs', import.meta.url));

export interface FakeBin {
  dir: string;
  bin: string;
  add(name: string, opts?: { stdout?: string; exit?: number; spawn?: string[] }): void;
  calls(name: string): string[][];
  waitCalls(name: string, n?: number, ms?: number): Promise<string[][]>;
  cleanup(): void;
}

// A directory of recording fakes, meant to be the whole PATH so no real program can be reached.
export function fakeBin(): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), 'maitre-fakes-'));
  const bin = join(dir, 'bin');
  const logs = join(dir, 'logs');
  mkdirSync(bin);
  mkdirSync(logs);
  const calls = (name: string): string[][] => {
    const log = join(logs, `${name}.log`);
    return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as string[]) : [];
  };
  return {
    dir,
    bin,
    add(name, opts = {}) {
      const path = join(bin, name);
      writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "${logs}" "${name}" "$@"\n`);
      chmodSync(path, 0o755);
      if (opts.stdout !== undefined) writeFileSync(join(logs, `${name}.stdout`), opts.stdout);
      if (opts.exit !== undefined) writeFileSync(join(logs, `${name}.exit`), String(opts.exit));
      if (opts.spawn !== undefined) writeFileSync(join(logs, `${name}.spawn`), JSON.stringify(opts.spawn));
    },
    calls,
    async waitCalls(name, n = 1, ms = 10_000) {
      const deadline = Date.now() + ms;
      while (calls(name).length < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      return calls(name);
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
