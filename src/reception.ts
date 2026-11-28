import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJsonAtomic } from './config.js';
import { cleanEnv } from './env.js';
import {
  HerdrError,
  agentInfo,
  closeWorkspace,
  createLabeledWorkspace,
  ensureServer,
  focusWorkspace,
  herdrSession,
  listPanes,
  listWorkspaces,
  readPane,
  runInPane,
  shellQuote,
} from './herdr.js';
import { writeReceptionSettings } from './hook-settings.js';
import { liveLounge, type LoungeInfo } from './lounge-file.js';
import { openWindow, ticketUrl, uiLang } from './open-app.js';
import { maitreHome } from './paths.js';
import { closeLabeledTabs, closeRoomTabs, isRecord, liveness, markNotRunning, probeRoom, roomLabel } from './room-open.js';
import { runForeground } from './room-run.js';
import { stillStarting } from './wake.js';
import { isOpening } from './queue.js';
import { listRooms, readRoom } from './rooms.js';
import { handleTrust, type TrustResult } from './trust.js';

export const RECEPTION_LABEL = 'reception';
export const LOUNGE_LABEL = 'lounge';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN_DIR = join(ROOT, 'bin');
const MAITRE_BIN = join(BIN_DIR, 'maitre');
const PROMPT_FILE = join(ROOT, 'reception', 'PROMPT.md');
const DEFAULT_MODEL = 'sonnet';
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const LOUNGE_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}\/\?key=[0-9a-f]{64}$/;
const LOUNGE_WAIT_MS = 10_000;
const POLL_MS = 100;
export const SERVICE_NOTE = 'lounge: run maitre open or use the maître icon';

type Workspaces = { id: string; label: string }[];
interface Tab {
  workspaceId: string;
  paneId: string;
}
interface Tabs {
  session: string;
  reception?: Tab;
  lounge?: Tab & { url?: string; loungePid?: number };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function receptionDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = join(maitreHome(env), 'reception');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

// Production always runs Sonnet; MAITRE_RECEPTION_MODEL exists for cheap smoke runs.
function receptionModel(env: NodeJS.ProcessEnv): string {
  const model = env.MAITRE_RECEPTION_MODEL || DEFAULT_MODEL;
  if (!MODEL.test(model)) throw new Error(`invalid model ${JSON.stringify(model)} in MAITRE_RECEPTION_MODEL`);
  return model;
}

export interface ReceptionCommand {
  cmd: 'claude';
  args: string[];
  env: NodeJS.ProcessEnv;
}

export function buildReceptionCommand(env: NodeJS.ProcessEnv = process.env): ReceptionCommand {
  const home = maitreHome(env);
  const model = receptionModel(env);
  const settings = writeReceptionSettings({ ...env, MAITRE_HOME: home });
  receptionDir({ ...env, MAITRE_HOME: home });
  const out: NodeJS.ProcessEnv = { ...cleanEnv(env), MAITRE_HOME: home };
  out.PATH = env.PATH ? `${BIN_DIR}${delimiter}${env.PATH}` : BIN_DIR;
  const args = [
    '--model', model,
    '--setting-sources', '',
    '--tools', 'Bash',
    '--permission-mode', 'auto',
    '--settings', settings,
    '--append-system-prompt', readFileSync(PROMPT_FILE, 'utf8'),
  ];
  return { cmd: 'claude', args, env: out };
}

export function runReception(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { cmd, args, env: childEnv } = buildReceptionCommand(env);
  return runForeground(cmd, args, { env: childEnv, cwd: receptionDir(childEnv) });
}

export function attach(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return runForeground('herdr', ['--session', herdrSession(env)], { env });
}

const tabsFile = (env: NodeJS.ProcessEnv) => join(maitreHome(env), 'reception', 'tabs.json');
// Written by the reception's SessionStart hook (hooks/reception-request.mjs).
const startedMarker = (env: NodeJS.ProcessEnv) => join(maitreHome(env), 'reception', 'session-started');

const isTab = (t: unknown): t is Tab =>
  typeof t === 'object' && t !== null && typeof (t as Tab).workspaceId === 'string' && typeof (t as Tab).paneId === 'string';

function readTabs(env: NodeJS.ProcessEnv): Tabs {
  const session = herdrSession(env);
  let raw: unknown;
  try {
    raw = readJson(tabsFile(env));
  } catch {
    return { session };
  }
  const t = raw as Partial<Tabs> | undefined;
  if (t?.session !== session) return { session };
  const out: Tabs = { session };
  if (isTab(t.reception)) out.reception = { workspaceId: t.reception.workspaceId, paneId: t.reception.paneId };
  if (isTab(t.lounge)) {
    out.lounge = { workspaceId: t.lounge.workspaceId, paneId: t.lounge.paneId };
    if (typeof t.lounge.url === 'string') out.lounge.url = t.lounge.url;
    if (Number.isInteger(t.lounge.loungePid) && t.lounge.loungePid! > 0) out.lounge.loungePid = t.lounge.loungePid;
  }
  return out;
}

// Any tab labelled `reception` with a live Claude counts; tabs.json only says which one to try first.
async function liveReception(tabs: Tabs, workspaces: Workspaces): Promise<Tab | undefined> {
  const recorded = tabs.reception?.workspaceId;
  const labelled = workspaces.filter((w) => w.label === RECEPTION_LABEL).sort((a, b) => Number(b.id === recorded) - Number(a.id === recorded));
  for (const w of labelled) {
    let panes: string[];
    try {
      panes = await listPanes(w.id);
    } catch (e) {
      if (e instanceof HerdrError && e.code === 'workspace_not_found') continue;
      throw e;
    }
    for (const paneId of panes) if (liveness(await agentInfo(paneId)) !== 'not running') return { workspaceId: w.id, paneId };
  }
  return undefined;
}

// The URL line can wrap in a narrow pane, and the URL itself never holds whitespace.
export function parseLoungeUrl(screen: string): string | undefined {
  const m = /maitre lounge: ([\s\S]*?)Press Ctrl\+C/.exec(screen);
  const url = m?.[1]?.replace(/\s+/g, '');
  return url !== undefined && LOUNGE_URL.test(url) ? url : undefined;
}

async function openTab(opts: { cwd: string; label: string; env: Record<string, string>; command: string[] }): Promise<Tab> {
  const ws = await createLabeledWorkspace({ cwd: opts.cwd, label: opts.label, env: opts.env });
  try {
    await runInPane(ws.paneId, opts.command.map(shellQuote).join(' '));
  } catch (err) {
    await closeWorkspace(ws.workspaceId).catch(() => {});
    throw err;
  }
  return ws;
}

async function waitForUrl(paneId: string, ms: number, pollMs: number): Promise<string | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const url = parseLoungeUrl(await readPane(paneId));
    if (url !== undefined || Date.now() >= deadline) return url;
    await sleep(pollMs);
  }
}

// Every room in the registry is probed, closed or not: herdr may have restored its tab as a bare shell.
// A room being opened or woken is left alone: its new tab is not on its record yet.
async function sweepRooms(env: NodeJS.ProcessEnv, warnings: string[]): Promise<string[]> {
  // The records before the tabs: a record that changed since (a wake that ended meanwhile) may name a tab
  // newer than the list, which is then taken again.
  const listedRooms = listRooms(env).filter(isRecord);
  let workspaces = await listWorkspaces();
  const closed: string[] = [];
  for (const listed of listedRooms) {
    try {
      // The reservation first, then the record: an opener writes the new ids before it lets go.
      if (isOpening(listed.room, env)) continue;
      const rec = readRoom(listed.room, env);
      if (rec === undefined || !isRecord(rec)) continue;
      if (rec.herdr?.workspaceId !== listed.herdr?.workspaceId) workspaces = await listWorkspaces();
      if ((await probeRoom(rec, workspaces, env)) !== 'not running' || stillStarting(rec, workspaces, env)) continue;
      const hadTab = workspaces.some((w) => w.label === roomLabel(rec));
      await closeRoomTabs(rec, workspaces);
      if (hadTab || rec.closedAt === undefined) closed.push(rec.room);
      markNotRunning(rec, env);
    } catch (err) {
      warnings.push(`could not check room ${listed.room}: ${(err as Error).message}`);
    }
  }
  return closed;
}

// Only the tab whose own lounge claimed lounge.json is kept; ports cannot tell it apart, since every lounge starts at 8737.
async function keepLiveLounge(running: LoungeInfo, tabs: Tabs, workspaces: Workspaces, result: StartResult): Promise<void> {
  const rec = tabs.lounge;
  const owner = rec?.loungePid === running.pid && workspaces.some((w) => w.id === rec.workspaceId && w.label === LOUNGE_LABEL) ? rec.workspaceId : undefined;
  await closeLabeledTabs(LOUNGE_LABEL, workspaces, owner);
  if (owner === undefined) {
    delete tabs.lounge;
    result.notes.push(SERVICE_NOTE);
  }
}

async function openStartedLounge(tabs: Tabs, env: NodeJS.ProcessEnv, result: StartResult, open?: (url: string) => void): Promise<void> {
  const tab = tabs.lounge!;
  const info = await liveLounge(env);
  if (info === undefined || info.port !== Number(new URL(tab.url!).port)) {
    result.warnings.push('the lounge is not answering yet; open it later with: maitre open');
    return;
  }
  tab.loungePid = info.pid;
  try {
    const ticketed = await ticketUrl(info, '/', uiLang(env));
    (open ?? ((u: string) => void openWindow('lounge', u, env)))(ticketed);
  } catch (err) {
    result.warnings.push(`could not open the lounge window (${(err as Error).message}); open it with: maitre open`);
  }
}

export interface StartResult {
  created: ('reception' | 'lounge')[];
  url?: string;
  trust?: TrustResult;
  closedRooms: string[];
  notes: string[];
  warnings: string[];
}

export async function startMaitre(
  env: NodeJS.ProcessEnv = process.env,
  opts: { open?: (url: string) => void; trustTimeoutMs?: number; pollMs?: number; loungeWaitMs?: number } = {},
): Promise<StartResult> {
  const home = maitreHome(env);
  const session = herdrSession(env);
  const model = env.MAITRE_RECEPTION_MODEL ? receptionModel(env) : undefined;
  const dir = receptionDir(env);
  const result: StartResult = { created: [], closedRooms: [], notes: [], warnings: [] };
  const tabEnv = { MAITRE_HOME: home, MAITRE_HERDR_SESSION: session };

  await ensureServer(env);
  const tabs = readTabs(env);
  const workspaces = await listWorkspaces();
  const save = () => writeJsonAtomic(tabsFile(env), tabs);

  let reception = await liveReception(tabs, workspaces);
  await closeLabeledTabs(RECEPTION_LABEL, workspaces, reception?.workspaceId);
  if (reception !== undefined && (tabs.reception?.workspaceId !== reception.workspaceId || tabs.reception.paneId !== reception.paneId)) {
    tabs.reception = reception;
    save();
  }
  if (reception === undefined) {
    rmSync(startedMarker(env), { force: true });
    reception = await openTab({
      cwd: dir,
      label: RECEPTION_LABEL,
      env: { ...tabEnv, ...(model !== undefined ? { MAITRE_RECEPTION_MODEL: model } : {}) },
      command: [MAITRE_BIN, 'reception'],
    });
    tabs.reception = reception;
    save();
    result.created.push('reception');
  }

  const running = await liveLounge(env);
  if (running !== undefined) {
    await keepLiveLounge(running, tabs, workspaces, result);
    save();
  } else {
    await closeLabeledTabs(LOUNGE_LABEL, workspaces);
    const tab = await openTab({ cwd: home, label: LOUNGE_LABEL, env: tabEnv, command: [MAITRE_BIN, 'lounge', '--no-open'] });
    tabs.lounge = tab;
    save();
    result.created.push('lounge');
    const url = await waitForUrl(tab.paneId, opts.loungeWaitMs ?? LOUNGE_WAIT_MS, opts.pollMs ?? POLL_MS);
    if (url === undefined) {
      result.warnings.push('the lounge did not show its URL yet; see its tab');
    } else {
      tabs.lounge = { ...tab, url };
      result.url = url;
      await openStartedLounge(tabs, env, result, opts.open);
      save();
    }
  }

  if (result.created.includes('reception')) {
    result.trust = await handleTrust(reception.paneId, dir, {
      timeoutMs: opts.trustTimeoutMs,
      pollMs: opts.pollMs,
      env,
      started: () => existsSync(startedMarker(env)),
    });
    if (result.trust === 'no-agent') {
      throw new Error(`the reception did not start: no Claude appeared in its tab (is \`claude\` on PATH?); see it with: herdr --session ${session}`);
    }
    if (result.trust === 'unresolved') result.warnings.push('the reception is still starting — check its tab');
  }
  try {
    await focusWorkspace(reception.workspaceId);
  } catch {
    // Only cosmetic: herdr opens on another tab.
  }
  result.closedRooms = await sweepRooms(env, result.warnings);
  return result;
}
