import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from './version.js';
import { EventTail } from './event-tail.js';
import { LiveRooms, liveRoutes } from './live-api.js';
import { startLoungeServer } from './lounge-server.js';
import { openApp } from './open-app.js';
import { maitreHome, roomSlug } from './paths.js';
import { reservedFlag, runRoom } from './room-run.js';
import { STATUSES, runStatus, type RoomStatus } from './status.js';

export interface LoungeArgs {
  cmd: 'lounge' | 'help' | 'version';
  demo: boolean;
  port: number;
  open: boolean;
  lang: 'en' | 'pt-BR';
}

export type CliArgs =
  | LoungeArgs
  | { cmd: 'room-run'; room: string; extra: string[] }
  | { cmd: 'status'; status: RoomStatus; text: string; options: string[] }
  | { cmd: 'usage'; error: string };

const ROOM_USAGE = 'usage: maitre room run <name> [-- <claude args>]';
const STATUS_USAGE = `usage: maitre status <${STATUSES.join('|')}> "<text>" [--option <o>]...`;

function parseRoom(argv: string[]): CliArgs {
  const [sub, name, ...rest] = argv;
  if (sub !== 'run' || name === undefined || name.startsWith('-')) return { cmd: 'usage', error: ROOM_USAGE };
  if (rest.length > 0 && rest[0] !== '--') return { cmd: 'usage', error: ROOM_USAGE };
  const extra = rest.slice(1);
  const reserved = reservedFlag(extra);
  if (reserved !== undefined) return { cmd: 'usage', error: `${reserved.split('=')[0]} is set by maitre for every room and cannot be passed after --` };
  return { cmd: 'room-run', room: name, extra };
}

function parseStatus(argv: string[]): CliArgs {
  const [status, text, ...rest] = argv;
  if (!STATUSES.includes(status as RoomStatus) || text === undefined) return { cmd: 'usage', error: STATUS_USAGE };
  const options: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== '--option' || rest[i + 1] === undefined) return { cmd: 'usage', error: STATUS_USAGE };
    options.push(rest[i + 1]);
  }
  return { cmd: 'status', status: status as RoomStatus, text, options };
}

export function parseArgs(argv: string[]): CliArgs {
  // Subcommands with free-form arguments parse positionally, so their text is never read as a flag.
  if (argv[0] === 'room') return parseRoom(argv.slice(1));
  if (argv[0] === 'status') return parseStatus(argv.slice(1));
  const out: LoungeArgs = { cmd: 'help', demo: false, port: 8737, open: true, lang: 'en' };
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
  maitre room run <name> [-- <claude args>]
  maitre status <working|waiting|blocked> "<text>" [--option <o>]...
  maitre --version

Commands:
  lounge        Watch your rooms live in the lounge (--demo: simulated agents)
  room run      Start Claude Code in a named room the lounge can see
  status        Inside a room, declare what it is doing (blocked: offer --option choices)

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
  if (args.cmd === 'usage') {
    console.error(`maitre: ${args.error}`);
    process.exitCode = 2;
    return;
  }
  if (args.cmd === 'status') {
    process.exitCode = runStatus(args.status, args.text, args.options);
    return;
  }
  if (args.cmd === 'room-run') {
    try {
      roomSlug(args.room);
    } catch {
      console.error(`maitre: invalid room name ${JSON.stringify(args.room)}; use letters or digits`);
      process.exitCode = 2;
      return;
    }
    let code: number;
    try {
      code = await runRoom(args.room, args.extra);
    } catch (err) {
      console.error(`maitre: could not prepare the room: ${(err as Error).message}`);
      code = 1;
    }
    process.exit(code);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lounge');
  const token = randomBytes(32).toString('hex');
  const rooms = args.demo ? undefined : new LiveRooms();
  const server = await startLoungeServer({ root, port: args.port, token, routes: rooms && liveRoutes(rooms) });
  const tail = rooms && new EventTail(join(maitreHome(), 'state'), (line) => rooms.apply(line));
  // The first scan is synchronous: existing rooms are replayed before the URL is printed.
  tail?.start();
  let url = server.url;
  if (args.demo) url += '&demo=1';
  if (args.lang !== 'en') url += `&lang=${args.lang}`;
  console.log(`maitre lounge: ${url}`);
  if (args.open) openApp(url);
  console.log('Press Ctrl+C to stop.');
  const stop = () => {
    tail?.stop();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
