import { chmodSync, closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isClosing, ownsClosing } from './closing.js';
import { countsAsActivity, type HookLine } from './events.js';
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
  readPane,
  runInPane,
  sendKeys,
  shellQuote,
  type AgentInfo,
} from './herdr.js';
import { maitreHome, roomDir, roomSlug } from './paths.js';
import { shownText } from './pending.js';
import { dropPrState, readsNotice, roomPr } from './pr-state.js';
import { readIndex, type Project } from './projects.js';
import { BRIEF_HEADER, reduce, type RoomState } from './room-state.js';
import { readFailed, readQueue } from './queue.js';
import { couchHolds, listRooms, parked, patchRoom, readRoom, writeRoom, type RoomRecord } from './rooms.js';
import { appendRoomLine } from './status.js';
import { handleTrust, type TrustResult } from './trust.js';
import { offersWake, parkedState, stillStarting, stillStartingError, wakeSession } from './wake.js';
import { createScratch, createWorktree } from './worktree.js';

export { BRIEF_HEADER };
export const STARTING_TEXT = 'Room is still starting — check its tab';
export const TRUST_BLOCKED_TEXT = "Trust this folder? Answer in the room's tab";

// 'unknown': herdr detects the room's agent but cannot tell its state.
export type RoomLiveness = 'working' | 'blocked' | 'idle' | 'unknown' | 'not running';
type Workspaces = { id: string; label: string }[];

const MAITRE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'maitre');
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
// Linux caps a single argv string at 128 KiB, and the brief reaches claude as one.
export const MAX_BRIEF_BYTES = 100_000;
const CONFIRM_MS = 10_000;
const EXIT_MS = 5_000;
const POLL_MS = 100;
// The room hook stores at most 300 chars of a prompt, ending in '…' when it cut it.
const PREFIX = 40;
const ELLIPSIS = '…';
const LOUNGE_TAIL_BYTES = 256 * 1024;

// A room not offered for waking whose session is known may still be one whose Claude crashed before the
// upgrade stamped it: only the user can tell it from one closed by hand before M3a.
const crashedHint = (rec: RoomRecord, env: NodeJS.ProcessEnv): boolean => rec.closedBy === undefined && !offersWake(rec) && wakeSession(rec, env) !== undefined;

const notRunning = (rec: RoomRecord, env: NodeJS.ProcessEnv) =>
  new Error(
    `room ${rec.room} is not running — ${
      parkedState(rec, env) !== undefined
        ? `wake it with: maitre room wake ${rec.room}`
        : `open it again with: maitre room open …${crashedHint(rec, env) ? ` (or, if its Claude crashed, wake it with: maitre room wake ${rec.room})` : ''}`
    }`,
  );
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

// Only `closedAt`, on the record as it is on disk: the caller's copy may predate a close (closedBy, its
// minutes) or a reopen.
export function markNotRunning(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): RoomRecord {
  return patchRoom(rec, (r) => (r.closedAt !== undefined || r.closedBy !== undefined ? r : { ...r, closedAt: Date.now() }), env);
}

const withoutClosedAt = ({ closedAt: _c, ...r }: RoomRecord): RoomRecord => r;

// A room found running again: a closedAt stamped by a probe that missed it says nothing any more. Found
// running, it was not closed by hand: once its Claude is gone it may be woken (rooms open at the upgrade).
export function markRunning(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): RoomRecord {
  return patchRoom(rec, (r) => (r.closedBy !== undefined || (r.closedAt === undefined && r.resumable === true) ? r : { ...withoutClosedAt(r), resumable: true }), env);
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

export function writeBrief(room: string, brief: string, env: NodeJS.ProcessEnv): string {
  const dir = roomDir(room, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'brief.md');
  writeFileSync(path, `${BRIEF_HEADER}\n\n${brief}`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

// What a room's tab runs, for an open and for a wake alike: a wake adds only `--resume <session>`.
// `run`: an id `maitre room run` writes on its exit line, so a wake tells its own run's end from another's.
export function roomPaneCommand(room: string, model: string, opts: { briefPath?: string; resume?: string; run?: string } = {}): string {
  const run = opts.run !== undefined ? ['--run', opts.run] : [];
  const brief = opts.briefPath !== undefined ? ['--brief-file', opts.briefPath] : [];
  const resume = opts.resume !== undefined ? ['--resume', opts.resume] : [];
  const cmd = [MAITRE_BIN, 'room', 'run', room, ...run, ...brief, '--', '--model', model, ...resume].map(shellQuote).join(' ');
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
  opts: { name: string; project?: string; model: string; taskType: string; brief: string; fromQueue?: number },
  env: NodeJS.ProcessEnv = process.env,
  timing: { trustTimeoutMs?: number; pollMs?: number } = {},
): Promise<OpenedRoom> {
  const room = roomSlug(opts.name);
  // Only the doorman opens a queued name: its requests would otherwise reach no room.
  if (opts.fromQueue === undefined) {
    const queued = queuedPosition(room, env);
    if (queued !== undefined) throw new Error(`${room} is queued (position ${queued}); it opens when a seat frees, or remove it with: maitre room close ${room}`);
  }
  if (!MODEL.test(opts.model)) throw new Error(`invalid model ${JSON.stringify(opts.model)}`);
  if (Buffer.byteLength(opts.brief) > MAX_BRIEF_BYTES) throw new Error(`the brief is too long (at most ${MAX_BRIEF_BYTES} bytes)`);
  const project = opts.project === undefined ? undefined : findProject(opts.project, env);

  if (isClosing(room, env)) throw new Error(`${room} is closing`);
  await ensureServer(env);
  const prev = readRoom(room, env);
  if (prev !== undefined) {
    const workspaces = await listWorkspaces();
    if ((await probeRoom(prev, workspaces, env)) !== 'not running') throw new Error(`room ${room} is already open`);
    if (stillStarting(prev, workspaces, env)) throw stillStartingError(room, 'room ');
    // A fresh open would drop the session the room parked with, and its pr.json.
    if (prev.seat !== undefined && prev.closedBy === undefined) {
      throw new Error(`room ${room} is parked — wake it with: maitre room wake ${room} (or close it first with: maitre room close ${room})`);
    }
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
    ws = await createRoomTab({ room, project: project?.name, dir }, env);
    const trust = await startInTab(room, dir, ws.paneId, roomPaneCommand(room, opts.model, { briefPath }), env, timing);
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
      ...(opts.fromQueue !== undefined ? { fromQueue: opts.fromQueue } : {}),
      resumable: true,
    };
    dropPrState(room, env);
    writeRoom(rec, env);
    return { ...rec, warnings, needsTrust: trust === 'needs-you' };
  } catch (err) {
    if (ws !== undefined) await closeWorkspace(ws.workspaceId).catch(() => {});
    throw err;
  }
}

export function createRoomTab(rec: { room: string; project?: string; dir: string }, env: NodeJS.ProcessEnv): Promise<{ workspaceId: string; paneId: string }> {
  return createWorkspace({ cwd: rec.dir, label: roomLabel(rec), env: { MAITRE_ROOM: rec.room, MAITRE_HOME: maitreHome(env) } });
}

// Runs a fresh Claude (one with a brief) in the room's new tab and waits for it like an open does.
export async function startInTab(
  room: string,
  dir: string,
  paneId: string,
  command: string,
  env: NodeJS.ProcessEnv,
  timing: { trustTimeoutMs?: number; pollMs?: number; resumes?: string },
): Promise<TrustResult> {
  const events = roomEventsFile(room, env);
  const offset = fileSize(events);
  await runInPane(paneId, command);
  const trust = await handleTrust(paneId, dir, {
    timeoutMs: timing.trustTimeoutMs,
    pollMs: timing.pollMs,
    env,
    started: () => sessionStarted(events, offset),
  });
  if (trust === 'no-agent') throw new Error(`room ${room} did not start: no Claude appeared in its tab (is \`claude\` on PATH?)`);
  if (trust === 'unresolved' || trust === 'needs-you') noteStarting(room, trust === 'needs-you' ? TRUST_BLOCKED_TEXT : STARTING_TEXT, env, timing.resumes);
  return trust;
}

// Shown in the lounge until the room's SessionStart clears it. `resumes`: the session of the room a wake
// starts again (its own --resume, or a fresh Claude in its place); a fresh open has none.
export function noteStarting(room: string, text: string, env: NodeJS.ProcessEnv, resumes?: string): void {
  appendRoomLine(room, 'MaitreStatus', { status: 'blocked', text, options: [], starting: true, ...(resumes !== undefined ? { resumes } : {}) }, env);
}

export const roomEventsFile = (room: string, env: NodeJS.ProcessEnv = process.env): string => join(roomDir(room, env), 'events.jsonl');

// An unreadable queue holds no name that can be shown to be queued.
function queuedPosition(room: string, env: NodeJS.ProcessEnv): number | undefined {
  try {
    const i = readQueue(env).findIndex((e) => e.room === room);
    return i >= 0 ? i + 1 : undefined;
  } catch {
    return undefined;
  }
}

export function fileSize(path: string): number {
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

export function linesSince(file: string, offset: number): HookLine[] {
  return parseLines(readFrom(file, offset));
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
): Promise<Delivered['result']> {
  return (await deliverToRoom(room, text, env, opts)).result;
}

// unsent: not confirmed, and the request may sit typed in the room's input box: the user has to look.
// unconfirmed: only for a busy room whose box no longer holds the text (its running turn took it).
export interface Delivered {
  result: 'delivered' | 'unconfirmed' | 'unsent';
  busy: boolean;
}

const RETYPE_MS = 500;
// How long the input box is watched after an unconfirmed delivery: under load the typed text shows up late.
const WATCH_MS = 15_000;
const BOX_POLL_MS = 1_000;
// After maître's own Enter emptied the box, how long more its hook line may take: under load the user's
// other UserPromptSubmit hooks run first (e2e run 5 saw it land 10.5-11 s after the Enter).
const LATE_HOOK_MS = 3_000;
// The longest a delivery waits on a room, herdr's own latency aside: the confirm window, the box watch,
// the second read, the confirm window after an Enter, and the late-hook grace.
export const WORST_DELIVERY_MS = CONFIRM_MS + WATCH_MS + RETYPE_MS + CONFIRM_MS + LATE_HOOK_MS;
const sameTyped = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

// The input box on `screen` holds exactly `text` as maître typed it; Claude Code wraps a long one over lines.
export function holdsTyped(screen: string, text: string): boolean {
  const held = inputText(screen);
  return held !== undefined && held !== '' && sameTyped(held, text);
}

async function boxText(paneId: string): Promise<string | undefined> {
  try {
    return inputText(await readPane(paneId, undefined, { ansi: true }));
  } catch {
    return undefined;
  }
}

// busy: the room was working; Claude Code injects the text into the running turn, between tool calls.
// closing: the token of the room's closing marker, when the caller holds it to keep closers off.
export async function deliverToRoom(
  room: string,
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { confirmMs?: number; closing?: string; watchMs?: number } = {},
): Promise<Delivered> {
  const slug = roomSlug(room);
  const rec = readRoom(slug, env);
  if (rec === undefined) throw noRoom(slug);
  if (opts.closing !== undefined ? !ownsClosing(slug, opts.closing, env) : isClosing(slug, env)) throw new Error(`${slug} is closing`);
  if (text.trim() === '') throw new Error('nothing to send');
  if (Buffer.byteLength(text) > MAX_BRIEF_BYTES) throw new Error(`the message is too long (at most ${MAX_BRIEF_BYTES} bytes)`);
  await ensureServer(env);
  const workspaces = await listWorkspaces();
  const live = await probeRoom(rec, workspaces, env);
  if (live === 'not running') {
    if (stillStarting(rec, workspaces, env)) throw stillStartingError(slug, 'room ');
    markNotRunning(rec, env);
    throw notRunning(rec, env);
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
  const ms = opts.confirmMs ?? CONFIRM_MS;
  const busy = live === 'working';
  if (await confirmed(file, offset, text, ms)) return { result: 'delivered', busy };
  const paneId = rec.herdr!.paneId;
  // A busy room takes the text into its running turn: only a box that no longer holds it says so.
  if (busy) {
    const held = await boxText(paneId);
    if (held !== undefined && !sameTyped(held, text)) return { result: 'unconfirmed', busy: true };
  }
  const sent = await enterIfTyped(rec, paneId, text, () => confirmed(file, offset, text, 0), opts.watchMs ?? opts.confirmMs ?? WATCH_MS, env);
  if (sent && (await confirmed(file, offset, text, ms))) return { result: 'delivered', busy };
  // The box no longer holds the text after maître's Enter: the hook line may just be late.
  if (sent && !holdsTyped(await readOr(paneId), text) && (await confirmed(file, offset, text, LATE_HOOK_MS))) return { result: 'delivered', busy };
  return { result: confirmedNow(file, offset, text) ? 'delivered' : 'unsent', busy };
}

async function readOr(paneId: string): Promise<string> {
  try {
    return await readPane(paneId, undefined, { ansi: true });
  } catch {
    return '';
  }
}

const confirmedNow = (file: string, offset: number, text: string): boolean =>
  parseLines(readFrom(file, offset)).some((l) => l.event === 'UserPromptSubmit' && l.agent_id === undefined && l.synthetic !== true && typeof l.prompt === 'string' && promptMatches(l.prompt, text));

// Watches the input box of an unconfirmed delivery (Claude Code still finishing its start can show the typed
// text late) and presses Enter once when it holds exactly maître's text, read twice and with the room
// still there. Never over anything else. true: Enter was pressed; false: confirmed meanwhile, or not pressed.
async function enterIfTyped(rec: RoomRecord, paneId: string, text: string, done: () => Promise<boolean>, watchMs: number, env: NodeJS.ProcessEnv): Promise<boolean> {
  const until = Date.now() + watchMs;
  const every = Math.min(BOX_POLL_MS, Math.max(20, Math.floor(watchMs / 5)));
  for (;;) {
    if (await done()) return false;
    const held = await boxText(paneId);
    if (held !== undefined && held !== '') {
      if (!sameTyped(held, text)) return false;
      await sleep(RETYPE_MS);
      // The probe first, so the last read is the step right before the Enter.
      let live: RoomLiveness;
      try {
        live = await probeRoom(rec, undefined, env);
      } catch {
        return false;
      }
      if (live !== 'idle' && live !== 'unknown') return false;
      const still = await boxText(paneId);
      if (still === undefined || still === '') {
        if (await done()) return false;
      } else {
        if (!sameTyped(still, text)) return false;
        try {
          await sendKeys(paneId, 'enter');
        } catch {
          return false;
        }
        return true;
      }
    }
    if (Date.now() >= until) return false;
    await sleep(Math.max(1, Math.min(every, until - Date.now())));
  }
}

export function describeDelivery(room: string, r: Delivered): string {
  if (r.result === 'delivered') return `sent to ${room}`;
  if (r.result === 'unsent') return `not confirmed: the request may be typed in ${room}'s input — check its tab and press Enter there`;
  return `sent to ${room} — it's busy and will see it during this turn`;
}

export interface RoomRow {
  room: string;
  project?: string;
  model: string;
  // 'queued': waiting for a seat; 'failed': left the queue after failing to open.
  herdr: RoomLiveness | 'queued' | 'failed';
  lounge: string;
  // A wake left it still starting in its tab: not running for herdr, yet not parked.
  starting?: true;
}

// The newest LOUNGE_TAIL_BYTES of a room's hook events: all the doorman, janitor and CLI read of a room.
export function readEventsTail(room: string, env: NodeJS.ProcessEnv): HookLine[] {
  const file = join(roomDir(room, env), 'events.jsonl');
  const size = fileSize(file);
  let text = readFrom(file, Math.max(0, size - LOUNGE_TAIL_BYTES));
  if (size > LOUNGE_TAIL_BYTES) text = text.slice(text.indexOf('\n') + 1);
  return parseLines(text);
}

// The lounge's view of a room: its live state, a couch that still holds, a dead room's pending reasons.
function loungeColumn(rec: RoomRecord, herdr: RoomLiveness, env: NodeJS.ProcessEnv): string {
  if (rec.closedBy !== undefined) return 'closed';
  let state: RoomState | undefined;
  let last: number | undefined;
  let prompted = -Infinity;
  for (const l of readEventsTail(rec.room, env)) {
    state = reduce(state, l);
    if (countsAsActivity(l)) last = l.ts;
    if (readsNotice(l) && typeof l.ts === 'number') prompted = Math.max(prompted, l.ts);
  }
  const parked = herdr === 'not running' && parkedState(rec, env) !== undefined;
  const column = loungeState(rec, herdr, parked ? 'parked' : (state?.state ?? '-'), last);
  const hint = parked ? ` — wake: maitre room wake ${rec.room}` : herdr === 'not running' && crashedHint(rec, env) ? ` — if its Claude crashed, wake: maitre room wake ${rec.room}` : '';
  return withNotice(`${column}${hint}`, rec, prompted, env);
}

// A PR notice the room has not read yet (no real prompt since), as the lounge shows it.
function withNotice(column: string, rec: RoomRecord, prompted: number, env: NodeJS.ProcessEnv): string {
  const n = roomPr(rec, env)?.notice;
  if (n === undefined || prompted > n.since) return column;
  return `${column}; PR ${n.kind}: ${shownText(n.text, NOTICE_SHOWN)}`;
}

function loungeState(rec: RoomRecord, herdr: RoomLiveness, shown: string, last: number | undefined): string {
  const couch = parked(rec.couch);
  const up = herdr === 'idle' || herdr === 'unknown';
  if (couch !== undefined && up && couchHolds(couch, shown, last)) return `couch: ${couch.reasons.join('; ')}`;
  const pending = parked(rec.pending);
  if (pending !== undefined && herdr === 'not running' && (last ?? -Infinity) <= pending.since) return `${shown}, pending: ${pending.reasons.join('; ')}`;
  return shown;
}

const NOTICE_SHOWN = 80;

export function isRecord(rec: RoomRecord): boolean {
  if (typeof rec.room !== 'string') return false;
  try {
    return roomSlug(rec.room) === rec.room;
  } catch {
    return false;
  }
}

// Open rooms, then the queue and the rooms that failed to leave it (`queue: false` lists open rooms only).
// With `warn`, an unreadable queue file is reported there and the other rows are still listed.
export async function listRoomRows(env: NodeJS.ProcessEnv = process.env, opts: { queue?: boolean; warn?: (w: string) => void } = {}): Promise<RoomRow[]> {
  const recs = listRooms(env).filter(isRecord);
  const rows: RoomRow[] = [];
  if (recs.length > 0) {
    await ensureServer(env);
    const workspaces = await listWorkspaces();
    for (const rec of recs) {
      const herdr = await probeRoom(rec, workspaces, env);
      const starting = herdr === 'not running' && stillStarting(rec, workspaces, env);
      if (herdr === 'not running' && !starting) markNotRunning(rec, env);
      rows.push({
        room: rec.room,
        ...(rec.project !== undefined ? { project: rec.project } : {}),
        model: typeof rec.model === 'string' ? rec.model : '-',
        herdr,
        lounge: starting ? 'starting — check its tab' : loungeColumn(rec, herdr, env),
        ...(starting ? { starting: true as const } : {}),
      });
    }
  }
  if (opts.queue === false) return rows;
  const waiting = (e: { room: string; route: { project?: unknown; model?: unknown } }) => ({
    room: e.room,
    ...(typeof e.route.project === 'string' ? { project: e.route.project } : {}),
    model: typeof e.route.model === 'string' ? e.route.model : '-',
  });
  const read = <T>(f: () => T[]): T[] => {
    if (opts.warn === undefined) return f();
    try {
      return f();
    } catch (err) {
      opts.warn((err as Error).message);
      return [];
    }
  };
  read(() => readQueue(env)).forEach((e, i) => {
    const last = e.lastError !== undefined ? `, last try failed: ${e.lastError}` : '';
    rows.push({ ...waiting(e), herdr: 'queued', lounge: `position ${i + 1}${last}` });
  });
  for (const e of read(() => readFailed(env))) {
    rows.push({ ...waiting(e), herdr: 'failed', lounge: `gave up: ${e.lastError ?? 'unknown error'} (requests ${e.requestIds.join(', ')})` });
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

// Why a close stopped before touching the tab: the room is not idle (a janitor close never cuts a turn),
// or its input box may hold text the user has not sent, which `/exit` would be typed after.
export class CloseStopped extends Error {
  constructor(
    readonly room: string,
    readonly kind: 'active' | 'input',
    readonly reason: string,
  ) {
    const next = reason === UNSENT_TEXT ? 'send or clear it in its tab' : 'check the room in its tab (or exit it there)';
    super(kind === 'active' ? `room ${room} became active` : `${room} was not closed: ${reason} — ${next}, then close it again`);
    this.name = 'CloseStopped';
  }
}

export const UNSENT_TEXT = 'unsent text in its input';
const NO_INPUT_LINE = 'could not find its input line';
const RULE = /^─{8,}$/;
const PROMPT_MARK = '❯';
// Claude Code's placeholder in an empty box, drawn dim. Only this, dim and alone, counts as empty:
// anything else dim (a pasted-text chip, a suggestion) would be sent along with `/exit`.
const PLACEHOLDER = /^Try "[^"\n]*"$/;

type Cell = { c: string; dim: boolean };

// The visible characters of one line of `pane read --format ansi`, each with whether it is dim (SGR 2).
// Truecolor parameters (38;2;r;g;b) are skipped whole, so a 2 inside a colour is never read as dim.
function cells(line: string): Cell[] {
  const out: Cell[] = [];
  let dim = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i]!;
    if (c === '\x1b') {
      const next = line[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < line.length && !/[@-~]/.test(line[j]!)) j++;
        if (line[j] === 'm') dim = sgrDim(line.slice(i + 2, j), dim);
        i = j + 1;
      } else if (next === ']') {
        const bel = line.indexOf('\x07', i);
        const st = line.indexOf('\x1b\\', i + 2);
        if (bel < 0 && st < 0) i = line.length;
        else if (st < 0 || (bel >= 0 && bel < st)) i = bel + 1;
        else i = st + 2;
      } else i += 2;
      continue;
    }
    if (c !== '\r') out.push({ c, dim });
    i++;
  }
  return out;
}

const plainOf = (cs: Cell[]): string => cs.map((x) => x.c).join('');

function sgrDim(params: string, dim: boolean): boolean {
  const ps = params === '' ? ['0'] : params.split(';');
  for (let k = 0; k < ps.length; k++) {
    const p = ps[k]!;
    if (p.includes(':')) continue;
    const n = p === '' ? 0 : Number(p);
    if (n === 0 || n === 22) dim = false;
    else if (n === 2) dim = true;
    else if (n === 38 || n === 48 || n === 58) k += ps[k + 1] === '5' ? 2 : ps[k + 1] === '2' ? 4 : 0;
  }
  return dim;
}

// What Claude Code's input box (the bottom pair of rules, starting with ❯) holds, exactly: ''
// only for nothing after the ❯ and its one separating space, or the dim placeholder alone. Spaces count.
// undefined when no such box is on screen.
export function inputText(screen: string): string | undefined {
  const lines = screen.split('\n').map(cells);
  const plain = lines.map(plainOf);
  const rules = plain.flatMap((l, i) => (RULE.test(l.trim()) ? [i] : []));
  // Only the bottom pair of rules: a rule typed inside a draft, or a mode without ❯ (bash `!`, memory `#`),
  // must never make an earlier, empty-looking pair the input box.
  if (rules.length < 2) return undefined;
  const top = rules[rules.length - 2]!;
  const bottom = rules[rules.length - 1]!;
  if (bottom - top < 2 || !plain[top + 1]!.trimStart().startsWith(PROMPT_MARK)) return undefined;
  const first = lines[top + 1]!;
  let rest = first.slice(first.findIndex((x) => x.c === PROMPT_MARK) + 1);
  if (rest[0]?.c === '\u00a0' || rest[0]?.c === ' ') rest = rest.slice(1);
  for (const l of lines.slice(top + 2, bottom)) rest = [...rest, { c: '\n', dim: false }, ...l];
  const text = plainOf(rest);
  if (text === '' || (rest.every((x) => x.dim) && PLACEHOLDER.test(text))) return '';
  return text;
}

// A reason not to /exit the room: what its input box holds, or that it could not be read (the safe side).
export async function unsentInput(paneId: string): Promise<string | undefined> {
  let screen: string;
  try {
    screen = await readPane(paneId, undefined, { ansi: true });
  } catch (err) {
    return `could not read its input: ${(err as Error).message.split('\n')[0]}`;
  }
  const typed = inputText(screen);
  if (typed === undefined) return NO_INPUT_LINE;
  return typed === '' ? undefined : UNSENT_TEXT;
}

// The herdr half of closing: /exit an idle room with an empty input, then close its tab and any restored
// copies. A janitor close never cuts a turn: only an idle room (or one already gone) is closed by it.
export async function closeRoomTab(
  rec: RoomRecord,
  env: NodeJS.ProcessEnv = process.env,
  opts: { exitTimeoutMs?: number; by?: 'janitor' | 'user' } = {},
): Promise<void> {
  await ensureServer(env);
  const workspaces = await listWorkspaces();
  const live = await probeRoom(rec, workspaces, env);
  if (opts.by === 'janitor' && live !== 'idle' && live !== 'not running') throw new CloseStopped(rec.room, 'active', 'room became active');
  if (live === 'idle') {
    const unsent = await unsentInput(rec.herdr!.paneId);
    if (unsent !== undefined) throw new CloseStopped(rec.room, 'input', unsent);
    try {
      await prompt(rec.herdr!.paneId, '/exit', { wait: false });
      await waitForExit(rec.herdr!.paneId, opts.exitTimeoutMs ?? EXIT_MS);
    } catch {
      // Closing the tab ends the session anyway.
    }
  }
  await closeRoomTabs(rec, workspaces);
}

// For a close by hand, before its minutes are written: the same input check closeRoomTab makes again.
export async function checkInput(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await ensureServer(env);
  if ((await probeRoom(rec, undefined, env)) !== 'idle') return;
  const unsent = await unsentInput(rec.herdr!.paneId);
  if (unsent !== undefined) throw new CloseStopped(rec.room, 'input', unsent);
}
