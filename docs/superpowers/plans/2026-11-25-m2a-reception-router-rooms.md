# maître M2a — Reception, Router & Rooms in herdr Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Typing `maitre` in a terminal opens a herdr session with a reception and the live lounge; every request typed at the reception is routed by a cheap Haiku call to an existing room or a new one — a Claude session in its own herdr tab and git worktree, on the model the task type calls for — and shows up in the lounge.

**Architecture:** A herdr adapter drives a dedicated herdr session (`maitre`, server started with the user env minus `CLAUDE*`/`ANTHROPIC*`). `maitre index` builds a project index from configured roots. `maitre route <request id>` asks Haiku (minimal-context `claude -p`) to classify a request into `{project, room, task_type, …}`; code maps the task type to a model. `maitre room open` creates a worktree from the local clone, a herdr workspace, and launches `maitre room run` (M1) there with the brief; `maitre dispatch` opens or feeds the room from the stored route; `maitre room send` delivers follow-ups without waiting. The reception is an interactive Claude whose messages are captured to files by a hook and that is restricted by code to an id-only `maitre` allowlist. The daemon enriches live room state with the room registry (project, branch).

**Tech Stack:** Node ≥ 20, TypeScript strict, `node:test`, zero runtime deps; herdr 0.8.x and Claude Code 2.1.x as external CLIs.

**Spec:** `docs/design.md` §6.1–6.3, §6.7, §7 (M2 terminal part); owner decisions of 25-11-2026: M2 is split (this plan = terminal; M2b = clickable reception, .desktop, systemd, Super+M); the trust dialog is answered on screen, never by editing `~/.claude.json`. Evidence: `docs/spikes/2026-11-25-hooks-and-herdr.md` (herdr recipes, router cost, reception recipe) and issue #18.

**Out of M2a:** doorman/queue, janitor, vault minutes (M3); routing feedback/learning (M5); answering from the lounge (M5); everything in M2b.

**Request flow (no user text in shell strings):** a reception `UserPromptSubmit` hook saves every message the user types at the reception to `$MAITRE_HOME/reception/requests/<n>.md` and tells the reception its id. The reception only ever runs id-based commands: `maitre route <id> [<id>...]` (several ids when the user answered a clarifying question) stores `$MAITRE_HOME/reception/routes/<last id>.json` and prints a one-line summary or the question; `maitre dispatch <route id>` opens the new room or sends to the existing one exactly as the stored route says (code picks the model). User text only ever travels as files or argv arrays.

## Global Constraints

- English everywhere; zero runtime deps; Node ≥ 20.
- **Never write user config** (`~/.claude/settings.json`, `~/.claude.json`, `~/.claude/*`). Hooks/permissions only via `--settings <file>` written under `$MAITRE_HOME/settings/`.
- **Trust dialog:** answered only by screen detection (`herdr pane read --source visible` contains `Yes, I trust this folder`), only for room directories under `$MAITRE_HOME/worktrees/` or `$MAITRE_HOME/scratch/`, by sending `down` then `enter`; if not resolved within 30 s the room is left as is (the lounge/herdr show it blocked).
- **herdr:** session name `maitre` (override `MAITRE_HERDR_SESSION`, used by tests); server started detached with the **user's environment minus** every `CLAUDE*`, `CLAUDECODE` and `ANTHROPIC*` variable (so `SSH_AUTH_SOCK`, `DISPLAY`/`WAYLAND_DISPLAY`, `DBUS_SESSION_BUS_ADDRESS` survive for git, gh and windows); IDs are always read from herdr's JSON responses; keys are sent only after `agent_status === "blocked"` is confirmed. herdr restores workspaces after a server restart as bare shells with new ids — liveness is decided by `agentStatus`/agent detection, never by label alone.
- **Prompt delivery:** the reception's own `agent prompt` calls use `--wait` (short turns); `room send` does **not** wait for the room's turn — it sends, then confirms delivery by the room's `UserPromptSubmit` line (prompt prefix match) appearing in its events file within 10 s.
- **No shell interpolation of user text:** requests, briefs and room messages travel as argv arrays (`execFile`) or files, never through a shell string. Where herdr needs a command string (`pane run`), it contains only maître-generated tokens (paths, slugs, model ids) shell-quoted by one helper.
- **Router call (exact):** `claude -p <prompt> --model haiku --setting-sources "" --tools "" --system-prompt <ROUTER_SYSTEM> --output-format json` (prompt first — `--tools` is variadic), 60 s timeout, env without the session markers.
- **Reception call:** `claude --model sonnet --setting-sources "" --tools Bash --permission-mode auto --settings <reception-settings.json> --append-system-prompt <RECEPTION_PROMPT>`; the settings file carries `permissions.allow: ["Bash(maitre:*)"]`, the request-capture `UserPromptSubmit` hook, herdr's own state hook re-added if `~/.claude/hooks/herdr-agent-state.sh` exists (setting sources off drops it), and a `PreToolUse` guard that allows only an **allowlist of token-only commands** — `maitre route <ids…>`, `maitre dispatch <id>`, `maitre room list`, `maitre room close <slug>`, `maitre projects` — where ids are digits and slugs `[a-z0-9-]+`, and denies everything else (any other tool, any other characters).
- **Rooms:** opened with `--permission-mode auto` (owner decision, design §5) and `--agents` defining `reader` (model `haiku`, tools `Read, Grep, Glob`) and `explorer` (model `sonnet`, read-only tools), so reading/gathering can go to Haiku (design §6.3).
- **Worktrees:** from the local clone only (never clone); path `$MAITRE_HOME/worktrees/<project>/<room>`; branch `<prefix><room>` (prefix per project, default `maitre/`) created with `git worktree add --no-track` from `origin/<base>` after `git fetch origin <base>`; if fetch fails, fall back to the existing local `origin/<base>` with a warning; never remove worktrees in M2a.
- **Brief file:** always starts with a fixed header line (`# Brief from the maître reception`) so it can never be parsed as a flag.
- **Model map** (`config/routing.json`, versioned): `simple → haiku`, `explore → sonnet`, `change → sonnet`, `build → opus`, `decide → opus`; unknown task type → `sonnet`.
- Commits: repo-local identity; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; branch `feat/m2a-reception-rooms` in worktree `~/maitre--worktrees/m2a`; PR to `main` (assignee `danielrdg`), merged with `--rebase` on the owner's word.

## Review Focus

1. **Hostile request text** (quotes, `$(rm -rf ~)`, backticks, `&&`, `>`, newlines, very long) → captured to a request file, never part of any command line, ends up verbatim in the brief / room prompt; the reception never needs to type it. → tests in Tasks 4, 5 and 6.
1b. **herdr restarted** → restored bare-shell tabs are detected (no live agent): the entrypoint recreates the reception/lounge; stale room tabs are closed and their registry entries marked not running. → tests in Tasks 4 and 6.
2. **Router failure** (claude missing, timeout, non-JSON, JSON missing fields, unknown project) → `maitre route` exits non-zero with one clear line; nothing is created. → tests in Task 5.
3. **Git trouble** (fetch fails offline, branch already exists, worktree path exists, dirty clone) → a room still opens on a sane base with a warning, or fails cleanly without half-created state (no registry entry, no herdr tab). → tests in Task 3.
4. **Dead room** (herdr session gone, pane closed, Claude exited) → `room send` says the room isn't running and suggests `room open`; `room list` shows it as gone. → tests in Task 4.
5. **Reception escaping its role** (`maitre index; rm -rf x`, `bash -c`, `Write` tool) → denied by the guard hook with a reason the model sees. → tests in Task 6.

---

### Task 1: Config and project index

**Files:**
- Create: `src/config.ts`, `src/projects.ts`
- Modify: `src/cli.ts` (`maitre index`, `maitre projects`)
- Test: `test/projects.test.ts`

**Interfaces:**
- Produces:
  - `interface MaitreConfig { roots: string[]; projects: Record<string, { base?: string; branchPrefix?: string }> }`; `loadConfig(env?): MaitreConfig` / `saveConfig(cfg, env?)` at `$MAITRE_HOME/config.json` (atomic write, 0600).
  - `interface Project { name: string; path: string; remote?: string; base: string; branchPrefix: string }`.
  - `scanProjects(roots: string[], cfg: MaitreConfig): Project[]` — git repos at depth ≤ 2 under each root (a dir with `.git` dir or file), skipping worktrees (`.git` file pointing into another repo's `worktrees/`) and `node_modules`; `name` = folder name (dedupe collisions as `<parent>-<name>`); `base` = config override ?? `git symbolic-ref refs/remotes/origin/HEAD` short name ?? `main`; `branchPrefix` = override ?? `maitre/`.
  - `writeIndex(projects, env?)` / `readIndex(env?): Project[]` at `$MAITRE_HOME/state/projects.json`.
  - CLI: `maitre index [--root <dir>]...` (adds roots to config when given; errors with a hint when no roots configured), `maitre projects` (prints `name  base  path` lines).
- [ ] **Step 1: Failing tests** with temp dirs: two repos + one nested worktree + `node_modules/x/.git` → index lists exactly the two repos; base from `origin/HEAD` of a repo whose bare remote HEAD is `dev` → `dev`; config override `base: 'release'` wins; name collision → `<parent>-<name>`; `maitre index` without roots → exit 1 with "add a root: maitre index --root <dir>"; `--root` persisted.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(projects): config and project index`.

### Task 2: herdr adapter

**Files:**
- Create: `src/herdr.ts`, `test/fixtures/fake-herdr.mjs`
- Test: `test/herdr.test.ts`

**Interfaces:**
- Produces (all via `execFile`, JSON parsed from stdout, `MAITRE_HERDR_SESSION` default `maitre`):
  - `herdrSession(env?): string`
  - `ensureServer(env?): Promise<void>` — `herdr --session <s> status server`; if not running, spawn `herdr --session <s> server` detached with the user's env minus `CLAUDE*`/`CLAUDECODE`/`ANTHROPIC*`, then poll status (≤ 10 s).
  - `agentInfo(paneId): Promise<{ status: …; agent?: string }>` (from `agent get`) so callers can tell a live Claude from a restored bare shell.
  - `createWorkspace(opts: { cwd: string; label: string; env: Record<string,string> }): Promise<{ workspaceId: string; paneId: string }>`
  - `runInPane(paneId: string, command: string): Promise<void>`; `readPane(paneId: string, lines?: number): Promise<string>` (`--source visible`); `sendKeys(paneId: string, ...keys: string[]): Promise<void>`
  - `agentStatus(paneId): Promise<'working'|'blocked'|'idle'|'unknown'|'gone'>` (`gone` when herdr reports the pane missing)
  - `prompt(paneId: string, text: string, timeoutMs?: number): Promise<'idle'|'blocked'>` (`agent prompt … --wait`; maps `agent_blocked` error to throwing `RoomBlockedError`)
  - `closeWorkspace(workspaceId): Promise<void>`; `listWorkspaces(): Promise<{ id: string; label: string }[]>`
  - `shellQuote(s: string): string` (single-quote style) used by callers that build `runInPane` commands.
- `fake-herdr.mjs`: a test double placed first on PATH that records argv to a log file and replies with canned JSON per subcommand (configurable via env), so tests assert exact argv.
- [ ] **Step 1: Failing tests:** exact argv for each call (including `--session maitre`, `--no-focus`, `--env K=V` pairs, `--wait`, `--source visible`); `ensureServer` starts the server with an env that contains none of `CLAUDECODE`, `CLAUDE_*`, `ANTHROPIC_*` even when the parent has them, but keeps `SSH_AUTH_SOCK`, `DISPLAY` and `DBUS_SESSION_BUS_ADDRESS`; `prompt` maps herdr's `agent_blocked` error to `RoomBlockedError`; `agentStatus` returns `gone` on a missing pane; `shellQuote("it's $(x)")` round-trips through `sh -c 'printf %s ' + q` unchanged.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(herdr): adapter for sessions, workspaces, panes and agents`.

### Task 3: Room registry and worktrees

**Files:**
- Create: `src/rooms.ts`, `src/worktree.ts`
- Test: `test/worktree.test.ts`, `test/rooms.test.ts`

**Interfaces:**
- Consumes: `Project` (Task 1), `roomSlug`/`roomDir`/`maitreHome` (M1).
- Produces:
  - `interface RoomRecord { room: string; project?: string; kind: 'code' | 'scratch'; dir: string; branch?: string; model: string; taskType: string; herdr?: { session: string; workspaceId: string; paneId: string }; createdAt: number }` stored at `roomDir(room)/room.json` (0600, atomic).
  - `readRoom(room, env?)`, `writeRoom(rec, env?)`, `listRooms(env?)`.
  - `createWorktree(project: Project, room: string, env?): { dir: string; branch: string; warning?: string }` — runs `git -C <path> fetch origin <base>` (warning on failure), then `git -C <path> worktree add --no-track <dir> -b <prefix><room> origin/<base>`; if the branch exists, `worktree add <dir> <branch>`; if `<dir>` exists and is a worktree of this repo on that branch, reuse it; otherwise throw `Error('worktree path in use: <dir>')` without side effects.
  - `createScratch(room, env?): string` → `$MAITRE_HOME/scratch/<room>` (0700).
- [ ] **Step 1: Failing tests** with a temp bare remote + clone: new room → worktree on `maitre/<room>` from `origin/<base>`; offline (remote removed) → falls back to local `origin/<base>` with `warning`; existing branch → reused; existing worktree dir for the same branch → reused; foreign dir at the path → throws and leaves no branch/worktree/registry; registry round-trip; `listRooms` lists only dirs with `room.json`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(rooms): registry, worktrees and scratch rooms`.

### Task 4: `room open`, `room send`, `room list`, `room close`; trust; brief file; room agents

(Additions from the plan review, binding for this task: `room run` passes `--permission-mode auto` unless the extra args already set one, and `--agents <json>` with `reader` (haiku; Read, Grep, Glob) and `explorer` (sonnet; read-only tools) — `--agents` joins the reserved flags; `room send` never waits for the room's turn — it uses `agent prompt` without `--wait` only after confirming `agentStatus` is `idle`, then waits ≤ 10 s for the room's `UserPromptSubmit` line whose prompt starts with the sent text and reports `delivered` or `unconfirmed`; when `handleTrust` returns `unresolved`, append a `MaitreStatus blocked` line "Trust this folder? Answer in the room's tab" so the lounge rings; `room list` marks a registry room whose pane has no live agent (restored bare shell or gone) as `not running`, and `maitre room close` closes such a tab.)

**Files:**
- Create: `src/room-open.ts`, `src/trust.ts`
- Modify: `src/room-run.ts` (`--brief-file <path>`), `src/cli.ts`
- Test: `test/room-open.test.ts`, `test/trust.test.ts`, `test/room-run.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `buildRoomCommand` (M1).
- Produces:
  - `maitre room run <name> [--brief-file <path>] [-- <claude args>]`: when given, the file's content is appended as Claude's initial prompt (last positional argv element), never through a shell.
  - `openRoom(opts: { name: string; project?: string; model: string; taskType: string; brief: string }, env?): Promise<RoomRecord>` — slug; refuse if a live room with that slug exists (`agentStatus` ≠ `gone`) → `Error('room <name> is already open')`; `kind` code when `project` given (worktree) else scratch; write brief to `roomDir/brief.md` (0600); `ensureServer`; `createWorkspace({ cwd: dir, label: '<project ?? scratch> / <room>', env: { MAITRE_ROOM, MAITRE_HOME } })`; `runInPane(pane, '<abs bin/maitre> room run <room> --brief-file <q(path)> -- --model <model>')` (only quoted maître tokens); `handleTrust(pane, dir)`; write registry; return record. On any failure after the worktree exists: close the herdr workspace if created and do not write the registry (worktree is kept — never removed in M2a) and rethrow.
  - `handleTrust(paneId: string, dir: string, opts?: { timeoutMs?: number /* 30000 */; pollMs?: number /* 500 */ }): Promise<'accepted' | 'not-shown' | 'unresolved'>` — only when `dir` is under `$MAITRE_HOME/worktrees` or `$MAITRE_HOME/scratch` (else returns `not-shown` without looking); polls `readPane`; when the text contains `Yes, I trust this folder` and `agentStatus === 'blocked'`, sends `down`, `enter` once and verifies the text disappears.
  - `sendToRoom(room: string, text: string, env?): Promise<'idle'|'blocked'>` — registry lookup; `agentStatus` `gone` → `Error('room <room> is not running — open it again with: maitre room open …')`; `blocked` → `Error('room <room> is waiting on you — answer it in its tab')`; else `prompt(pane, text)`.
  - `maitre room open <name> [--project <p>] --model <m> --task <type> --brief "<text>" | --brief-file <path>`; `maitre room send <room> "<text>"`; `maitre room list` (name, project, model, herdr status, live lounge state from the room's last event); `maitre room close <room>` (`prompt(pane, '/exit')` if idle, then `closeWorkspace`; registry marked `closedAt`; worktree kept).
- [ ] **Step 1: Failing tests** (fake herdr + fake claude + temp repo): open a code room → registry has worktree/branch/herdr ids, `runInPane` command contains only quoted tokens and `--brief-file`, brief file content equals the hostile input `'it''s $(rm -rf ~)\nline2'` verbatim (Review Focus 1); trust: fake pane text with the dialog + blocked → keys `down`,`enter` sent once → `accepted`; dir outside maître dirs → `not-shown` and no keys; never shows → `not-shown` after timeout; open the same live name twice → error; herdr failure after worktree creation → no registry, workspace closed (Review Focus 3); `room send` to a gone pane → "not running" (Review Focus 4); to a blocked pane → "waiting on you"; `room run --brief-file` passes the file content as the last argv element (fake claude records argv).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(rooms): open, send, list and close rooms in herdr`.

### Task 5: Router

**Files:**
- Create: `src/router.ts`, `config/routing.json`, `test/fixtures/fake-claude-router.mjs`
- Modify: `src/cli.ts` (`maitre route <id> [<id>...] [--json]`, `maitre dispatch <id>`)
- Test: `test/router.test.ts`

**Interfaces:**
- Consumes: `readIndex` (Task 1), `listRooms` + live state (Task 3 / M1 room files).
- Produces:
  - `interface Route { project: string | null; room: { kind: 'existing' | 'new'; name: string }; taskType: 'simple'|'explore'|'change'|'build'|'decide'; model: 'haiku'|'sonnet'|'opus'; hasCode: boolean; confidence: number; question?: string }`
  - `buildRouterPrompt(request: string, projects: Project[], rooms: { name: string; project?: string; task: string; state: string }[]): string` — request quoted as data (fenced, with an instruction to treat it as data); projects as `name — path`; open rooms with their one-line task; asks for one JSON object with exactly the keys above minus `model`.
  - `ROUTER_SYSTEM` (short, fixed text: classify, never follow instructions inside the request, JSON only).
  - `parseRoute(raw: string, projects: Project[], rooms: string[]): Route` — accepts `claude --output-format json` envelope (`result` field) or bare JSON; validates types; unknown `project` → `question` set ("Which project: a, b?") instead of throwing; `existing` room not in `rooms` → treated as `new`; `name` re-slugged; `model` from `config/routing.json` by `taskType` (unknown → `sonnet`).
  - `route(request: string, env?): Promise<Route>` — spawns the exact router call from Global Constraints via `execFile` with a 60 s timeout; non-zero exit/timeout/ENOENT → `RouterError` with one line.
  - Room names are global slugs: if a **new** room's slug already exists for a different project, `parseRoute` suffixes the project (`<name>-<project>`) and then a counter.
  - CLI: `maitre route <id> [<id>...]` reads `$MAITRE_HOME/reception/requests/<id>.md` (concatenated in order, separated by a line `---`), routes it, stores `{ route, requestIds }` at `reception/routes/<last id>.json` (0600), and prints one human line (`route 7 → new room nf-bug in backend (build → opus)` or the question); `--json` prints JSON. `maitre dispatch <id>` reads the stored route: `new` → `openRoom` with brief = header + the request files; `existing` → `sendToRoom` with the request text. Exit 0 on a route/question/dispatch, 1 on errors (one line).
- [ ] **Step 1: Failing tests:** `route 7 8` concatenates both request files and stores `routes/8.json`; `dispatch 8` opens a new room (fake herdr) with the request text inside the brief file, or sends to the existing room; a new room named like an existing room of another project gets `-<project>`; prompt contains the request only inside the data fence (and a request containing a fake closing fence is escaped); exact claude argv (prompt first, then `--model haiku --setting-sources "" --tools "" --system-prompt … --output-format json`); parse envelope and bare JSON; garbage → `RouterError`; unknown project → question; existing-but-missing room → new; model map incl. unknown → sonnet; fake claude that sleeps past timeout → `RouterError` within 61 s (use a short injectable timeout in the test); missing `claude` → `RouterError` (Review Focus 2).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(router): classify requests with a minimal-context Haiku call`.

### Task 6: Reception and the `maitre` entrypoint

**Files:**
- Create: `src/reception.ts`, `hooks/reception-request.mjs`, `hooks/reception-guard.mjs`, `reception/PROMPT.md`
- Modify: `src/cli.ts` (no-arg `maitre`), `src/hook-settings.ts` (reception settings)
- Test: `test/reception.test.ts`, `test/reception-guard.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5; `maitre lounge` (M1).
- Produces:
  - `hooks/reception-request.mjs`: `UserPromptSubmit` hook for the reception — writes the prompt to `$MAITRE_HOME/reception/requests/<n>.md` (next integer, 0600, atomic) and prints `additionalContext` JSON telling the model "This message is request <n>." (Claude Code's UserPromptSubmit output format); never blocks the prompt; exits 0 always.
  - `hooks/reception-guard.mjs`: PreToolUse hook (stdin JSON) → for `tool_name === 'Bash'` allow only the token allowlist in Global Constraints (exact regexes per command); any other tool → deny. Output Claude Code's PreToolUse decision JSON (`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`; allow = exit 0 with no output). Never throws (malformed input → deny with reason).
  - `writeReceptionSettings(env?): string` → `$MAITRE_HOME/settings/reception.json` with `permissions.allow: ["Bash(maitre:*)"]` and the guard hook (absolute node + script path, quoted like M1).
  - `reception/PROMPT.md` (≤ 1500 words, English): role (host, never does the work), the loop (each user message arrives with its request id → `maitre route <id>`; if it prints a question, ask the user, then `maitre route <id> <answer id>`; then `maitre dispatch <route id>`), one-line answers ("sent to nf-bug" / "opened nf-bug in backend on opus"), `maitre room list` when asked what's going on, `maitre room close <slug>` on request, never edit files, never retype the user's text into a command.
  - `buildReceptionCommand(env?): { cmd: 'claude'; args: string[]; env }` — exactly the reception call from Global Constraints, markers stripped, `PATH` prefixed with repo `bin/`, `MAITRE_HOME` absolute.
  - `maitre` (no args): `ensureServer`; a workspace labeled `reception` counts only if its pane has a live Claude agent (`agentInfo`), otherwise it is closed and recreated (cwd `$MAITRE_HOME`) running the reception command (quoted tokens only); same for `lounge` running `<bin/maitre> lounge --no-open`; the entrypoint itself then opens the lounge window (`openApp`, from the user's terminal env) using the URL the lounge prints (read via `readPane`); stale room tabs (registry rooms without a live agent) are closed and marked not running; finally spawn `herdr --session <s>` attached in the current terminal (stdio inherit) and exit with its code. Idempotent.
- [ ] **Step 1: Failing tests:** request hook writes `requests/1.md`, `2.md`… and returns the id context; guard allows `maitre route 7`, `maitre route 7 8`, `maitre dispatch 8`, `maitre room list`, `maitre room close nf-bug`, `maitre projects`; denies `maitre route "x"`, `maitre index; rm -rf x`, `maitre route $(id)`, `bash -c maitre`, `maitre dispatch 8 | sh`, a newline, the `Write` and `Edit` tools, malformed stdin — each with a reason (Review Focus 5); restored bare-shell `reception` workspace is replaced (Review Focus 1b); reception settings JSON shape; `buildReceptionCommand` argv exact; `maitre` with fake herdr creates `reception` + `lounge` workspaces once and attaches; second run creates nothing; `PROMPT.md` ≤ 1500 words and mentions every command it uses (test greps them against `HELP`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 4b: Real smoke of the reception flags** (dedicated herdr session `maitre-m2a-smoke`, temp `MAITRE_HOME`, `--model haiku` for cost): launch the reception command in a pane; confirm (a) herdr reports `agent_status` correctly (idle/working) with setting sources off and the re-added herdr hook, (b) `auto` mode + `--setting-sources ""` starts and runs `maitre room list` without a permission prompt, (c) the guard's deny JSON is honored (ask it to run `ls`), (d) the request hook files appear with ids the model sees. Record results in the report; stop and delete the herdr session. If any of (a)–(d) fails, report before committing.
- [ ] **Step 5:** Commit `feat(reception): guarded reception and the maitre entrypoint`.

### Task 7: Lounge shows project and branch

**Files:**
- Modify: `src/live-api.ts` (enrich), `src/room-state.ts` (type only, if needed), `lounge/js/live.js`, `lounge/js/panel.js`
- Test: `test/live-api.test.ts`, `test/lounge/live.test.mjs`

**Interfaces:**
- Consumes: `readRoom` (Task 3).
- Produces: SSE/`/api/state` room objects gain optional `project?: string`, `branch?: string`, `model` falls back to the registry model when the reducer has `unknown`; the panel's "Where" line shows `<project> · <branch>` (or `scratch`); a code room's herdr label matches `<project> / <room>`.
- [ ] **Step 1: Failing tests:** a room with `room.json` appears in the snapshot with `project`/`branch`; registry model fills `unknown`; panel model shows `backend · maitre/nf-bug`; rooms without registry unchanged; demo/capture untouched (`npm run assets` → clean tree).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(lounge): show each room's project and branch`.

### Task 8: End-to-end, docs, final review, PR

- [ ] **Step 1:** Real run (cheap; dedicated session via `MAITRE_HERDR_SESSION=maitre-m2a-e2e`, temp `MAITRE_HOME`, a temp git repo with a bare remote as the only root): `maitre index --root <tmp>`; start the entrypoint pieces non-interactively (create the reception workspace and lounge as `maitre` would, without attaching); through `herdr agent prompt --wait` on the reception pane ask "add a README line saying hello in <repo>" → observe `maitre route <id>` → `maitre dispatch <id>` → a new herdr workspace `<repo> / <room>` on a worktree branch `maitre/<room>`, trust accepted on screen, the room in `/api/state` with project/branch; then a follow-up "also add a second line" routed to the **existing** room (delivery confirmed by its `UserPromptSubmit`); a request containing `` `rm -rf /tmp/x` && echo $(id) > out `` routed without any shell expansion (brief file shows it verbatim, `/tmp/x` untouched); and ask the reception to run `rm -rf /tmp/x` directly and confirm the guard denies it. Record observations; stop and delete the herdr session; keep worktrees out of the user's real repos (temp repo only). Never touch user config.
- [ ] **Step 2:** README: "Your first reception" section (`maitre index --root ~/code`, then `maitre`), what the reception does and doesn't do, model map, where worktrees/branches go, how to close a room; roadmap M2a done; `docs/design.md` §7 updated (M2 split into M2a/M2b).
- [ ] **Step 3:** `npm ci && npm test` clean; forbidden-word scan; `npm run assets` clean.
- [ ] **Step 4:** Fresh most-capable whole-branch reviewer → one fix wave → scoped re-review → squash → push → PR (`Refs #18`, attribution line) → merge with `--rebase` on the owner's word → file follow-up issues.
