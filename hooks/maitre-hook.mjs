// Claude Code hook for maître rooms: reads one hook payload on stdin and appends one
// trimmed JSON line to $MAITRE_HOME/state/rooms/<room>/events.jsonl.
// It must never break or slow the session: always exit 0, print nothing, no network,
// one synchronous append. Plain ESM with no imports from dist/ (startup time).
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Per-field caps: `chars` is the documented limit, `bytes` bounds the field once serialized
// (JSON escapes and UTF-8 included). The byte caps sum to well under 5000 bytes per line.
const CAP = {
  input: { chars: 2000, bytes: 2000 },
  prompt: { chars: 300, bytes: 400 },
  last_message: { chars: 500, bytes: 600 },
  message: { chars: 500, bytes: 250 },
  answers: { bytes: 300 },
  tool: { chars: 96, bytes: 96 },
  id: { chars: 48, bytes: 48 },
};
const MAX_DEPTH = 8;
const ELLIPSIS = '…';
// Prompts Claude Code injects itself (a background task or subagent reporting back), not the user's.
const SYNTHETIC = /^(?:<task-notification>|<agent-message[\s>])/;
const PR_URL = /https:\/\/github\.com\/[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}\/pull\/\d{1,10}(?!\d)/;

// Same rule as roomSlug() in src/paths.ts.
function slug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

function size(v) {
  return Buffer.byteLength(JSON.stringify(v));
}

function head(s, max) {
  if (s.length <= max) return s;
  let t = s.slice(0, max - 1);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t + ELLIPSIS;
}

function clip(s, cap) {
  let t = head(s, cap.chars);
  while (size(t) > cap.bytes) {
    const n = Math.min(t.length - 1, Math.floor((t.length * cap.bytes) / size(t)));
    t = head(s, Math.max(n, 1));
  }
  return t;
}

function str(v, cap) {
  return typeof v === 'string' ? clip(v, cap) : undefined;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function shrink(v, strMax, itemMax, depth) {
  if (typeof v === 'string') return head(v, strMax);
  if (v === null || typeof v !== 'object') return v;
  if (depth >= MAX_DEPTH) return ELLIPSIS;
  if (Array.isArray(v)) return v.slice(0, itemMax).map((x) => shrink(x, strMax, itemMax, depth + 1));
  const out = {};
  for (const k of Object.keys(v).slice(0, itemMax)) out[head(k, strMax)] = shrink(v[k], strMax, itemMax, depth + 1);
  return out;
}

const PASSES = [[500, 50], [200, 20], [80, 10], [30, 5], [10, 3]];

// Keeps the value's shape (the room reducer reads input.command, input.file_path and the question
// options) and depends only on the value, so a PreToolUse and its PermissionRequest stay deep-equal.
function fit(v, bytes) {
  if (v === undefined || size(v) <= bytes) return v;
  for (const [strMax, itemMax] of PASSES) {
    const w = shrink(v, strMax, itemMax, 0);
    if (size(w) <= bytes) return w;
  }
  return undefined;
}

function fitInput(v) {
  const w = fit(v, CAP.input.bytes);
  if (w !== undefined || v === undefined) return w;
  return clip(JSON.stringify(v), CAP.input);
}

function answers(v) {
  if (!isObject(v)) return undefined;
  const out = {};
  for (const k of Object.keys(v)) if (typeof v[k] === 'string') out[k] = v[k];
  return fit(out, CAP.answers.bytes);
}

function response(p) {
  const tr = p.tool_response;
  const r = {};
  if (isObject(tr)) {
    r.agentId = str(tr.agentId, CAP.id);
    r.resolvedModel = str(tr.resolvedModel, CAP.id);
    // Only the PR URL leaves the session: arbitrary command output may hold secrets.
    if (typeof tr.stdout === 'string') r.stdout = PR_URL.exec(tr.stdout)?.[0];
    r.answers = answers(tr.answers);
    if (typeof tr.is_error === 'boolean') r.is_error = tr.is_error;
  }
  if (p.hook_event_name === 'PostToolUseFailure') r.is_error = true;
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k];
  return Object.keys(r).length > 0 ? r : undefined;
}

function buildLine(p, room) {
  const prompt = typeof p.prompt === 'string' ? p.prompt : undefined;
  const tasks = Array.isArray(p.background_tasks) ? p.background_tasks : undefined;
  return {
    v: 1,
    ts: Date.now(),
    room,
    session: str(p.session_id, CAP.id) ?? '',
    event: clip(p.hook_event_name, CAP.id),
    agent_id: str(p.agent_id, CAP.id),
    agent_type: str(p.agent_type, CAP.id),
    tool: str(p.tool_name, CAP.tool),
    tool_use_id: str(p.tool_use_id, CAP.id),
    input: fitInput(p.tool_input),
    response: response(p),
    notification_type: str(p.notification_type, CAP.id),
    message: str(p.message, CAP.message),
    last_message: str(p.last_assistant_message, CAP.last_message),
    background_running: tasks && tasks.filter((t) => isObject(t) && t.type === 'subagent' && t.status === 'running').length,
    model: str(p.model, CAP.id),
    prompt: prompt === undefined ? undefined : clip(prompt, CAP.prompt),
    synthetic: prompt === undefined ? undefined : SYNTHETIC.test(prompt.trimStart()),
  };
}

try {
  // Drain stdin first, even when nothing is logged, so Claude Code never writes into a closed pipe.
  const raw = readFileSync(0, 'utf8');
  const room = slug(process.env.MAITRE_ROOM ?? '');
  const envHome = process.env.MAITRE_HOME;
  // A relative MAITRE_HOME would resolve against the session cwd, i.e. the user's project.
  if (room !== '' && (!envHome || isAbsolute(envHome))) {
    const p = raw.trim() === '' ? undefined : JSON.parse(raw);
    if (isObject(p) && typeof p.hook_event_name === 'string' && p.hook_event_name !== '') {
      const line = JSON.stringify(buildLine(p, room)) + '\n';
      const dir = join(envHome || join(homedir(), '.maitre'), 'state', 'rooms', room);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      appendFileSync(join(dir, 'events.jsonl'), line, { mode: 0o600 });
    }
  }
} catch {
  // Never surface an error to Claude Code.
}
process.exitCode = 0;
