#!/usr/bin/env node
// Test double for the herdr CLI. Appends one JSON line of argv to $FAKE_HERDR_LOG.
// Per-subcommand overrides: FAKE_HERDR_REPLY_<cmd>_<sub> (the output), FAKE_HERDR_EXIT_<cmd>_<sub> (exit code).
// Like herdr 0.8.2, a failure prints on stderr (FAKE_HERDR_ERRORS_ON_STDOUT=1 puts it on stdout).
// `server` records its env to $FAKE_HERDR_LOG.serverenv and flips status to running (state file $FAKE_HERDR_LOG.running).
// With $FAKE_HERDR_STATE set, workspaces, panes and agents live in that JSON file instead (see stateful()).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
// Claude Code's input box with nothing typed, as `pane read` shows it: ❯ and a no-break space between two rules.
const RULE = '─'.repeat(40);
const EMPTY_INPUT = `${RULE}\n❯\u00a0\n${RULE}\n  ⏵⏵ auto mode on (shift+tab to cycle)\n`;

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

// FAKE_HERDR_HANG_<cmd>_<sub>=1: that subcommand never answers.
if (process.env[`FAKE_HERDR_HANG_${key}`] === '1') await new Promise(() => setInterval(() => {}, 1 << 30));

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
  // FAKE_HERDR_THEN_<key>='["from","to"]': once that subcommand ran, renames from to to (once: from is gone).
  const then = process.env[`FAKE_HERDR_THEN_${key}`];
  if (then) {
    const [from, to] = JSON.parse(then);
    if (existsSync(from)) renameSync(from, to);
  }
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

// The session id after `--resume` in a pane command (single-quoted tokens), if any.
function resumeId(cmd) {
  return tokenAfter(cmd, '--resume');
}

function tokenAfter(cmd, flag) {
  const tokens = cmd.match(/'(?:[^']|'\\'')*'/g) ?? [];
  const i = tokens.indexOf(`'${flag}'`);
  return i >= 0 && tokens[i + 1] !== undefined ? tokens[i + 1].slice(1, -1) : undefined;
}

// `claude --resume <id>` as the resume spike saw it. FAKE_HERDR_RESUME picks the outcome: 'ok' (default:
// SessionStart with the same id, source resume), 'missing' (Claude shows for one look, prints
// "No conversation found", exits; a lone SessionEnd with that id), 'picker' (the session picker, idle,
// no SessionStart), 'hang' (idle, nothing), 'trust' (the folder-trust dialog first), 'question'
// (blocked on something that is not the trust dialog), 'other' (idle, a SessionStart with another id),
// 'shell' (no Claude ever appears). With no SessionStart (a test writes it): 'late-shell', 'late-blocked'
// (the trust dialog), 'late-picker', each idle from the second `agent get` on. With a SessionStart:
// 'slow' (unknown for two `agent get`s, then idle), 'start-unregistered' (herdr answers agent_not_found
// for two `agent get`s, then idle), 'start-exit' (seen once, then exits),
// 'start-unknown' (herdr never sees it), 'start-blocked' (a question). 'flap': idle with no SessionStart (a test
// writes it), and herdr misses the agent for one look, the second. 'delayed': no agent until
// $FAKE_HERDR_APPEAR_MS have passed (a slow start), then idle with its SessionStart. 'ended': the room's
// command ends before Claude starts (a bare shell, and `maitre room run`'s MaitreExit line).
// 'missing-unseen': "No conversation found" on screen before herdr ever saw Claude.
function resume(p, id, wenv) {
  const mode = process.env.FAKE_HERDR_RESUME ?? 'ok';
  p.resume = id;
  if (mode === 'missing') {
    p.agent = 'unknown';
    p.exitAfter = 1;
    p.screen = `No conversation found with session ID: ${id}\n$ \n`;
    if (wenv.MAITRE_ROOM) runHook('maitre-hook.mjs', { hook_event_name: 'SessionEnd', session_id: id, reason: 'other' }, wenv);
  } else if (mode === 'picker') {
    p.agent = 'idle';
    p.screen = ' Resume session\n\n ⌕ Search…\n\n ❯ an earlier session\n';
  } else if (mode === 'hang') {
    p.agent = 'idle';
  } else if (mode === 'delayed') {
    p.agent = 'shell';
    p.appearAt = Date.now() + Number(process.env.FAKE_HERDR_APPEAR_MS ?? 8000);
  } else if (mode === 'ended') {
    p.agent = 'shell';
    if (wenv.MAITRE_ROOM && wenv.MAITRE_HOME) {
      const run = tokenAfter(p.ran.at(-1) ?? '', '--run');
      const line = { v: 1, ts: Date.now(), room: wenv.MAITRE_ROOM, session: '', event: 'MaitreExit', ...(run !== undefined ? { run } : {}) };
      appendFileSync(join(wenv.MAITRE_HOME, 'state', 'rooms', wenv.MAITRE_ROOM, 'events.jsonl'), JSON.stringify(line) + '\n');
    }
  } else if (mode === 'missing-unseen') {
    p.agent = 'shell';
    p.screen = `No conversation found with session ID: ${id}\n$ \n`;
  } else if (mode === 'flap') {
    p.agent = 'idle';
    p.missAfter = 1;
  } else if (mode === 'trust') {
    p.agent = 'blocked';
    p.trust = true;
  } else if (mode === 'question') {
    p.agent = 'blocked';
    p.screen = ' Resume from summary?\n ❯ 1. Yes\n   2. No\n';
  } else if (mode === 'other') {
    p.agent = 'idle';
    p.resume = 'another-session';
    sessionStart(p, wenv);
  } else if (mode === 'shell') {
    p.agent = 'shell';
  } else if (mode === 'late-shell') {
    p.agent = 'shell';
    p.idleAfter = 1;
  } else if (mode === 'late-blocked') {
    p.agent = 'blocked';
    p.trust = true;
    p.idleAfter = 1;
  } else if (mode === 'late-picker') {
    p.agent = 'idle';
    p.screen = ' Resume session\n\n ⌕ Search…\n';
    p.idleAfter = 1;
  } else if (mode.startsWith('start-') || mode === 'slow') {
    p.agent = mode === 'start-blocked' ? 'blocked' : mode === 'start-unregistered' ? 'shell' : 'unknown';
    if (mode === 'slow' || mode === 'start-unregistered') p.idleAfter = 2;
    if (mode === 'start-exit') p.exitAfter = 1;
    if (mode === 'start-blocked') p.screen = ' Resume from summary?\n ❯ 1. Yes\n   2. No\n';
    sessionStart(p, wenv);
  } else {
    p.agent = 'idle';
    sessionStart(p, wenv);
  }
}

// State: { next, workspaces: { <id>: { label, cwd, env } }, panes: { <id>: { ws, agent, trust?, screen?, ran? } } }.
// agent is 'shell' (bare shell, no agent) or an agent_status. FAKE_HERDR_FAIL_<key>=<code> fails that
// subcommand without touching the state; any call fails while the file $FAKE_HERDR_FAIL_WHILE exists. FAKE_HERDR_ON_RUN sets what `pane run` starts: 'idle' (default),
// 'trust' (blocked on the folder-trust dialog; FAKE_HERDR_TRUST_STICKY=1 ignores the keys) or 'shell' (nothing).
// `pane read` shows a pane's `screen` when set, else the trust dialog, a shell prompt or an empty input box.
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
  const resumed = p.resume !== undefined;
  const payload = { hook_event_name: 'SessionStart', session_id: resumed ? p.resume : 's1', source: resumed ? 'resume' : 'startup', model: 'claude-sonnet-5' };
  if (wenv.MAITRE_ROOM) runHook('maitre-hook.mjs', payload, wenv);
  else if ((p.ran ?? []).at(-1)?.includes("'reception'")) runHook('reception-request.mjs', payload, wenv);
}

function stateful(file) {
  const st = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { next: 1, workspaces: {}, panes: {} };
  const save = () => writeFileSync(file, JSON.stringify(st));
  const fail = (c, message = c) => ({ out: JSON.stringify({ error: { code: c, message } }), code: 1 });
  const injected = process.env[`FAKE_HERDR_FAIL_${key}`];
  if (injected) return fail(injected, `fake-herdr: injected ${injected}`);
  // FAKE_HERDR_FAIL_AFTER_<key>=<n>: that subcommand works n times, then fails (counted in the state).
  const after = process.env[`FAKE_HERDR_FAIL_AFTER_${key}`];
  if (after !== undefined) {
    st.counts = st.counts ?? {};
    st.counts[key] = (st.counts[key] ?? 0) + 1;
    save();
    if (st.counts[key] > Number(after)) return fail('injected_after', `fake-herdr: ${key} fails after ${after}`);
  }
  const watched = process.env.FAKE_HERDR_FAIL_WHILE;
  if (watched && existsSync(watched)) return fail('called_while_locked', `fake-herdr: called while ${watched} exists`);
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
      } else if (resumeId(rest[3]) !== undefined) {
        resume(p, resumeId(rest[3]), st.workspaces[p.ws].env ?? {});
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
        : p.agent === 'shell' ? '$ \n' : EMPTY_INPUT;
      return { out: screen, code: 0 };
    }
    case 'agent_get': {
      const p = st.panes[id];
      // A Claude that settles on its own: idle after `idleAfter` more looks (its screen and dialog gone).
      if (p && p.idleAfter !== undefined) {
        if (p.idleAfter <= 0) {
          p.agent = 'idle';
          p.trust = false;
          delete p.screen;
          delete p.idleAfter;
        } else p.idleAfter--;
        save();
      }
      // A Claude that exits on its own: seen `exitAfter` more times, then a bare shell.
      if (p && p.exitAfter !== undefined) {
        if (p.exitAfter <= 0) {
          p.agent = 'shell';
          delete p.exitAfter;
        } else p.exitAfter--;
        save();
      }
      // A slow start: no agent until appearAt, then a Claude that fires its SessionStart.
      if (p && p.appearAt !== undefined && Date.now() >= p.appearAt) {
        delete p.appearAt;
        p.agent = 'idle';
        sessionStart(p, st.workspaces[p.ws].env ?? {});
        save();
      }
      // A Claude herdr misses for one look after `missAfter` looks.
      if (p && p.missAfter !== undefined) {
        const miss = p.missAfter <= 0;
        if (miss) delete p.missAfter;
        else p.missAfter--;
        save();
        if (miss) return fail('agent_not_found');
      }
      if (!p || p.agent === 'shell') return fail('agent_not_found');
      return { out: ok('agent:get', { type: 'agent_info', agent: agentJson(id) }), code: 0 };
    }
    case 'agent_send_keys': {
      const p = st.panes[id];
      if (!p) return fail('pane_not_found');
      if (p.agent === 'shell') return fail('agent_not_found');
      const keys = rest.slice(3);
      if (p.typed !== undefined && keys.join(' ') === 'enter' && process.env.FAKE_HERDR_PROMPT_HOOK === 'typed') {
        runHook('maitre-hook.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: p.typed }, st.workspaces[p.ws].env ?? {});
        delete p.typed;
        delete p.screen;
      }
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
      const hook = process.env.FAKE_HERDR_PROMPT_HOOK;
      if (text === '/exit') p.agent = 'shell';
      else if (hook === 'typed' || hook === 'typed-stuck') {
        // Typed but not submitted: the text sits in the input box; Enter submits it ('typed' only).
        p.typed = text;
        p.screen = `${RULE}\n❯\u00a0${text}\n${RULE}\n`;
      } else if (hook !== '0') {
        runHook('maitre-hook.mjs', { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: process.env.FAKE_HERDR_PASTE === '1' ? `\n\n<pasted_content id="7">\n${text}\n</pasted_content id="7">\n` : text }, st.workspaces[p.ws].env ?? {});
      }
      save();
      return { out: ok('agent:prompt', { type: 'agent_prompted', agent: agentJson(id) }), code: 0 };
    }
    default:
      return fail('unknown_command', `fake-herdr: ${key}`);
  }
}
