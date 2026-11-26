import { isDeepStrictEqual } from 'node:util';
import type { HookLine } from './events.js';

export type LiveState = 'coffee' | 'work' | 'smoke' | 'blocked' | 'ready' | 'whisky' | 'exit';
export type ModelKey = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'unknown';

export interface Block {
  kind: 'permission' | 'question';
  tool: string;
  detail: string;
  toolUseId?: string;
  // Set when a subagent asked: the main agent's Stop does not end a subagent's prompt.
  agentId?: string;
  questions?: { question: string; options: { label: string; description?: string }[] }[];
}

export interface RoomState {
  room: string;
  session: string;
  model: ModelKey;
  state: LiveState;
  since: number;
  updatedAt: number;
  task: string;
  steps: string[];
  block?: Block;
  subagents: { id: string; type: string; model: ModelKey }[];
  prUrl?: string;
  waitingOn?: string;
}

interface Pending {
  id: string;
  tool: string;
  input: unknown;
  agentId?: string;
}

interface Track {
  pending: Pending[];
  watchId?: string;
  // waitingOn came from `maitre status waiting`, not from a watch command.
  declaredWait?: boolean;
  finished: string[];
}

// Correlation bookkeeping rides on a symbol key: object spread keeps it, JSON.stringify drops it,
// so the state sent to the lounge stays the declared RoomState shape.
const TRACK = Symbol('room-state-track');
type Tracked = RoomState & { [TRACK]?: Track };

const MAX_PENDING = 20;
const MAX_FINISHED = 50;
const MAX_STEPS = 5;
const TASK_MAX = 120;
const DETAIL_MAX = 200;
const STEP_INPUT_MAX = 80;
const DECLARED_TOOL = 'maitre status';
const WATCH = /\bgh (pr|run) (checks|watch)\b|--watch\b/;
const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/;

export function modelKey(id: string | undefined): ModelKey {
  const m = /haiku|sonnet|opus|fable/.exec(typeof id === 'string' ? id.toLowerCase() : '');
  return m ? (m[0] as ModelKey) : 'unknown';
}

function clip(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  let t = flat.slice(0, max - 1);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t + '…';
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function field(input: unknown, key: string): string | undefined {
  return isObject(input) && typeof input[key] === 'string' ? input[key] : undefined;
}

function json(v: unknown): string {
  return typeof v === 'string' ? v : (JSON.stringify(v) ?? '');
}

function parseQuestions(input: unknown): NonNullable<Block['questions']> {
  const raw = isObject(input) && Array.isArray(input.questions) ? input.questions : [];
  const out: NonNullable<Block['questions']> = [];
  for (const q of raw) {
    if (!isObject(q) || typeof q.question !== 'string') continue;
    const options: { label: string; description?: string }[] = [];
    for (const o of Array.isArray(q.options) ? q.options : []) {
      if (!isObject(o) || typeof o.label !== 'string') continue;
      options.push(typeof o.description === 'string' ? { label: o.label, description: o.description } : { label: o.label });
    }
    out.push({ question: q.question, options });
  }
  return out;
}

function shortInput(input: unknown): string {
  const s =
    field(input, 'command') ??
    field(input, 'file_path') ??
    field(input, 'pattern') ??
    field(input, 'url') ??
    field(input, 'query') ??
    field(input, 'description') ??
    parseQuestions(input)[0]?.question ??
    json(input);
  return clip(s, STEP_INPUT_MAX);
}

function pushStep(steps: string[], step: string): string[] {
  return [...steps, step].slice(-MAX_STEPS);
}

function fresh(ev: HookLine, prev: RoomState | undefined): Tracked {
  return {
    room: ev.room,
    session: ev.session,
    model: prev?.model ?? 'unknown',
    state: 'coffee',
    since: ev.ts,
    updatedAt: ev.ts,
    task: '',
    steps: [],
    subagents: [],
    [TRACK]: { pending: [], finished: [] },
  };
}

const OPENS_SESSION = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

// 'new' starts a fresh room, 'stale' is a late event from an older session (e.g. its SessionEnd
// after /clear) and is dropped. MaitreStatus/MaitreExit come from the CLI and always apply.
function sessionOf(prev: RoomState, ev: HookLine, event: string): 'current' | 'new' | 'stale' {
  const session = str(ev.session) ?? '';
  if (event.startsWith('Maitre') || session === '' || prev.session === '' || session === prev.session) return 'current';
  return OPENS_SESSION.has(event) ? 'new' : 'stale';
}

function upsertSubagent(list: RoomState['subagents'], id: string, patch: { type?: string; model?: ModelKey }): RoomState['subagents'] {
  const old = list.find((a) => a.id === id);
  const next = { id, type: patch.type ?? old?.type ?? '', model: patch.model ?? old?.model ?? 'unknown' };
  return old ? list.map((a) => (a.id === id ? next : a)) : [...list, next];
}

export function reduce(prev: RoomState | undefined, ev: HookLine): RoomState {
  const event = str(ev.event) ?? '';
  const session = prev === undefined ? undefined : sessionOf(prev, ev, event);
  if (session === 'stale') return prev!;
  // An exited room never comes back for its own session's late lines. SessionStart only fires on a
  // real (re)start, so it reopens the room even with the same id (--resume); the other openers need a new id.
  const reopens =
    prev?.state === 'exit' &&
    (event === 'SessionStart' || (OPENS_SESSION.has(event) && (str(ev.session) ?? '') !== '' && ev.session !== prev.session));
  if (prev?.state === 'exit' && !reopens) return prev;
  const reset = prev === undefined || session === 'new' || reopens;
  const base: Tracked = reset ? fresh({ ...ev, room: str(ev.room) ?? '', session: str(ev.session) ?? '' }, prev) : (prev as Tracked);
  const s: Tracked = { ...base, room: str(ev.room) || base.room, session: base.session || (str(ev.session) ?? ''), updatedAt: ev.ts };
  const track: Track = { pending: [], finished: [], ...base[TRACK] };
  const agentId = str(ev.agent_id);
  const main = ev.agent_id === undefined;
  const id = str(ev.tool_use_id);
  const tool = str(ev.tool) ?? '';

  // Declared states (`maitre status`) belong to the room: tool events and Stop never clear them.
  const isDeclaredBlock = () => s.block?.tool === DECLARED_TOOL;
  const dropWait = () => {
    delete s.waitingOn;
    delete track.watchId;
    delete track.declaredWait;
  };
  // The main agent's turn ending clears only its own prompts, not a subagent's or a declared one.
  const dropMainBlock = () => {
    if (s.block && !isDeclaredBlock() && s.block.agentId === undefined) delete s.block;
  };
  const dropMainPending = () => {
    track.pending = track.pending.filter((p) => p.agentId !== undefined);
  };
  const dropHookWait = () => {
    if (s.waitingOn !== undefined && !track.declaredWait) dropWait();
  };
  const dropDeclared = () => {
    if (isDeclaredBlock()) delete s.block;
    if (track.declaredWait) dropWait();
  };
  const dropAll = () => {
    delete s.block;
    dropWait();
  };
  const held = (): LiveState | undefined => (s.block ? 'blocked' : s.waitingOn !== undefined ? 'smoke' : undefined);
  const active = (): LiveState => held() ?? 'work';
  const settle = (useId: string | undefined, blockClears: boolean) => {
    track.pending = track.pending.filter((p) => p.id !== useId);
    let changed = false;
    if (s.block && blockClears) {
      delete s.block;
      changed = true;
    }
    if (useId !== undefined && track.watchId === useId) {
      dropWait();
      changed = true;
    }
    return changed;
  };
  const hookBlockMatches = (useId: string | undefined) =>
    s.block !== undefined && !isDeclaredBlock() && (s.block.toolUseId === undefined || s.block.toolUseId === useId);

  switch (event) {
    case 'SessionStart':
      if (str(ev.model)) s.model = modelKey(str(ev.model));
      dropMainBlock();
      dropHookWait();
      s.state = held() ?? 'coffee';
      break;

    case 'UserPromptSubmit':
      if (!main) break;
      if (ev.synthetic === true) {
        dropMainBlock();
        dropHookWait();
      } else {
        const prompt = str(ev.prompt);
        if (s.task === '' && prompt !== undefined && prompt.trim() !== '') s.task = clip(prompt, TASK_MAX);
        dropAll();
        dropMainPending();
      }
      s.state = active();
      break;

    case 'PreToolUse': {
      if (id !== undefined) {
        const entry: Pending = agentId === undefined ? { id, tool, input: ev.input } : { id, tool, input: ev.input, agentId };
        track.pending = [...track.pending, entry].slice(-MAX_PENDING);
      }
      s.steps = pushStep(s.steps, `${tool}: ${shortInput(ev.input)}`);
      if (!main) break;
      const command = tool === 'Bash' ? field(ev.input, 'command') : undefined;
      if (command !== undefined && id !== undefined && !track.declaredWait && WATCH.test(command)) {
        s.waitingOn = clip(command, DETAIL_MAX);
        track.watchId = id;
      }
      s.state = active();
      break;
    }

    case 'PermissionRequest': {
      const match = [...track.pending].reverse().find((p) => p.tool === tool && isDeepStrictEqual(p.input, ev.input));
      const block: Block =
        tool === 'AskUserQuestion'
          ? (() => {
              const questions = parseQuestions(ev.input);
              return { kind: 'question', tool, detail: clip(questions[0]?.question ?? '', DETAIL_MAX), questions };
            })()
          : {
              kind: 'permission',
              tool,
              detail: clip(field(ev.input, 'command') ?? field(ev.input, 'file_path') ?? json(ev.input), DETAIL_MAX),
            };
      if (match) block.toolUseId = match.id;
      const asker = match ? match.agentId : agentId;
      if (asker !== undefined) block.agentId = asker;
      s.block = block;
      s.state = 'blocked';
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const cleared = settle(id, hookBlockMatches(id));
      const response = isObject(ev.response) ? ev.response : {};
      const stdout = str(response.stdout);
      const pr = tool === 'Bash' && stdout !== undefined ? PR_URL.exec(stdout) : null;
      if (pr) s.prUrl = pr[0];
      const launched = str(response.agentId);
      if (tool === 'Agent' && launched && !track.finished.includes(launched)) {
        s.subagents = upsertSubagent(s.subagents, launched, { model: modelKey(str(response.resolvedModel)) });
      }
      if (main || cleared) s.state = active();
      break;
    }

    case 'PermissionDenied':
      // Exact id only: a denial never clears a block it cannot be paired with.
      if (settle(id, s.block?.toolUseId !== undefined && s.block.toolUseId === id)) s.state = active();
      break;

    case 'Stop':
      if (!main) break;
      dropMainBlock();
      dropHookWait();
      dropMainPending();
      s.state = held() ?? (typeof ev.background_running === 'number' && ev.background_running > 0 ? 'work' : s.prUrl ? 'whisky' : 'ready');
      break;

    case 'StopFailure':
      if (!main) break;
      dropMainBlock();
      dropHookWait();
      s.state = held() ?? 'ready';
      s.steps = pushStep(s.steps, 'stopped with an error');
      break;

    case 'SubagentStart': {
      const type = str(ev.agent_type);
      if (agentId && type) s.subagents = upsertSubagent(s.subagents, agentId, { type });
      break;
    }

    case 'SubagentStop':
      if (agentId && str(ev.agent_type)) {
        const gone = agentId;
        s.subagents = s.subagents.filter((a) => a.id !== gone);
        track.finished = [...track.finished.filter((f) => f !== gone), gone].slice(-MAX_FINISHED);
        track.pending = track.pending.filter((p) => p.agentId !== gone);
        // A finished subagent cannot be waiting on its prompt any more; nothing else would clear it.
        if (s.block?.agentId === gone && !isDeclaredBlock()) {
          delete s.block;
          s.state = active();
        }
      }
      break;

    case 'MaitreStatus': {
      if (ev.status !== 'blocked' && ev.status !== 'waiting' && ev.status !== 'working') break;
      const text = str(ev.text) ?? '';
      dropDeclared();
      if (ev.status === 'blocked') {
        const raw: unknown[] = Array.isArray(ev.options) ? ev.options : [];
        const options = raw.filter((o): o is string => typeof o === 'string').map((label) => ({ label }));
        s.block = { kind: 'question', tool: DECLARED_TOOL, detail: clip(text, DETAIL_MAX), questions: [{ question: text, options }] };
      } else {
        dropWait();
        if (ev.status === 'waiting') {
          s.waitingOn = clip(text, DETAIL_MAX);
          track.declaredWait = true;
        }
      }
      s.state = active();
      break;
    }

    case 'SessionEnd':
    case 'MaitreExit':
      dropAll();
      s.state = 'exit';
      break;
  }

  s[TRACK] = track;
  s.since = !reset && prev !== undefined && prev.state === s.state ? prev.since : ev.ts;
  return s;
}
