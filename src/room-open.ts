import { chmodSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HookLine } from './events.js';
import {
  HerdrError,
  RoomBlockedError,
  agentInfo,
  closeWorkspace,
  createWorkspace,
  ensureServer,
  herdrSession,
  listWorkspaces,
  prompt,
  runInPane,
  shellQuote,
  type AgentInfo,
} from './herdr.js';
import { maitreHome, roomDir, roomSlug } from './paths.js';
import { readIndex, type Project } from './projects.js';
import { BRIEF_HEADER, reduce, type RoomState } from './room-state.js';
import { listRooms, readRoom, writeRoom, type RoomRecord } from './rooms.js';
import { appendRoomLine } from './status.js';
import { handleTrust } from './trust.js';
import { createScratch, createWorktree } from './worktree.js';

export { BRIEF_HEADER };
export const STARTING_TEXT = 'Room is still starting — check its tab';
export const TRUST_BLOCKED_TEXT = "Trust this folder? Answer in the room's tab";

// 'unknown': herdr detects the room's agent but cannot tell its state.
export type RoomLiveness = 'working' | 'blocked' | 'idle' | 'unknown' | 'not running';
type Workspaces = { id: string; label: string }[];

const MAITRE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'maitre');
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
// Linux caps a single argv string at 128 KiB, and the brief reaches claude as one.
const MAX_BRIEF_BYTES = 100_000;
const CONFIRM_MS = 10_000;
const EXIT_MS = 5_000;
const POLL_MS = 100;
// The room hook stores at most 300 chars of a prompt, ending in '…' when it cut it.
const PREFIX = 40;
const ELLIPSIS = '…';
const LOUNGE_TAIL_BYTES = 256 * 1024;

const notRunning = (room: string) => new Error(`room ${room} is not running — open it again with: maitre room open …`);
const waitingOnYou = (room: string) => new Error(`room ${room} is waiting on you — answer it in its tab`);
const noRoom = (room: string) => new Error(`no room named ${room} — open it with: maitre room open …`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function roomLabel(rec: Pick<RoomRecord, 'room' | 'project'>): string {
  return `${rec.project ?? 'scratch'} / ${rec.room}`;
}

// herdr restores tabs after a restart as bare shells with new ids, and could in principle hand a stored
// pane id to another tab: a room runs only if its own tab is still there and holds a live agent.
export async function probeRoom(rec: RoomRecord, workspaces?: Workspaces, env: NodeJS.ProcessEnv = process.env): Promise<RoomLiveness> {
  const h = rec.herdr;
  if (h === undefined || h.session !== herdrSession(env)) return 'not running';
  const list = workspaces ?? (await listWorkspaces());
  if (!list.some((w) => w.id === h.workspaceId && w.label === roomLabel(rec))) return 'not running';
  return liveness(await agentInfo(h.paneId));
}

// A bare shell has no detected agent; a detected agent counts even when its status is unknown.
export function liveness(info: AgentInfo): RoomLiveness {
  if (info.status === 'working' || info.status === 'blocked' || info.status === 'idle') return info.status;
  return info.agent !== undefined && info.status === 'unknown' ? 'unknown' : 'not running';
}

export function markNotRunning(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): RoomRecord {
  if (rec.closedAt !== undefined) return rec;
  const out = { ...rec, closedAt: Date.now() };
  writeRoom(out, env);
  return out;
}

// Every tab with this label except `keep`: herdr may have restored copies under new ids.
export async function closeLabeledTabs(label: string, workspaces: Workspaces, keep?: string): Promise<void> {
  for (const w of workspaces) {
    if (w.label !== label || w.id === keep) continue;
    try {
      await closeWorkspace(w.id);
    } catch (e) {
      if (!(e instanceof HerdrError && e.code === 'workspace_not_found')) throw e;
    }
  }
}

export async function closeRoomTabs(rec: RoomRecord, workspaces: Workspaces): Promise<void> {
  await closeLabeledTabs(roomLabel(rec), workspaces);
}

function findProject(name: string, env: NodeJS.ProcessEnv): Project {
  const p = readIndex(env).find((x) => x.name === name);
  if (p === undefined) throw new Error(`unknown project ${name}; list them with: maitre projects`);
  return p;
}

function writeBrief(room: string, brief: string, env: NodeJS.ProcessEnv): string {
  const dir = roomDir(room, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'brief.md');
  writeFileSync(path, `${BRIEF_HEADER}\n\n${brief}`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function paneCommand(room: string, briefPath: string, model: string): string {
  const cmd = [MAITRE_BIN, 'room', 'run', room, '--brief-file', briefPath, '--', '--model', model].map(shellQuote).join(' ');
  // herdr types the command into a shell: a control character would split or alter it.
  if (/[\x00-\x1f\x7f]/.test(cmd)) throw new Error('the room command contains a control character');
  return cmd;
}

// needsTrust: the room waits on Claude Code's folder-trust question, which only the user may answer.
export type OpenedRoom = RoomRecord & { warnings: string[]; needsTrust: boolean };

export function describeOpen(r: OpenedRoom): string {
  const line = `opened ${r.room} in ${r.project ?? 'scratch'} on ${r.model}`;
  return r.needsTrust ? `${line} — answer the folder-trust question in its tab` : line;
}

export async function openRoom(
  opts: { name: string; project?: string; model: string; taskType: string; brief: string },
  env: NodeJS.ProcessEnv = process.env,
  timing: { trustTimeoutMs?: number; pollMs?: number } = {},
): Promise<OpenedRoom> {
  const room = roomSlug(opts.name);
  if (!MODEL.test(opts.model)) throw new Error(`invalid model ${JSON.stringify(opts.model)}`);
  if (Buffer.byteLength(opts.brief) > MAX_BRIEF_BYTES) throw new Error(`the brief is too long (at most ${MAX_BRIEF_BYTES} bytes)`);
  const project = opts.project === undefined ? undefined : findProject(opts.project, env);

  await ensureServer(env);
  const prev = readRoom(room, env);
  if (prev !== undefined) {
    const workspaces = await listWorkspaces();
    if ((await probeRoom(prev, workspaces, env)) !== 'not running') throw new Error(`room ${room} is already open`);
    await closeRoomTabs(prev, workspaces);
  }

  let dir: string;
  let branch: string | undefined;
  let warnings: string[] = [];
  if (project !== undefined) ({ dir, branch, warnings } = createWorktree(project, room, env));
  else dir = createScratch(room, env);

  let ws: { workspaceId: string; paneId: string } | undefined;
  try {
    const briefPath = writeBrief(room, opts.brief, env);
    ws = await createWorkspace({
      cwd: dir,
      label: roomLabel({ room, project: project?.name }),
      env: { MAITRE_ROOM: room, MAITRE_HOME: maitreHome(env) },
    });
    const events = join(roomDir(room, env), 'events.jsonl');
    const offset = fileSize(events);
    await runInPane(ws.paneId, paneCommand(room, briefPath, opts.model));
    const trust = await handleTrust(ws.paneId, dir, {
      timeoutMs: timing.trustTimeoutMs,
      pollMs: timing.pollMs,
      env,
      started: () => sessionStarted(events, offset),
    });
    if (trust === 'no-agent') throw new Error(`room ${room} did not start: no Claude appeared in its tab (is \`claude\` on PATH?)`);
    if (trust === 'unresolved' || trust === 'needs-you') {
      const text = trust === 'needs-you' ? TRUST_BLOCKED_TEXT : STARTING_TEXT;
      appendRoomLine(room, 'MaitreStatus', { status: 'blocked', text, options: [], starting: true }, env);
    }
    const rec: RoomRecord = {
      room,
      ...(project !== undefined ? { project: project.name } : {}),
      kind: project !== undefined ? 'code' : 'scratch',
      dir,
      ...(branch !== undefined ? { branch } : {}),
      model: opts.model,
      taskType: opts.taskType,
      herdr: { session: herdrSession(env), workspaceId: ws.workspaceId, paneId: ws.paneId },
      createdAt: Date.now(),
    };
    writeRoom(rec, env);
    return { ...rec, warnings, needsTrust: trust === 'needs-you' };
  } catch (err) {
    if (ws !== undefined) await closeWorkspace(ws.workspaceId).catch(() => {});
    throw err;
  }
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function readFrom(path: string, offset: number): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let pos = offset;
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
      pos += n;
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): HookLine[] {
  const out: HookLine[] = [];
  for (const l of text.split('\n')) {
    if (l.trim() === '') continue;
    try {
      out.push(JSON.parse(l) as HookLine);
    } catch {
      continue;
    }
  }
  return out;
}

function sessionStarted(file: string, offset: number): boolean {
  return parseLines(readFrom(file, offset)).some((l) => l.event === 'SessionStart' && l.agent_id === undefined);
}

// Claude Code wraps a pasted prompt in these tags. Mirrored in hooks/reception-request.mjs.
const PASTED = /<pasted_content id="\d+">\n?|\n?<\/pasted_content id="\d+">/g;

export function unwrapPasted(text: string): string {
  const out = text.replace(PASTED, '');
  return out === text ? text : out.replace(/^(?:[ \t]*\n)+/, '').replace(/(?:\n[ \t]*)+$/, '');
}

export function promptMatches(stored: string, sent: string): boolean {
  stored = unwrapPasted(stored);
  const cut = stored.endsWith(ELLIPSIS) && !sent.trimEnd().endsWith(ELLIPSIS);
  const core = (cut ? stored.slice(0, -ELLIPSIS.length) : stored).trimStart();
  const want = sent.trimStart().slice(0, PREFIX);
  if (core === '' || want === '') return false;
  if (core.length >= want.length) return core.startsWith(want);
  return cut ? want.startsWith(core) : core === want.trimEnd();
}

async function confirmed(file: string, offset: number, text: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    const hit = parseLines(readFrom(file, offset)).some(
      (l) => l.event === 'UserPromptSubmit' && l.agent_id === undefined && l.synthetic !== true && typeof l.prompt === 'string' && promptMatches(l.prompt, text),
    );
    if (hit) return true;
    if (Date.now() >= deadline) return false;
    await sleep(POLL_MS);
  }
}

export async function sendToRoom(
  room: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { confirmMs?: number } = {},
): Promise<'delivered' | 'unconfirmed'> {
  return (await deliverToRoom(room, text, env, opts)).result;
}

// busy: the room was working; Claude Code injects the text into the running turn, between tool calls.
export async function deliverToRoom(
  room: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { confirmMs?: number } = {},
): Promise<{ result: 'delivered' | 'unconfirmed'; busy: boolean }> {
  const slug = roomSlug(room);
  const rec = readRoom(slug, env);
  if (rec === undefined) throw noRoom(slug);
  if (text.trim() === '') throw new Error('nothing to send');
  if (Buffer.byteLength(text) > MAX_BRIEF_BYTES) throw new Error(`the message is too long (at most ${MAX_BRIEF_BYTES} bytes)`);
  await ensureServer(env);
  const live = await probeRoom(rec, undefined, env);
  if (live === 'not running') {
    markNotRunning(rec, env);
    throw notRunning(slug);
  }
  if (live === 'blocked') throw waitingOnYou(slug);
  const file = join(roomDir(slug, env), 'events.jsonl');
  const offset = fileSize(file);
  try {
    await prompt(rec.herdr!.paneId, text, { wait: false });
  } catch (e) {
    if (e instanceof RoomBlockedError) throw waitingOnYou(slug);
    throw e;
  }
  const ok = await confirmed(file, offset, text, opts.confirmMs ?? CONFIRM_MS);
  return { result: ok ? 'delivered' : 'unconfirmed', busy: live === 'working' };
}

export function describeDelivery(room: string, r: { result: 'delivered' | 'unconfirmed'; busy: boolean }): string {
  if (r.result === 'delivered') return `sent to ${room}`;
  if (r.busy) return `sent to ${room} — it's busy and will see it during this turn`;
  return `sent to ${room} (not confirmed: the room has not shown it yet)`;
}

export interface RoomRow {
  room: string;
  project?: string;
  model: string;
  herdr: RoomLiveness;
  lounge: string;
}

function loungeState(room: string, env: NodeJS.ProcessEnv): string {
  const file = join(roomDir(room, env), 'events.jsonl');
  const size = fileSize(file);
  let text = readFrom(file, Math.max(0, size - LOUNGE_TAIL_BYTES));
  if (size > LOUNGE_TAIL_BYTES) text = text.slice(text.indexOf('\n') + 1);
  let state: RoomState | undefined;
  for (const l of parseLines(text)) state = reduce(state, l);
  return state?.state ?? '-';
}

export function isRecord(rec: RoomRecord): boolean {
  if (typeof rec.room !== 'string') return false;
  try {
    return roomSlug(rec.room) === rec.room;
  } catch {
    return false;
  }
}

export async function listRoomRows(env: NodeJS.ProcessEnv = process.env): Promise<RoomRow[]> {
  const recs = listRooms(env).filter(isRecord);
  if (recs.length === 0) return [];
  await ensureServer(env);
  const workspaces = await listWorkspaces();
  const rows: RoomRow[] = [];
  for (const rec of recs) {
    const herdr = await probeRoom(rec, workspaces, env);
    if (herdr === 'not running') markNotRunning(rec, env);
    rows.push({
      room: rec.room,
      ...(rec.project !== undefined ? { project: rec.project } : {}),
      model: typeof rec.model === 'string' ? rec.model : '-',
      herdr,
      lounge: loungeState(rec.room, env),
    });
  }
  return rows;
}

async function waitForExit(paneId: string, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (liveness(await agentInfo(paneId)) === 'not running') return;
    await sleep(POLL_MS);
  }
}

export async function closeRoom(
  room: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { exitTimeoutMs?: number } = {},
): Promise<RoomRecord> {
  const slug = roomSlug(room);
  const rec = readRoom(slug, env);
  if (rec === undefined) throw noRoom(slug);
  await ensureServer(env);
  const workspaces = await listWorkspaces();
  if ((await probeRoom(rec, workspaces, env)) === 'idle') {
    try {
      await prompt(rec.herdr!.paneId, '/exit', { wait: false });
      await waitForExit(rec.herdr!.paneId, opts.exitTimeoutMs ?? EXIT_MS);
    } catch {
      // Closing the tab ends the session anyway.
    }
  }
  await closeRoomTabs(rec, workspaces);
  const closed = { ...rec, closedAt: rec.closedAt ?? Date.now() };
  writeRoom(closed, env);
  return closed;
}
