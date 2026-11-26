import { randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { VERSION } from './version.js';
import { EventTail } from './event-tail.js';
import { LiveRooms, liveRoutes } from './live-api.js';
import { ReceptionQueue, receptionRoutes } from './lounge-reception.js';
import { claimLounge, liveLounge, loungeToken, releaseLounge } from './lounge-file.js';
import { startLoungeServer, TicketStore } from './lounge-server.js';
import { ensureLounge, hasDisplay, notifyDesktop, openWindow, ticketUrl } from './open-app.js';
import { loadConfig, saveConfig } from './config.js';
import { maitreHome, roomSlug } from './paths.js';
import { readIndex, scanProjects, writeIndex } from './projects.js';
import { closeRoom, deliverToRoom, describeDelivery, describeOpen, listRoomRows, openRoom, type RoomRow } from './room-open.js';
import { attach, runReception, startMaitre } from './reception.js';
import { parseSetupArgs, runSetup, type SetupOptions } from './setup.js';
import { reservedFlag, runRoom } from './room-run.js';
import { describeRoute, dispatchRoute, isRequestId, routeRequests } from './router.js';
import { STATUSES, runStatus, type RoomStatus } from './status.js';

export interface LoungeArgs {
  cmd: 'lounge' | 'serve' | 'help' | 'version';
  demo: boolean;
  port: number;
  open: boolean;
  lang: 'en' | 'pt-BR';
}

export type CliArgs =
  | LoungeArgs
  | { cmd: 'room-run'; room: string; extra: string[]; briefFile?: string }
  | { cmd: 'room-open'; name: string; project?: string; model: string; taskType: string; brief?: string; briefFile?: string }
  | { cmd: 'room-send'; room: string; text: string }
  | { cmd: 'room-list' }
  | { cmd: 'room-close'; room: string }
  | { cmd: 'status'; status: RoomStatus; text: string; options: string[] }
  | { cmd: 'index'; roots: string[] }
  | { cmd: 'projects' }
  | { cmd: 'route'; ids: string[]; json: boolean }
  | { cmd: 'dispatch'; id: string }
  | { cmd: 'start' }
  | { cmd: 'reception' }
  | { cmd: 'open' }
  | { cmd: 'prompt' }
  | { cmd: 'setup'; opts: SetupOptions }
  | { cmd: 'usage'; error: string };

const ROOM_RUN_USAGE = 'usage: maitre room run <name> [--brief-file <path>] [-- <claude args>]';
const ROOM_OPEN_USAGE = 'usage: maitre room open <name> [--project <p>] --model <m> --task <type> (--brief "<text>" | --brief-file <path>)';
const ROOM_USAGE = 'usage: maitre room <open|send|list|close|run> ...';
const INDEX_USAGE = 'usage: maitre index [--root <dir>]...';
const ROUTE_USAGE = 'usage: maitre route <id> [<id>...] [--json]';
const DISPATCH_USAGE = 'usage: maitre dispatch <id>';
const STATUS_USAGE = `usage: maitre status <${STATUSES.join('|')}> "<text>" [--option <o>]...`;

const usage = (error: string): CliArgs => ({ cmd: 'usage', error });
const isName = (s: string | undefined): s is string => s !== undefined && !s.startsWith('-');
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function parseRoomRun(argv: string[]): CliArgs {
  const [name, ...rest] = argv;
  if (!isName(name)) return usage(ROOM_RUN_USAGE);
  let briefFile: string | undefined;
  let more = rest;
  if (more[0] === '--brief-file') {
    if (more[1] === undefined || more[1] === '--') return usage(ROOM_RUN_USAGE);
    briefFile = more[1];
    more = more.slice(2);
  }
  if (more.length > 0 && more[0] !== '--') return usage(ROOM_RUN_USAGE);
  const extra = more.slice(1);
  const reserved = reservedFlag(extra);
  if (reserved !== undefined) return usage(`${reserved.split('=')[0]} is set by maitre for every room and cannot be passed after --`);
  return briefFile === undefined ? { cmd: 'room-run', room: name, extra } : { cmd: 'room-run', room: name, extra, briefFile };
}

const OPEN_FLAGS: Record<string, 'project' | 'model' | 'taskType' | 'brief' | 'briefFile'> = {
  '--project': 'project',
  '--model': 'model',
  '--task': 'taskType',
  '--brief': 'brief',
  '--brief-file': 'briefFile',
};

// Pairs are read positionally, so a value (a brief starting with "-") is never taken for a flag.
function parseRoomOpen(argv: string[]): CliArgs {
  const [name, ...rest] = argv;
  if (!isName(name)) return usage(ROOM_OPEN_USAGE);
  const got: Partial<Record<'project' | 'model' | 'taskType' | 'brief' | 'briefFile', string>> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = Object.hasOwn(OPEN_FLAGS, rest[i]) ? OPEN_FLAGS[rest[i]] : undefined;
    if (key === undefined || rest[i + 1] === undefined || got[key] !== undefined) return usage(ROOM_OPEN_USAGE);
    got[key] = rest[i + 1];
  }
  const { project, model, taskType, brief, briefFile } = got;
  if (model === undefined || taskType === undefined || (brief === undefined) === (briefFile === undefined)) return usage(ROOM_OPEN_USAGE);
  return {
    cmd: 'room-open',
    name,
    model,
    taskType,
    ...(project !== undefined ? { project } : {}),
    ...(brief !== undefined ? { brief } : { briefFile }),
  };
}

function parseRoom(argv: string[]): CliArgs {
  const [sub, ...rest] = argv;
  if (sub === 'run') return parseRoomRun(rest);
  if (sub === 'open') return parseRoomOpen(rest);
  if (sub === 'send') {
    return rest.length === 2 && isName(rest[0]) ? { cmd: 'room-send', room: rest[0], text: rest[1] } : usage('usage: maitre room send <room> "<text>"');
  }
  if (sub === 'list') return rest.length === 0 ? { cmd: 'room-list' } : usage('usage: maitre room list');
  if (sub === 'close') return rest.length === 1 && isName(rest[0]) ? { cmd: 'room-close', room: rest[0] } : usage('usage: maitre room close <room>');
  return usage(ROOM_USAGE);
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

function parseIndex(argv: string[]): CliArgs {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] !== '--root' || argv[i + 1] === undefined) return { cmd: 'usage', error: INDEX_USAGE };
    roots.push(resolve(argv[i + 1]));
  }
  return { cmd: 'index', roots };
}

function parseRoute(argv: string[]): CliArgs {
  const json = argv.includes('--json');
  const ids = argv.filter((a) => a !== '--json');
  return ids.length > 0 && ids.every(isRequestId) ? { cmd: 'route', ids, json } : usage(ROUTE_USAGE);
}

export function parseArgs(argv: string[]): CliArgs {
  if (argv.length === 0) return { cmd: 'start' };
  if (argv[0] === 'reception') return argv.length === 1 ? { cmd: 'reception' } : usage('usage: maitre reception');
  if (argv[0] === 'open' || argv[0] === 'prompt') return argv.length === 1 ? { cmd: argv[0] } : usage(`usage: maitre ${argv[0]}`);
  if (argv[0] === 'setup') {
    const opts = parseSetupArgs(argv.slice(1));
    return 'error' in opts ? usage(opts.error) : { cmd: 'setup', opts };
  }
  // Subcommands with free-form arguments parse positionally, so their text is never read as a flag.
  if (argv[0] === 'room') return parseRoom(argv.slice(1));
  if (argv[0] === 'status') return parseStatus(argv.slice(1));
  if (argv[0] === 'index') return parseIndex(argv.slice(1));
  if (argv[0] === 'route') return parseRoute(argv.slice(1));
  if (argv[0] === 'dispatch') return argv.length === 2 && isRequestId(argv[1]) ? { cmd: 'dispatch', id: argv[1] } : usage(DISPATCH_USAGE);
  if (argv[0] === 'projects') return argv.length === 1 ? { cmd: 'projects' } : { cmd: 'usage', error: 'usage: maitre projects' };
  const out: LoungeArgs = { cmd: 'help', demo: false, port: 8737, open: true, lang: 'en' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'lounge') out.cmd = 'lounge';
    else if (a === 'serve') out.cmd = 'serve';
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
  if (out.cmd === 'serve') {
    out.demo = false;
    out.open = false;
  }
  return out;
}

export const HELP = `maitre ${VERSION}

Usage:
  maitre
  maitre lounge [--demo] [--port <n>] [--no-open] [--lang en|pt-BR]
  maitre serve [--port <n>]
  maitre open
  maitre prompt
  maitre setup [--roots <a,b>] [--shortcut <accel>] [--no-shortcut] [--no-service] [--yes] [--dry-run] [--uninstall]
  maitre room open <name> [--project <p>] --model <m> --task <type> (--brief "<text>" | --brief-file <path>)
  maitre room send <room> "<text>"
  maitre room list
  maitre room close <room>
  maitre room run <name> [--brief-file <path>] [-- <claude args>]
  maitre status <working|waiting|blocked> "<text>" [--option <o>]...
  maitre index [--root <dir>]...
  maitre projects
  maitre route <id> [<id>...] [--json]
  maitre dispatch <id>
  maitre reception
  maitre --version

Commands:
  (none)        Open the maître herdr session (reception and lounge) and attach to it
  lounge        Watch your rooms live in the lounge (--demo: simulated agents)
  serve         Run the live lounge without opening a window (for the login service)
  open          Open the lounge window, starting the lounge first if needed
  prompt        Open the small prompt window, starting the lounge first if needed
  setup         Install the command, the login service, the app icon and the GNOME shortcut (--uninstall undoes it)
  room open     Open a room in its own herdr tab (a git worktree with --project, else a scratch dir)
  room send     Send a message to a running room without waiting for its turn
  room list     List rooms with their herdr status and lounge state
  room close    Exit a room and close its tab (its directory is kept)
  room run      Start Claude Code in a named room the lounge can see
  index         Scan roots for git repos and write the project index
  projects      List indexed projects
  route         Classify captured reception requests and store the route
  dispatch      Open or feed the room a stored route points to
  reception     Run the reception in this terminal (the maître session starts it for you)
  status        Inside a room, declare what it is doing (blocked: offer --option choices)

Options:
  --demo        Run the lounge with simulated agents
  --port <n>    Preferred port (default 8737; falls back to the next free one)
  --no-open     Do not open a browser window
  --lang <l>    Interface language: en or pt-BR (default en)
`;

function formatRows(rows: RoomRow[]): string[] {
  const cells = rows.map((r) => [r.room, r.project ?? 'scratch', r.model, r.herdr, r.lounge]);
  const widths = cells[0].map((_, i) => Math.max(...cells.map((c) => c[i].length)));
  return cells.map((c) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]))).join('  '));
}

function sendConfirm(): { confirmMs?: number } {
  const ms = Number(process.env.MAITRE_SEND_CONFIRM_MS);
  return Number.isFinite(ms) && ms > 0 ? { confirmMs: ms } : {};
}

// Usually run from an app icon or a shortcut, with no terminal to read stderr: failures also notify.
async function openDoor(cmd: 'open' | 'prompt', env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const ms = Number(env.MAITRE_LOUNGE_WAIT_MS);
    const info = await ensureLounge(env, Number.isFinite(ms) && ms > 0 ? { timeoutMs: ms } : {});
    const url = await ticketUrl(info, cmd === 'open' ? '/' : '/prompt.html');
    if (openWindow(cmd === 'open' ? 'lounge' : 'prompt', url, env)) return 0;
    const why = hasDisplay(env) ? 'no browser found (google-chrome or xdg-open)' : 'no display for a window';
    console.error(`maitre: ${why}; open ${url} within a minute`);
    notifyDesktop(why, env);
  } catch (err) {
    const message = (err as Error).message;
    console.error(`maitre: ${message}`);
    notifyDesktop(message, env);
  }
  return 1;
}

async function roomCommand(args: Extract<CliArgs, { cmd: 'room-open' | 'room-send' | 'room-list' | 'room-close' }>): Promise<void> {
  if (args.cmd === 'room-open') {
    let brief = args.brief;
    if (brief === undefined) {
      try {
        brief = readFileSync(args.briefFile!, 'utf8');
      } catch (err) {
        throw new Error(`could not read the brief file: ${(err as Error).message}`);
      }
    }
    const rec = await openRoom({ name: args.name, project: args.project, model: args.model, taskType: args.taskType, brief });
    for (const w of rec.warnings) console.error(`maitre: warning: ${w}`);
    console.log(describeOpen(rec));
  } else if (args.cmd === 'room-send') {
    const room = roomSlug(args.room);
    console.log(describeDelivery(room, await deliverToRoom(room, args.text, process.env, sendConfirm())));
  } else if (args.cmd === 'room-list') {
    const rows = await listRoomRows();
    console.log(rows.length === 0 ? 'no rooms' : formatRows(rows).join('\n'));
  } else {
    console.log(`closed ${(await closeRoom(args.room)).room}`);
  }
}

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
  if (args.cmd === 'start') {
    try {
      const ms = Number(process.env.MAITRE_TRUST_TIMEOUT_MS);
      const r = await startMaitre(process.env, Number.isFinite(ms) && ms > 0 ? { trustTimeoutMs: ms } : {});
      for (const n of r.notes) console.log(n);
      for (const w of r.warnings) console.error(`maitre: warning: ${w}`);
    } catch (err) {
      console.error(`maitre: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
    process.exit(await attach(process.env));
  }
  if (args.cmd === 'open' || args.cmd === 'prompt') {
    process.exitCode = await openDoor(args.cmd);
    return;
  }
  if (args.cmd === 'setup') {
    process.exitCode = await runSetup(args.opts);
    return;
  }
  if (args.cmd === 'reception') {
    let code: number;
    try {
      code = await runReception(process.env);
    } catch (err) {
      console.error(`maitre: could not start the reception: ${(err as Error).message}`);
      code = 1;
    }
    process.exit(code);
  }
  if (args.cmd === 'index') {
    try {
      const missing = args.roots.find((r) => !isDir(r));
      if (missing !== undefined) {
        console.error(`maitre: root not found: ${missing}`);
        process.exitCode = 1;
        return;
      }
      const cfg = loadConfig();
      for (const r of args.roots) if (!cfg.roots.includes(r)) cfg.roots.push(r);
      if (cfg.roots.length === 0) {
        console.error('maitre: no roots configured; add a root: maitre index --root <dir>');
        process.exitCode = 1;
        return;
      }
      if (args.roots.length > 0) saveConfig(cfg);
      const projects = scanProjects(cfg.roots, cfg);
      writeIndex(projects);
      console.log(`maitre: indexed ${projects.length} project(s) under ${cfg.roots.length} root(s)`);
    } catch (err) {
      console.error(`maitre: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.cmd === 'projects') {
    try {
      for (const p of readIndex()) console.log(`${p.name}  ${p.base}  ${p.path}`);
    } catch (err) {
      console.error(`maitre: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.cmd === 'route' || args.cmd === 'dispatch') {
    try {
      if (args.cmd === 'route') {
        const { id, route, warning } = await routeRequests(args.ids);
        if (warning !== undefined) console.error(`maitre: warning: ${warning}`);
        console.log(args.json ? JSON.stringify(warning !== undefined ? { ...route, warning } : route) : describeRoute(id, route));
      } else {
        for (const line of await dispatchRoute(args.id, process.env, sendConfirm())) {
          if (line.startsWith('warning: ')) console.error(`maitre: ${line}`);
          else console.log(line);
        }
      }
    } catch (err) {
      console.error(`maitre: ${(err as Error).message}`);
      process.exitCode = 1;
    }
    return;
  }
  if (args.cmd === 'status') {
    process.exitCode = runStatus(args.status, args.text, args.options);
    return;
  }
  if (args.cmd === 'room-open' || args.cmd === 'room-send' || args.cmd === 'room-list' || args.cmd === 'room-close') {
    try {
      await roomCommand(args);
    } catch (err) {
      console.error(`maitre: ${(err as Error).message}`);
      process.exitCode = 1;
    }
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
    let brief: string | undefined;
    if (args.briefFile !== undefined) {
      try {
        brief = readFileSync(args.briefFile, 'utf8');
      } catch (err) {
        console.error(`maitre: could not read the brief file: ${(err as Error).message}`);
        process.exitCode = 1;
        return;
      }
    }
    let code: number;
    try {
      code = await runRoom(args.room, args.extra, process.env, brief);
    } catch (err) {
      console.error(`maitre: could not prepare the room: ${(err as Error).message}`);
      code = 1;
    }
    process.exit(code);
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'lounge');
  const live = !args.demo;
  if (live) {
    const running = await liveLounge();
    if (running) {
      console.error(`maitre: a lounge is already running on port ${running.port}`);
      // serve exits 0 so the unit's Restart=on-failure does not loop while a terminal lounge runs.
      process.exitCode = args.cmd === 'serve' ? 0 : 1;
      return;
    }
  }
  const token = live ? loungeToken() : randomBytes(32).toString('hex');
  const rooms = live ? new LiveRooms() : undefined;
  const tickets = new TicketStore();
  const reception = live ? receptionRoutes({ queue: new ReceptionQueue(), env: process.env }) : undefined;
  const server = await startLoungeServer({ root, port: args.port, token, tickets, routes: rooms && liveRoutes(rooms, { tickets, reception }) });
  if (live) claimLounge(server.port);
  const tail = rooms && new EventTail(join(maitreHome(), 'state'), (line) => rooms.apply(line));
  // The first scan is synchronous: existing rooms are replayed before the URL is printed.
  tail?.start();
  const stop = () => {
    tail?.stop();
    if (live) releaseLounge();
    void server.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (args.cmd === 'serve') {
    console.log(`maitre serve: http://127.0.0.1:${server.port}/`);
  } else {
    let query = '';
    if (args.demo) query += '&demo=1';
    if (args.lang !== 'en') query += `&lang=${args.lang}`;
    console.log(`maitre lounge: ${server.url}${query}`);
    // The window gets a one-time ticket: the key URL above is for this terminal only.
    if (args.open) openWindow('lounge', `http://127.0.0.1:${server.port}/?ticket=${tickets.issue()}${query}`);
    console.log('Press Ctrl+C to stop.');
  }
}
