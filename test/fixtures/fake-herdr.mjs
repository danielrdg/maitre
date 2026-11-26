#!/usr/bin/env node
// Test double for the herdr CLI. Appends one JSON line of argv to $FAKE_HERDR_LOG.
// Per-subcommand overrides: FAKE_HERDR_REPLY_<cmd>_<sub> (the output), FAKE_HERDR_EXIT_<cmd>_<sub> (exit code).
// Like herdr 0.8.2, a failure prints on stderr (FAKE_HERDR_ERRORS_ON_STDOUT=1 puts it on stdout).
// `server` records its env to $FAKE_HERDR_LOG.serverenv and flips status to running (state file $FAKE_HERDR_LOG.running).
// With $FAKE_HERDR_STATE set, workspaces, panes and agents live in that JSON file instead (see stateful()).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const log = process.env.FAKE_HERDR_LOG;
if (log) appendFileSync(log, JSON.stringify(argv) + '\n');

const rest = argv[0] === '--session' ? argv.slice(2) : argv;
const key = rest.slice(0, 2).join('_').replace(/-/g, '_');

const ws = { active_tab_id: 'w1:t1', agent_status: 'unknown', focused: true, label: 'probe', number: 1, pane_count: 1, tab_count: 1, workspace_id: 'w1' };
const pane = { agent_status: 'unknown', cwd: '/tmp', focused: true, pane_id: 'w1:p1', tab_id: 'w1:t1', terminal_id: 'term_1', workspace_id: 'w1' };
const agent = { agent: 'claude', agent_status: 'idle', pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', terminal_id: 'term_1', focused: true, revision: 0 };
const ok = (id, result) => JSON.stringify({ id: `cli:${id}`, result });

const canned = {
  status_server: () => JSON.stringify({ status: 'running', running: true, version: '0.8.2', protocol: 20, compatible: true, session: 'fake' }),
  workspace_create: () => ok('workspace:create', { type: 'workspace_created', root_pane: pane, tab: { tab_id: 'w1:t1', workspace_id: 'w1' }, workspace: ws }),
  workspace_list: () => ok('workspace:list', { type: 'workspace_list', workspaces: [ws] }),
  workspace_close: () => ok('workspace:close', { type: 'workspace_closed', workspace_id: 'w1' }),
  agent_get: () => ok('agent:get', { type: 'agent_info', agent }),
  agent_prompt: () => ok('agent:prompt', { type: 'agent_prompted', agent }),
  agent_send_keys: () => ok('agent:send-keys', { type: 'ok' }),
  pane_get: () => ok('pane:get', { type: 'pane_info', pane }),
  pane_run: () => '',
  pane_read: () => '$ echo hi\nhi\n$\n',
};

// A bare `herdr --session <s>` is the attaching client.
if (rest.length === 0) process.exit(Number(process.env.FAKE_HERDR_ATTACH_EXIT ?? 0));

if (rest[0] === 'server') {
  if (log) {
    writeFileSync(`${log}.serverenv`, JSON.stringify(process.env));
    writeFileSync(`${log}.running`, '1');
  }
  process.exit(0);
}

if (process.env.FAKE_HERDR_STATE) {
  const r = stateful(process.env.FAKE_HERDR_STATE);
  // herdr 0.8.2 prints its error JSON on stderr and exits 1.
  if (r.code === 0) process.stdout.write(r.out);
  else process.stderr.write(r.out);
  process.exit(r.code);
}

let out;
let code = 0;
const override = process.env[`FAKE_HERDR_REPLY_${key}`];
if (key === 'status_server' && log && process.env.FAKE_HERDR_SERVER_DOWN === '1' && !existsSync(`${log}.running`)) {
  out = JSON.stringify({ status: 'stopped', running: false });
  code = 1;
} else if (override !== undefined) {
  out = override;
} else if (canned[key]) {
  out = canned[key]();
} else {
  out = JSON.stringify({ error: { code: 'unknown_command', message: `fake-herdr: ${key}` } });
  code = 1;
}
code = Number(process.env[`FAKE_HERDR_EXIT_${key}`] ?? code);
if (code !== 0 && process.env.FAKE_HERDR_ERRORS_ON_STDOUT !== '1') process.stderr.write(out);
else process.stdout.write(out);
process.exit(code);

// State: { next, workspaces: { <id>: { label, cwd, env } }, panes: { <id>: { ws, agent, trust?, screen?, ran? } } }.
// agent is 'shell' (bare shell, no agent) or an agent_status. FAKE_HERDR_FAIL_<key>=<code> fails that
// subcommand without touching the state. FAKE_HERDR_ON_RUN sets what `pane run` starts: 'idle' (default),
// 'trust' (blocked on the folder-trust dialog; FAKE_HERDR_TRUST_STICKY=1 ignores the keys) or 'shell' (nothing).
// A started Claude (on run, or once the trust keys are accepted) fires its SessionStart hook: the room
// hook for a room tab, the reception hook for the reception, unless FAKE_HERDR_SESSION_START=0.
// A `lounge` command instead leaves a bare shell showing the lounge's URL line ($FAKE_HERDR_LOUNGE_URL,
// cut every $FAKE_HERDR_WRAP columns when set) and, when $FAKE_HERDR_LOUNGE_INFO is set, claims the
// tab's $MAITRE_HOME/lounge.json with it. `agent prompt` runs the real room hook
// with a UserPromptSubmit payload unless FAKE_HERDR_PROMPT_HOOK=0.
function runHook(script, payload, wenv) {
  execFileSync(process.execPath, [fileURLToPath(new URL(`../../hooks/${script}`, import.meta.url))], {
    input: JSON.stringify(payload),
    env: { ...process.env, MAITRE_ROOM: wenv.MAITRE_ROOM ?? '', MAITRE_HOME: wenv.MAITRE_HOME ?? '' },
  });
}

function sessionStart(p, wenv) {
  if (process.env.FAKE_HERDR_SESSION_START === '0') return;
  const payload = { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', model: 'claude-sonnet-5' };
  if (wenv.MAITRE_ROOM) runHook('maitre-hook.mjs', payload, wenv);
  else if ((p.ran ?? []).at(-1)?.includes("'reception'")) runHook('reception-request.mjs', payload, wenv);
}

function stateful(file) {
  const st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { next: 1, workspaces: {}, panes: {} };
  const save = () => writeFileSync(file, JSON.stringify(st));
  const fail = (c, message = c) => ({ out: JSON.stringify({ error: { code: c, message } }), code: 1 });
  const injected = process.env[`FAKE_HERDR_FAIL_${key}`];
  if (injected) return fail(injected, `fake-herdr: injected ${injected}`);
  const wsJson = (id) => ({ ...ws, workspace_id: id, label: st.workspaces[id].label });
  const paneJson = (id) => ({ ...pane, pane_id: id, workspace_id: st.panes[id].ws, tab_id: `${st.panes[id].ws}:t1` });
  const agentJson = (id) => ({ ...agent, pane_id: id, workspace_id: st.panes[id].ws, agent_status: st.panes[id].agent });
  const id = rest[2];
  switch (key) {
    case 'status_server':
      return { out: canned.status_server(), code: 0 };
    case 'workspace_create': {
      const n = st.next++;
      const wid = `w${n}`;
      const pid = `${wid}:p1`;
      const env = {};
      let label = '';
      let cwd = '';
      for (let i = 2; i < rest.length; i++) {
        if (rest[i] === '--label') label = rest[++i];
        else if (rest[i] === '--cwd') cwd = rest[++i];
        else if (rest[i] === '--env') {
          const kv = rest[++i];
          env[kv.slice(0, kv.indexOf('='))] = kv.slice(kv.indexOf('=') + 1);
        }
      }
      st.workspaces[wid] = { label, cwd, env };
      st.panes[pid] = { ws: wid, agent: 'shell' };
      save();
      return { out: ok('workspace:create', { type: 'workspace_created', root_pane: paneJson(pid), tab: { tab_id: `${wid}:t1`, workspace_id: wid }, workspace: wsJson(wid) }), code: 0 };
    }
    case 'workspace_list':
      return { out: ok('workspace:list', { type: 'workspace_list', workspaces: Object.keys(st.workspaces).map(wsJson) }), code: 0 };
    case 'workspace_close': {
      if (!st.workspaces[id]) return fail('workspace_not_found');
      delete st.workspaces[id];
      for (const p of Object.keys(st.panes)) if (st.panes[p].ws === id) delete st.panes[p];
      save();
      return { out: ok('workspace:close', { type: 'workspace_closed', workspace_id: id }), code: 0 };
    }
    case 'workspace_focus':
      return st.workspaces[id] ? { out: ok('workspace:focus', { type: 'ok' }), code: 0 } : fail('workspace_not_found');
    case 'pane_list': {
      const w = rest[rest.indexOf('--workspace') + 1];
      if (rest.includes('--workspace') && !st.workspaces[w]) return fail('workspace_not_found');
      const panes = Object.keys(st.panes).filter((pid) => !rest.includes('--workspace') || st.panes[pid].ws === w).map(paneJson);
      return { out: ok('pane:list', { type: 'pane_list', panes }), code: 0 };
    }
    case 'pane_get':
      return st.panes[id] ? { out: ok('pane:get', { type: 'pane_info', pane: paneJson(id) }), code: 0 } : fail('pane_not_found');
    case 'pane_run': {
      const p = st.panes[id];
      if (!p) return fail('pane_not_found');
      p.ran = [...(p.ran ?? []), rest[3]];
      const on = process.env.FAKE_HERDR_ON_RUN ?? 'idle';
      if (rest[3].includes("'lounge'")) {
        const url = process.env.FAKE_HERDR_LOUNGE_URL ?? `http://127.0.0.1:8737/?key=${'a'.repeat(64)}`;
        const line = `maitre lounge: ${url}`;
        const wrap = Number(process.env.FAKE_HERDR_WRAP ?? 0);
        const shown = wrap > 0 ? line.match(new RegExp(`.{1,${wrap}}`, 'g')).join('\n') : line;
        p.agent = 'shell';
        p.screen = `$ ${rest[3]}\n${shown}\nPress Ctrl+C to stop.\n`;
        const info = process.env.FAKE_HERDR_LOUNGE_INFO;
        const home = st.workspaces[p.ws].env?.MAITRE_HOME;
        if (info && home) writeFileSync(join(home, 'lounge.json'), info, { mode: 0o600 });
      } else if (on === 'trust') {
        p.agent = 'blocked';
        p.trust = true;
      } else if (on !== 'shell') {
        p.agent = on;
        sessionStart(p, st.workspaces[p.ws].env ?? {});
      }
      save();
      return { out: '', code: 0 };
    }
    case 'pane_read': {
      const p = st.panes[id];
      if (!p) return fail('pane_not_found');
      const screen = p.screen !== undefined ? p.screen : p.trust
        ? ' Accessing workspace:\n\n /x\n\n Is this a project you created or one you trust?\n\n ❯ 1. No, exit\n   2. Yes, I trust this folder\n'
        : p.agent === 'shell' ? '$ \n' : ' > \n';
      return { out: screen, code: 0 };
    }
    case 'agent_get': {
      const p = st.panes[id];
      if (!p || p.agent === 'shell') return fail('agent_not_found');
      return { out: ok('agent:get', { type: 'agent_info', agent: agentJson(id) }), code: 0 };
    }
    case 'agent_send_keys': {
      const p = st.panes[id];
      if (!p) return fail('pane_not_found');
      if (p.agent === 'shell') return fail('agent_not_found');
      const keys = rest.slice(3);
      if (p.trust && process.env.FAKE_HERDR_TRUST_STICKY !== '1') {
        p.trust = false;
        p.agent = keys.join(' ') === 'down enter' ? 'idle' : 'shell';
        if (p.agent === 'idle') sessionStart(p, st.workspaces[p.ws].env ?? {});
      }
      save();
      return { out: ok('agent:send-keys', { type: 'ok' }), code: 0 };
    }
    case 'agent_prompt': {
      const p = st.panes[id];
      if (!p || p.agent === 'shell') return fail('agent_not_found');
      if (p.agent === 'blocked') return fail('agent_blocked');
      const text = rest[3];
      if (text === '/exit') p.agent = 'shell';
      else if (process.env.FAKE_HERDR_PROMPT_HOOK !== '0') {
        runHook('maitre-hook.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: process.env.FAKE_HERDR_PASTE === '1' ? `\n\n<pasted_content id="7">\n${text}\n</pasted_content id="7">\n` : text }, st.workspaces[p.ws].env ?? {});
      }
      save();
      return { out: ok('agent:prompt', { type: 'agent_prompted', agent: agentJson(id) }), code: 0 };
    }
    default:
      return fail('unknown_command', `fake-herdr: ${key}`);
  }
}
