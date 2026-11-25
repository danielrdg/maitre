import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { VERSION } from './version.js';
import { startLoungeServer } from './lounge-server.js';
import { openApp } from './open-app.js';

export interface CliArgs {
  cmd: 'lounge' | 'help' | 'version';
  demo: boolean;
  port: number;
  open: boolean;
  lang: 'en' | 'pt-BR';
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { cmd: 'help', demo: false, port: 8737, open: true, lang: 'en' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'lounge') out.cmd = 'lounge';
    else if (a === '--version' || a === '-v') out.cmd = 'version';
    else if (a === '--help' || a === '-h') out.cmd = 'help';
    else if (a === '--demo') out.demo = true;
    else if (a === '--no-open') out.open = false;
    else if (a === '--port') {
      const p = Number(argv[++i]);
      if (Number.isInteger(p) && p >= 0 && p <= 65535) out.port = p;
    } else if (a === '--lang') {
      const l = argv[++i];
      if (l === 'en' || l === 'pt-BR') out.lang = l;
    }
  }
  return out;
}

const HELP = `maitre ${VERSION}

Usage:
  maitre lounge [--demo] [--port <n>] [--no-open] [--lang en|pt-BR]
  maitre --version

Options:
  --demo        Run the lounge with simulated agents
  --port <n>    Preferred port (default 8737; falls back to the next free one)
  --no-open     Do not open a browser window
  --lang <l>    Interface language: en or pt-BR (default en)
`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.cmd === 'version') {
    console.log(VERSION);
    return;
  }
  if (args.cmd === 'help') {
    console.log(HELP);
    return;
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lounge');
  const token = randomBytes(32).toString('hex');
  const server = await startLoungeServer({ root, port: args.port, token });
  let url = server.url;
  if (args.demo) url += '&demo=1';
  if (args.lang !== 'en') url += `&lang=${args.lang}`;
  console.log(`maitre lounge: ${url}`);
  if (args.open) openApp(url);
  console.log('Press Ctrl+C to stop.');
  const stop = () => {
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
