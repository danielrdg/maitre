# maître M1 — Events, Daemon & Live Lounge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A real Claude Code session started with `maitre room run <name>` shows up live in the lounge (`maitre lounge`): working, blocked on a permission or question (with the options), ready, PR opened, its subagents at the slots — driven by Claude Code hooks, with no polling of the session.

**Architecture:** A tiny Node hook script appends one trimmed JSON line per Claude Code hook event to `$MAITRE_HOME/state/rooms/<room>/events.jsonl`. The daemon side of `maitre lounge` tails those files, folds events into per-room state with a pure reducer, and pushes snapshots/deltas to the lounge over Server-Sent Events on the existing token-gated 127.0.0.1 server (hardened per issue #1). The lounge gets a live mode that maps room state onto the existing cast/scene.

**Tech Stack:** Node ≥ 20 (tested 20.19), TypeScript 5 strict, `node:test`, plain ES modules in `lounge/`, zero runtime dependencies.

**Spec:** `docs/design.md` (§6.1 pieces, §6.4 states, §7 M1, §9 spikes). Spike evidence: raw reports + event log in `~/maitre/docs/superpowers/specs/spikes-2026-11-25/` (local only, gitignored — they contain home paths, session ids and prompts; never commit them); the public summary is `docs/spikes/2026-11-25-hooks-and-herdr.md` (written in Task 1).

**Out of M1 (later plans):** reception + router + herdr rooms + worktrees (M2), doorman/janitor/vault (M3), building/floors (M4), answering from the lounge, room chat, notifications, advisor detection via transcript (M5).

## Global Constraints

- English everywhere (code, docs, CLI output); lounge UI strings via `lounge/js/i18n.js` (en + pt-BR).
- Zero runtime dependencies; Node ≥ 20.
- Never write to `~/.claude/settings.json`, `~/.claude.json` or any user config. Hooks are registered **only** through the session flag `--settings <file>` (spike: these hooks merge with the user's global hooks; that is intended for rooms).
- `MAITRE_HOME` = env `MAITRE_HOME` or `~/.maitre`. State lives in `$MAITRE_HOME/state/`; it is personal and never in the repo.
- The hook must never break or slow a Claude session: always exit 0, no stdout, no stderr on normal paths, finish < 200 ms.
- Server binds 127.0.0.1 only; every route (static, `/api/*`) requires the session token; agent-sourced text is rendered with `textContent` only.
- Event line schema version `v: 1`; truncation limits: `input` JSON ≤ 2000 chars, `prompt` ≤ 300, `last_message` ≤ 500, `stdout` ≤ 1000.
- Interactive Claude runs started by maître (and by tests/QA) never inherit the parent session's markers: `buildRoomCommand` removes `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_ENTRYPOINT` from the child env (spike: an inherited child-session marker turns transcript saving off). Permission-mode names are those in `claude --help` (`manual`, `auto`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions`); rooms use the user's own default unless `--` passes one.
- Hook commands use the absolute Node binary (`process.execPath`), never bare `node` (Node may come from a version manager).
- Hook events registered (exact list): `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SubagentStart`, `SubagentStop`, `SessionEnd`, `PermissionDenied`.
- Commits: the repo-local identity, messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; work on branch `feat/m1-events-daemon` in worktree `~/maitre--worktrees/m1`; PR to `main` with assignee `danielrdg`, body ending with the Claude Code attribution line, `Refs #1`.

## Review Focus

1. **Hook in a hostile environment** (`MAITRE_ROOM` unset, `MAITRE_HOME` unwritable, malformed/empty stdin, 1 MB payload) → exits 0 quickly, writes nothing or one truncated line, prints nothing. → tests in Task 3.
2. **Event file mid-write / truncated / deleted / created after the daemon starts** → no crash, no duplicate or lost complete lines; partial last line is held until its newline arrives. → tests in Task 5.
3. **User denies a permission or presses Esc** (no hook fires — spike) → the room must not stay "needs you" forever: the next main-agent `UserPromptSubmit` or `Stop` clears the block (a parallel `PreToolUse` does not). → test in Task 4.
3b. **Terminal killed / Claude crashes** (no `SessionEnd`) → the room must not linger as a ghost at the table or keep ringing the bell: `room run` appends a `MaitreExit` line on any child exit, and `exit` rooms are dropped from snapshots, including after a daemon restart that replays old files. → tests in Tasks 5 and 6.
4. **Same room name reused by a new session** (`SessionStart` with a different `session_id`) → room state resets (no stale block/subagents from the old session). → test in Task 4.
5. **SSE reconnect or a long-hidden tab** → client receives a full snapshot on (re)connect and replaces its rooms; no duplicate agents. → tests in Tasks 5 and 6.

---

### Task 1: Spike findings doc + design updates

**Files:**
- Create: `docs/spikes/2026-11-25-hooks-and-herdr.md`
- Modify: `docs/design.md` (§6.4, §9)

- [ ] **Step 1:** Write `docs/spikes/2026-11-25-hooks-and-herdr.md` in English from the spike reports (the controller passes their paths). Keep: the event table (event → when → key fields), the trimmed example payloads, the herdr answer recipes (`agent send-keys <pane> <n>` selects+confirms; "Type something" = `send-keys 4` + `pane send-text` + `send-keys enter`; `agent prompt --wait`), the gotchas (denial/Esc/trust fire no hook; phantom `SubagentStop` with `agent_type:""` after every `Stop`; `Stop` with `background_tasks[status=running]`; advisor is a server tool with no hook; idle `Notification` unreliable; send keys only after `blocked` is confirmed; start the herdr server with a clean env (`env -i`); trust dialog defaults to "No, exit"), and the router cost table (baseline ≈ 50k input tokens; `--setting-sources "" --tools "" --system-prompt "<short>"` ≈ 1.1k; prompt must come before variadic flags). **No personal paths, usernames, keys or employer names.**
- [ ] **Step 1b: Auto-mode capture (the owner uses `auto`; every spike payload so far came from manual mode).** Using the spike's herdr recipe (dedicated session `maitre-m1-auto`, server started with `env -i …`, room cwd = an empty temp dir, hooks via `--settings` pointing at a logger, `--model haiku --permission-mode auto`), ask the room to do (a) a harmless allowed command (`touch a.txt`) and (b) something the classifier is likely to refuse or ask about (e.g. `rm -rf ./dummy` on a dummy folder you created, or editing a file outside the cwd). Record which hooks fire in each case (is there a `PermissionRequest`? a `PermissionDenied`? only a `PostToolUseFailure`?) and add an "Auto mode" section to the spike doc. Stop and delete the herdr session afterwards. If (b) shows a hook that Task 4's rules don't cover, report it to the controller before Task 4 starts.
- [ ] **Step 2:** Update `docs/design.md` §6.4 with the measured mapping table (from the doc) and mark §9 spikes 0–3 as resolved with a link to the doc.
- [ ] **Step 3:** `MAITRE_FORBIDDEN_WORDS="<controller provides>" npm test` → PASS (forbidden-word scan covers the new doc).
- [ ] **Step 4:** Commit `docs: record M1 spike findings (hooks, herdr, router cost)`.

### Task 2: Harden the server (issue #1, M1 part)

**Files:**
- Modify: `src/lounge-server.ts`
- Test: `test/lounge-server.test.ts`

**Interfaces:**
- Produces: `startLoungeServer(opts: { root: string; port: number; token: string; host?: '127.0.0.1'; routes?: (req, res, url: URL) => boolean | Promise<boolean> }): Promise<LoungeServer>` — `routes` is called **after** auth and host checks, before static files; returning `true` means handled. Cookie name becomes `maitre_key_<port>`.

- [ ] **Step 1: Failing tests:**
  - `rejects foreign Host` → request with `Host: evil.example:PORT` and a valid key → 403.
  - `accepts localhost and 127.0.0.1 hosts` → `Host: localhost:PORT` and `127.0.0.1:PORT` → 200.
  - `rejects cross-origin` → valid key + `Origin: http://evil.example` → 403; same-origin `Origin` → 200.
  - `port-scoped cookie` → `Set-Cookie` starts with `maitre_key_${port}=`; a cookie named `maitre_key_${port + 1}` with the right token → 403.
  - `symlink cannot escape root` → fixture root containing a symlink to the sentinel outside → 403 and body without the sentinel.
  - `literal %2e%2e probe` → `/%2e%2e/secret.txt` → 403.
  - `custom route runs after auth` → `routes` returning true for `/api/ping` → 200 with key, 403 without.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement: Host must equal `127.0.0.1:<port>` or `localhost:<port>`; `Origin`, when present, must equal `http://127.0.0.1:<port>` or `http://localhost:<port>`; `realpath` the resolved file and re-check it starts with `realpath(root) + sep`; guard the outer catch with `res.headersSent` (destroy instead); keep constant-time token compare.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `fix(server): host/origin checks, port-scoped cookie, realpath containment`.

### Task 3: Event capture — paths, hook script, hook settings

**Files:**
- Create: `src/paths.ts`, `src/events.ts`, `src/hook-settings.ts`, `hooks/maitre-hook.mjs`, `test/fixtures/hook-events.jsonl` — **hand-written** from the trimmed examples in the spike doc (one per event kind, incl. AskUserQuestion, Agent pre/post, phantom SubagentStop, Stop with a running background task, SessionEnd, plus the auto-mode case from Task 1 Step 1b), with neutral session ids, `/tmp/room` paths and generic prompts — never copied from the raw log
- Test: `test/hook.test.ts`, `test/hook-settings.test.ts`

**Interfaces:**
- Produces:
  - `maitreHome(env = process.env): string`; `roomDir(room: string, env?): string` → `$MAITRE_HOME/state/rooms/<slug>`; `roomSlug(name: string): string` (lowercase, `[a-z0-9-]`, max 40, else throws `Error('invalid room name')`).
  - Event line type (exported from `src/events.ts`, created here):
    ```ts
    export interface HookLine { v: 1; ts: number; room: string; session: string; event: string;
      agent_id?: string; agent_type?: string; tool?: string; tool_use_id?: string; input?: unknown;
      response?: { agentId?: string; resolvedModel?: string; stdout?: string; answers?: Record<string, string>; is_error?: boolean };
      notification_type?: string; message?: string; last_message?: string; background_running?: number;
      model?: string; prompt?: string; synthetic?: boolean;
      status?: 'working' | 'waiting' | 'blocked'; text?: string; options?: string[] }
    ```
  - `hooks/maitre-hook.mjs`: reads stdin, builds a `HookLine` (room = `MAITRE_ROOM`, ts = `Date.now()`, `synthetic = prompt.startsWith('<task-notification>')`, `background_running` = count of `background_tasks` with `status === 'running'`), applies the truncation limits, appends `JSON.stringify(line) + '\n'` with one `appendFileSync` to `roomDir(room)/events.jsonl` (mkdir -p). Plain ESM, no imports from `dist/`.
  - `hookSettings(hookScriptPath: string, nodePath = process.execPath): object` → `{ hooks: { <Event>: [{ hooks: [{ type: 'command', command: '"<nodePath>" "<abs path>"' }] }] } }` for exactly the 13 events in Global Constraints; `writeHookSettings(env?): string` writes it to `$MAITRE_HOME/settings/room-hooks.json` and returns the path.
- [ ] **Step 1: Failing tests:**
  - For each fixture line, piping it into the hook with `MAITRE_ROOM=t1`, `MAITRE_HOME=<tmp>` appends exactly one line whose `event`, `room`, `session`, `tool` match; AskUserQuestion keeps `input.questions[0].options` labels; `PostToolUse(Agent)` keeps `response.resolvedModel` and `response.agentId`; Stop with a running background task has `background_running: 1`; `UserPromptSubmit` with `<task-notification>` has `synthetic: true`.
  - Hostile inputs (Review Focus 1): no `MAITRE_ROOM` → exit 0, no file; empty stdin → exit 0, no file; invalid JSON → exit 0, no file; unwritable `MAITRE_HOME` (chmod 500) → exit 0; 1 MB `tool_input` → one line ≤ 5000 bytes; stdout and stderr empty in all cases; each run < 200 ms (assert wall time with a generous 500 ms ceiling in CI).
  - `hookSettings` lists exactly the 13 events, each with one command quoting the absolute path.
  - `roomSlug('Nf Bug!')` → `'nf-bug'`; `roomSlug('')` throws.
- [ ] **Step 2:** `npm test` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` → PASS.
- [ ] **Step 5:** Commit `feat(events): hook script, event lines and session-scoped hook settings`.

### Task 4: Room state reducer

**Files:**
- Create: `src/room-state.ts`
- Test: `test/room-state.test.ts`

**Interfaces:**
- Consumes: `HookLine` (Task 3), fixtures.
- Produces:
  ```ts
  export type LiveState = 'coffee' | 'work' | 'smoke' | 'blocked' | 'ready' | 'whisky' | 'exit';
  export type ModelKey = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'unknown';
  export interface Block { kind: 'permission' | 'question'; tool: string; detail: string;
    questions?: { question: string; options: { label: string; description?: string }[] }[] }
  export interface RoomState { room: string; session: string; model: ModelKey; state: LiveState;
    since: number; updatedAt: number; task: string; steps: string[]; block?: Block;
    subagents: { id: string; type: string; model: ModelKey }[]; prUrl?: string; waitingOn?: string }
  export function modelKey(id: string | undefined): ModelKey;   // /haiku|sonnet|opus|fable/ on the id
  export function reduce(prev: RoomState | undefined, ev: HookLine): RoomState;
  ```
  Rules (from the spike; `main` = event without `agent_id`). `Block` also carries `toolUseId?: string`.
  - `SessionStart` → new state `coffee`; a different `session` than `prev.session` resets everything (Review Focus 4). `model` from `ev.model`.
  - `UserPromptSubmit` (main) → `work`; first non-synthetic prompt becomes `task` (≤ 120 chars); clears `block` and `waitingOn`.
  - `PreToolUse` (main or subagent) → remembers `{tool_use_id, tool, input}` in a small pending map (last 20); main → `work` (or stays `smoke` when declared waiting); pushes step `"<tool>: <short input>"` (keep last 5); **does not clear an existing block** (parallel tool calls). Bash commands matching `/\bgh (pr|run) (checks|watch)\b|--watch\b/` set `smoke` with `waitingOn` = the command until that id's `PostToolUse`.
  - `PermissionRequest` (main **or subagent** — it has no `tool_use_id`, so match it to the most recent pending `PreToolUse` with the same `tool` and deep-equal `input` and store that id as `block.toolUseId`) → `blocked`; `tool === 'AskUserQuestion'` → `kind: 'question'` with `questions`; else `kind: 'permission'`, `detail` = `input.command ?? input.file_path ?? JSON(input)` (≤ 200).
  - The block clears on: `PostToolUse`/`PostToolUseFailure`/`PermissionDenied` with `tool_use_id === block.toolUseId` (or any of them when `toolUseId` is unknown), main `UserPromptSubmit`, main `Stop`.
  - `PostToolUse` / `PostToolUseFailure` (main) → back to `work` (unless blocked or declared waiting); Bash `stdout` matching `https://github\.com/[^\s/]+/[^\s/]+/pull/\d+` sets `prUrl`; `tool === 'Agent'` registers `{ id: response.agentId, model: modelKey(response.resolvedModel) }` (type filled by `SubagentStart`).
  - `SubagentStart` with non-empty `agent_type` → upsert subagent; `SubagentStop` with non-empty `agent_type` → remove; **`agent_type === ''` is ignored** (phantom).
  - `Stop` (main) → `background_running > 0` ? stay `work` : (`prUrl` ? `whisky` : `ready`); clears `block`.
  - `StopFailure` → `ready` with step `"stopped with an error"`.
  - `Notification` → no state change.
  - `MaitreStatus` (from `maitre status`, Task 6): `waiting` → `smoke` + `waitingOn = text`; `working` → `work`; `blocked` → `blocked` with `kind: 'question'`, `detail = text`, options from `options`.
  - `SessionEnd` or `MaitreExit` (written by `room run` when the child exits for any reason, Task 6) → `exit`.
  - Every event updates `updatedAt`; `since` changes only when `state` changes.
- [ ] **Step 1: Failing tests** — folding `test/fixtures/hook-events.jsonl` in order yields the expected states at each step (write the expected sequence explicitly), plus focused tests: phantom SubagentStop ignored; Stop with a running background task stays `work`; Bash `touch` PermissionRequest → `blocked/permission` with `detail 'touch hello.txt'`; AskUserQuestion → `blocked/question` with 3 options; denial path: `PermissionRequest` then `UserPromptSubmit` → `work` and no `block` (Review Focus 3); parallel tools: `PreToolUse(A)`, `PreToolUse(B)`, `PermissionRequest(B)`, `PostToolUse(A)` → still `blocked`, then `PostToolUse(B)` → unblocked; a subagent's `PermissionRequest` (with `agent_id`) blocks the room; `MaitreStatus waiting "CI"` → `smoke` with `waitingOn 'CI'`; `MaitreExit` → `exit`; new session id resets subagents and block (Review Focus 4); `gh pr create` stdout with a PR URL then `Stop` → `whisky`; `modelKey('claude-haiku-5-5') === 'haiku'`.
- [ ] **Step 2–4:** FAIL → implement (pure, no I/O) → PASS.
- [ ] **Step 5:** Commit `feat(state): fold hook events into lounge room state`.

### Task 5: Event tailer and live API (SSE)

**Files:**
- Create: `src/event-tail.ts`, `src/live-api.ts`
- Test: `test/event-tail.test.ts`, `test/live-api.test.ts`

**Interfaces:**
- Consumes: `startLoungeServer({ routes })` (Task 2), `reduce` (Task 4), `roomDir`/`maitreHome` (Task 3).
- Produces:
  - `class EventTail { constructor(stateDir: string, onLine: (line: HookLine) => void, opts?: { pollMs?: number /* 500 */ }); start(): void; stop(): void }` — discovers `rooms/*/events.jsonl` (new rooms included), reads only new bytes per file (offset map), buffers a partial last line until `\n`, skips unparsable lines, resets its offset if a file shrinks or is replaced (inode change), tolerates deleted files. `fs.watch` with a polling fallback.
  - `class LiveRooms { apply(line: HookLine): RoomState; snapshot(): RoomState[]; on(fn: (room: RoomState) => void): () => void }` — `snapshot()` omits rooms in state `exit`; a room's `exit` transition is still emitted once as a `room` event so the lounge can walk it out.
  - `liveRoutes(rooms: LiveRooms): (req, res, url) => boolean` handling `GET /api/state` (JSON `{ rooms: RoomState[] }`) and `GET /api/events` (SSE: first an `event: snapshot` with all rooms, then `event: room` per change, `: ping` every 15 s; cleans up listeners on close).
- [ ] **Step 1: Failing tests:**
  - Tail: append two lines → 2 callbacks; write half a line → 0, finish it → 1 (Review Focus 2); truncate the file and write a new line → it is delivered once, nothing replayed twice; a room dir created after `start()` is picked up within 1 s; deleting a file doesn't throw.
  - Live API (server on port 0, fixture events): `/api/state` without key → 403; with key → rooms after the fixture is applied; `/api/events` sends `snapshot` first, then a `room` event after appending a line; a second connection gets a full snapshot (Review Focus 5); closing the client removes its listener (listener count back to 0); a room whose file ends with `MaitreExit` or `SessionEnd` is absent from the snapshot after a fresh daemon start that replays the files (Review Focus 3b).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(daemon): tail room events and stream state over SSE`.

### Task 6: CLI — `room run`, `status`, live `lounge`

**Files:**
- Modify: `src/cli.ts`
- Create: `src/room-run.ts`, `src/status.ts`
- Test: `test/cli.test.ts`, `test/room-run.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `maitre room run <name> [-- <extra claude args>]`: writes hook settings (`writeHookSettings`), then spawns `claude --settings <path> --append-system-prompt <ROOM_PROMPT> ...extra` with `stdio: 'inherit'`, env `MAITRE_ROOM=<slug>`, `MAITRE_HOME`, `PATH` prefixed with the repo's `bin/` (so `maitre status` works inside the room) and the session markers from Global Constraints removed; forwards SIGINT/SIGTERM; on child exit (any code or signal) appends a `MaitreExit` line to the room file, then exits with Claude's code. Implemented as `buildRoomCommand(name: string, extra: string[], env): { cmd: 'claude'; args: string[]; env: NodeJS.ProcessEnv }` + a thin spawner. `ROOM_PROMPT` (exact): "You are running inside a maître room. When you start waiting on something outside your control (CI, a build, a review bot), run `maitre status waiting \"<what>\"`. When you resume, run `maitre status working \"<what>\"`."
  - `maitre status <working|waiting|blocked> "<text>" [--option <o>]...`: requires `MAITRE_ROOM`; appends a `HookLine` with `event: 'MaitreStatus'`, `status`, `text`, `options` to the room's file; exits 1 with a one-line error outside a room.
  - `maitre lounge` (no `--demo`): starts `EventTail` + `LiveRooms` + `liveRoutes` on the lounge server, prints the URL, opens the app window; `--demo` unchanged. Update `HELP`.
- [ ] **Step 1: Failing tests:** `buildRoomCommand('Nf Bug', ['--model','haiku'], env)` → args start with `['--settings', <path>, '--append-system-prompt', ROOM_PROMPT]`, include `--model haiku`, env has `MAITRE_ROOM=nf-bug`, `PATH` starts with the repo `bin/`, and none of the five session-marker variables survive even if present in the input env; the spawner with a fake `claude` (a tiny script on PATH that exits 3, and one killed by SIGTERM) appends exactly one `MaitreExit` line and exits 3 / non-zero; `maitre status waiting "CI"` with `MAITRE_ROOM=t1` writes a `MaitreStatus` line; without `MAITRE_ROOM` exits 1 with a message; `parseArgs` handles `room run`, `status`, and keeps `lounge --demo`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(cli): room run, status, and live lounge mode`.

### Task 7: Lounge live mode

**Files:**
- Create: `lounge/js/live.js`
- Modify: `lounge/js/main.js`, `lounge/js/sim.js` (the simulation loop lives here since M0), `lounge/js/panel.js`, `lounge/js/i18n.js` — `--demo` and capture mode must behave exactly as before: `npm run assets` must leave the tree byte-identical
- Test: `test/lounge/live.test.mjs`

**Interfaces:**
- Consumes: SSE `/api/events` (Task 5), existing `moveTo`/`takeSpot`/cast, panel.
- Produces:
  - `roomToAgents(room): { main: AgentSpec; subagents: AgentSpec[] }` (pure) where `AgentSpec = { id, label, model, state, info }`; `state` uses the lounge `STATE_KEYS` (`coffee`, `work`, `smoke`, `blocked`, `ready`, `whisky`, `exit`; subagents → `slot`); `info` feeds the panel (`task`, `steps`, `where: room`, `block` → options rendered read-only with the note "answer in the room's terminal" — answering is M5).
  - `class LiveSource { constructor(url, onSnapshot, onRoom); start(); stop() }` (EventSource wrapper, reconnects; a snapshot **replaces** the live cast).
  - `main.js`: when not `?demo=1`, use `LiveSource`; agents are added/moved/removed via existing `moveTo` (new rooms walk in from the door; `exit` walks out); the bell rings on transition into `blocked` (existing `DingScheduler`); an empty lounge shows a small hint "No rooms yet — run `maitre room run <name>`" (i18n).
- [ ] **Step 1: Failing tests:** `roomToAgents` maps every `LiveState`; subagents become `slot` agents labeled `<room> ↳ <type>` with their model color key; a `blocked/question` room yields panel options without any HTML; a snapshot with rooms `[a,b]` after `[a,c]` removes `c` and adds `b` (pure diff helper `diffRooms(prevIds, nextIds) → { add, remove, keep }`).
- [ ] **Step 2–4:** FAIL → implement → PASS. Manual: `npm run build && node bin/maitre lounge` with a fixture replay script feeding events → agents appear, block shows options, ding plays.
- [ ] **Step 5:** Commit `feat(lounge): live mode driven by room events`.

### Task 8: End-to-end check, docs, PR

- [ ] **Step 1:** Add `scripts/replay-events.mjs <fixture> [--room name] [--delay ms]` that pipes fixture payloads through the real hook into `$MAITRE_HOME` (for demos and manual QA). Test: replaying the fixture into a temp home and reading `/api/state` yields the final expected state.
- [ ] **Step 2:** Real run (cheap, no TTY needed): reuse the spike's herdr recipe — a dedicated herdr session `maitre-m1-e2e` whose server is started with `env -i HOME=… PATH=… TERM=xterm-256color …`, a workspace with cwd = an empty temp dir, `pane run` → `node <repo>/bin/maitre room run e2e -- --model haiku --permission-mode auto`; drive it with `herdr agent prompt --wait` (a `touch x`, an AskUserQuestion answered with `agent send-keys <pane> 2` only after `blocked` is confirmed, a small subagent), while `maitre lounge --no-open` runs and `GET /api/state` is polled; then `/exit` and confirm the room leaves the snapshot. Stop and delete the herdr session. Record the observed states in the PR body. Never touch user config.
- [ ] **Step 3:** README: "Watch a real room" in Quick start (`maitre lounge` + `maitre room run <name>`), roadmap M1 checked, `maitre status` documented; `docs/design.md` §7 M1 marked done.
- [ ] **Step 4:** `npm ci && npm test` clean; forbidden-word scan with the owner's identifiers passes.
- [ ] **Step 5:** Fresh most-capable reviewer on the whole branch (find defects; inputs: repo path, `docs/design.md`, this plan). Fix in one wave, scoped re-review, squash the branch into one commit on `main`'s tip, push, `gh pr create --base main --assignee danielrdg` (body: what M1 ships, how to try, `Refs #1`, attribution line). Merge only on the owner's word.
