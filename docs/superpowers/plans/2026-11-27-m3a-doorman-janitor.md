# maître M3a — Doorman and Janitor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rooms stop piling up and never get lost: a doorman caps active rooms (the rest wait in a queue on the sidewalk) and a janitor closes rooms idle for hours with nothing pending, writing minutes to a markdown vault, while rooms with loose ends go to the couch.

**Architecture:** A disk-only view of each room (`roomActivity`: last live state, last event time, PR url, transcript path) lets the CLI and the lounge process decide the same way. `checkPending` answers "can this room close without losing work". The janitor (`janitorTick`) and the doorman (`doormanTick`) run inside the lounge process (`maitre serve` / `maitre lounge`) on a timer and on room changes; `maitre janitor --dry-run` runs the janitor's decisions without acting. Dispatch of a new room goes through the doorman (open now or enqueue). Closing writes minutes (Haiku over a transcript excerpt, with a fallback) to `$MAITRE_HOME/memory`.

**Tech Stack:** Node ≥ 20, TypeScript strict, `node:test`, zero runtime deps; git, `gh`, herdr 0.8.x and Claude Code 2.1.x as external programs.

**Spec:** `docs/superpowers/specs/2026-11-27-m3a-doorman-janitor-design.md` (local, git-ignored; approved by the owner on 27-11-2026, including "Decisions from the builder check") and `docs/design.md` §6.6, §7.1.

**Out of M3a (M3b):** seat release after 30 min + `claude --resume`; PR watching (CI/review notices, merge dance, PR closed without merge); the router reading minutes; `memory/decisions/`, `memory/preferences.md`.

## Global Constraints

- English everywhere; zero runtime deps; Node ≥ 20; TypeScript strict. Never write Claude Code config. User text never in a shell string; every spawn gets `cleanEnv`.
- **Never lose work:** no `--force` on any git command; never delete a branch; scratch files are moved, never deleted; any failed check (git, gh, herdr) counts as pending, with the error as the reason.
- **Settings** in `$MAITRE_HOME/config.json`: `capacity` (integer ≥ 1, default `6`), `janitor.idleHours` (number > 0, default `4`), `janitor.intervalMinutes` (number > 0, default `5`), `vault` (absolute path, default `$MAITRE_HOME/memory`). Invalid → default plus a warning; `loadConfig`/`saveConfig` keep them.
- **Closed vs not running:** a room is *closed* only when `closedBy` is set (closed with minutes). `closedAt` alone keeps its M2a meaning ("found not running", sticky) and does **not** exclude a room from the janitor; dead rooms are exactly what the janitor cleans up. `openRoom` must write a fresh record without `closedAt`/`closedBy`/`couch` on reopen.
- **Active room:** registered, not closed (`closedBy` unset), Claude running, not couched, no open PR (`prUrl` / state `whisky`). Queued rooms are not active. Capacity is soft (spec decision 4).
- **Idle:** live state `ready` or `coffee` and the last hook event older than `idleHours`.
- **Pending (code room):** non-empty `git status --porcelain`; an ignored file whose basename is `.env` or matches `.env.*` (owner decision); unpushed commits (vs upstream, else `origin/<branch>`, else `origin/<base>`), unless a merged PR for the branch (`gh pr list --head <branch> --state all --json state,headRefOid`) has the local HEAD as its head or an ancestor of it ("landed"); an open PR for the branch; live state `blocked`; the worktree's HEAD not on `rec.branch` (detached or another branch: `worktree not on its branch`); a git operation in progress (rebase, merge, cherry-pick, revert, bisect: `git operation in progress`). When `origin` is not a GitHub remote, the PR checks are skipped (no PRs there; the landed rule does not apply). Ignored files are listed with `git ls-files --others --ignored --exclude-standard --directory` (directories collapsed, never descending into `node_modules`). Scratch room: only `blocked`.
- **Couch:** `RoomRecord.couch = { since, reasons }`; shown only while the room is still idle with no event after `since` (stale otherwise; the janitor clears it on its next tick). Couched rooms keep running.
- **Path guard:** before any destructive step, `realpath(rec.dir)` must be under `$MAITRE_HOME/worktrees/` (code) or `$MAITRE_HOME/scratch/` (scratch); otherwise the decision is `error` and nothing is touched.
- **No closing an active room:** the activity is read again right before the tab is closed; any event newer than the decision aborts the close (`skip`, `room became active`). `deliverToRoom` refuses with `<room> is closing` while the closing marker exists.
- **Closing:** per-room marker `state/rooms/<room>/closing` (O_EXCL) holding the closer's pid; stale when that pid is dead; a close that crashed half-way resumes (worktree already gone, scratch already moved → continue to the record); minutes → `<vault>/minutes/YYYY-MM-DD-<room>.md` (suffix `-2`, `-3` on clash), front matter `room, project, branch, model, opened, closed, closedBy`, links `[[<project>]]` and `[[<room>]]`; close the herdr tab; janitor: `git worktree remove <path>` (no `--force`; failure → logged + loose end, room still closed, branch kept); scratch: move files to `<vault>/rooms/<room>/` and remove the empty folder; record `closedAt`, `closedBy` (`janitor` | `user`). `maitre room close` writes minutes too, keeps the worktree.
- **Minutes call:** `claude -p <prompt> --model haiku --setting-sources "" --tools "" --system-prompt <MINUTES_SYSTEM> --output-format json`, 60 s timeout, cleanEnv; the transcript excerpt goes inside a data fence; on any failure, fallback minutes from task, last steps, last reply, branch and `git log origin/<base>..HEAD --oneline`, marked "no summary".
- **Queue:** `state/queue.json` = `[{ room, requestIds, route, queuedAt, attempts, lastError? }]`, changed only under `state/queue.lock` (O_EXCL, stale after 30 s), held only for read-modify-write, never while a room opens: admitting a room writes an `opening` reservation `{ room, pid, since }` to `state/opening.json` under the lock (it counts as active), the room opens outside the lock, then the reservation is dropped (stale when its pid is dead); FIFO; 3 failed opens in a row → moved to `state/queue-failed.json`. A follow-up routed to a queued room appends its request ids. Queued names are `taken` for the router and listed among its open rooms with state `queued`.
- **Logs:** `state/janitor.log` JSON lines `{ ts, room, decision: 'close'|'couch'|'skip'|'error', reasons }`, 0600.
- **The owner's machine runs maître for real** (systemd unit, service on 8737, herdr session `maitre`, `~/.maitre` with data): tests and the e2e use temp `HOME`, `XDG_CONFIG_HOME` and `MAITRE_HOME` and a non-default herdr session, so nothing sees the real unit or service.
- Tests: temp `MAITRE_HOME`, temp git repos with bare remotes, a fake `gh` and the existing fake router `claude` first on PATH, the stateful fake herdr; never the real `~/.maitre`, real repos or real PRs.
- Commits: repo-local identity; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; branch `feat/m3a-doorman-janitor` in `~/maitre--worktrees/m3a`; PR to `main`, merged with `--rebase` on the owner's word; forbidden-words scan before every push.

## Review Focus

1. **Work that must not be lost** (dirty tree, untracked file, `.env` ignored, commits pushed without `-u`, no upstream with new commits, squash-merged and remote branch deleted, `gh` missing or failing) → the right pending/landed verdict; never a close on doubt. → tests in Task 3.
2. **Races** (two dispatches taking the last seat, the CLI closing a queued room while the doorman opens it, the janitor and `room close` on the same room) → one winner, no double open, no double close. → tests in Tasks 5 and 6.
3. **Minutes failure** (no transcript path, transcript file gone, Haiku timeout or garbage) → fallback minutes, the room still closes. → tests in Task 4.
4. **A stuck queue head** (project removed, path in use) → leaves the queue after 3 failures; the rest open. → tests in Task 6.
5. **Rooms from before M3a** (no transcript, no couch fields, dead Claude) → handled with fallbacks, never crash a tick. → tests in Tasks 2 and 5.

---

### Task 1: Settings and the transcript path

**Files:**
- Modify: `src/config.ts`, `src/rooms.ts`, `hooks/maitre-hook.mjs`, `src/events.ts`
- Test: `test/projects.test.ts` (config), `test/hook.test.ts`

**Interfaces:**
- Produces:
  - `MaitreConfig` gains `capacity?: number; janitor?: { idleHours?: number; intervalMinutes?: number }; vault?: string`.
  - `settings(env?): { capacity: number; idleMs: number; intervalMs: number; vault: string; warnings: string[] }` in `src/config.ts` (defaults and validation per Global Constraints).
  - `RoomRecord` gains `couch?: { since: number; reasons: string[] }`, `closedBy?: 'janitor' | 'user'`.
  - The hook writes `transcript` (Claude Code's `transcript_path`, capped like other ids/paths) on every line; `HookLine` gains `transcript?: string`.
- [ ] **Step 1: Failing tests:** defaults with no config; each invalid value → default + one warning; a load/save round-trip keeps all four settings and `lang`; the hook stores `transcript` from `transcript_path` and omits it when absent.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(config): doorman and janitor settings, transcript path in hook lines`.

### Task 2: Room activity from disk

**Files:**
- Create: `src/activity.ts`
- Modify: `src/room-open.ts` (reuse the events tail reader instead of duplicating it)
- Test: `test/activity.test.ts`

**Interfaces:**
- Produces: `interface RoomActivity { state: LiveState | 'none'; lastEventAt?: number; prUrl?: string; transcript?: string }`; `roomActivity(room: string, env?): RoomActivity` — reduces the tail of the room's `events.jsonl` (same bounded tail as `loungeState`) and takes the newest `transcript`; `isIdle(a: RoomActivity, now: number, idleMs: number): boolean`; `isActive(rec: RoomRecord, a: RoomActivity, running: boolean): boolean` per Global Constraints.
- [ ] **Step 1: Failing tests:** a room with no events → `none`; ready + old last event → idle, coffee → idle, work/blocked/smoke → not idle; recent event → not idle; `prUrl` → not active; couched → not active; closed → not active; transcript taken from the newest line that has one; a room from before M3a (no transcript) → `transcript` undefined.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(rooms): room activity from the events file`.

### Task 3: Pending checks

**Files:**
- Create: `src/pending.ts`, `test/fixtures/fake-gh.mjs`
- Test: `test/pending.test.ts`

**Interfaces:**
- Consumes: `RoomActivity` (Task 2); the project base from the index (`readIndex`) or `origin/HEAD`.
- Produces: `checkPending(rec: RoomRecord, activity: RoomActivity, env?): Promise<{ reasons: string[]; ignoredGone: string[] }>` (`reasons` empty = nothing pending; `ignoredGone` = top-level ignored paths that would go with the worktree, for the minutes). Reason texts (exact): `uncommitted changes`, `untracked .env files: <paths>`, `<n> commit(s) not pushed`, `PR open: <url>`, `waiting on you`, `could not check: <message>`. `gh` via `execFile` with `cleanEnv`, 20 s timeout; git with `GIT_TERMINAL_PROMPT=0`.
- [ ] **Step 1: Failing tests** (temp repo + bare origin, fake `gh` that answers from a JSON file): clean and pushed → `[]`; modified file → uncommitted; untracked file → uncommitted; ignored `.env.local` → `.env` reason, ignored `node_modules/` → `[]` with `ignoredGone` listing it; branch with no upstream but pushed as `origin/<branch>` → `[]`; no upstream, commits not on `origin/<base>` → not pushed; squash-merged PR whose head equals local HEAD with the remote branch deleted → `[]` (landed); open PR → `PR open`; `gh` missing or exiting 1 → `could not check: …`; blocked → `waiting on you`; detached HEAD or another branch checked out → `worktree not on its branch`; a rebase in progress → `git operation in progress`; `origin` not on GitHub → PR checks skipped, `gh` never called; ignored `node_modules/` with a `.env` inside it is not descended; scratch room → only `blocked` matters.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(janitor): pending checks that never lose work`.

### Task 4: Minutes and the vault

**Files:**
- Create: `src/minutes.ts`, `src/vault.ts`
- Test: `test/minutes.test.ts`

**Interfaces:**
- Consumes: `settings().vault` (Task 1), `RoomActivity` (Task 2), the fake router `claude` fixture (extend it to answer a minutes prompt if needed).
- Produces:
  - `transcriptExcerpt(path: string, maxChars = 40_000): string` — user prompts and assistant text from Claude Code's transcript JSONL, newest kept when cutting; tool outputs dropped; returns `''` when the file is missing or unreadable.
  - `writeMinutes(input: { rec: RoomRecord; activity: RoomActivity; closedBy: 'janitor' | 'user'; looseEnds: string[]; ignoredGone: string[] }, env?): Promise<string>` — returns the written path; Haiku per Global Constraints, else fallback.
  - `moveScratch(rec: RoomRecord, env?): string` — moves the scratch folder's files to `<vault>/rooms/<room>/` (suffix on clash), removes the empty folder, returns the destination.
- [ ] **Step 1: Failing tests:** excerpt keeps prompts/answers in order and drops tool results; a huge transcript is cut to `maxChars` keeping the newest; missing file → `''`; minutes file name `YYYY-MM-DD-<room>.md`, a second close the same day → `-2`; front matter fields and `[[project]]`/`[[room]]` links present; fake Haiku timeout or non-JSON → fallback with "no summary", task, last steps and loose ends; scratch files moved byte-for-byte and the folder removed; nothing deleted on a name clash.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(janitor): minutes in a markdown vault`.

### Task 5: Closing and the janitor

**Files:**
- Create: `src/janitor.ts`
- Modify: `src/room-open.ts` (`closeRoom` gains minutes via the closer), `src/cli.ts` (`maitre janitor --dry-run`, `room close` prints "writing the minutes…")
- Test: `test/janitor.test.ts`, `test/cli.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4; `closeRoom`, `probeRoom`, `markNotRunning` (src/room-open.ts).
- Produces:
  - `closeWithMinutes(rec: RoomRecord, by: 'janitor' | 'user', env?, deps?): Promise<{ minutes: string; worktreeRemoved: boolean; notes: string[] } | 'busy'>` — takes the closing marker (another closer → `'busy'`), writes minutes, closes the tab, removes the worktree only when `by === 'janitor'`, moves scratch files, writes `closedAt`/`closedBy`, clears `couch`, releases the marker.
  - `janitorTick(env?, deps?: { now?: () => number; dryRun?: boolean }): Promise<JanitorDecision[]>` with `type JanitorDecision = { room: string; decision: 'close' | 'couch' | 'skip' | 'error'; reasons: string[] }` — for every registered, not-closed room: running + idle → pending? couch : close; dead (not running) → pending? skip with reasons : close; stale couch → cleared; everything logged; never throws (a room's error is an `error` decision).
  - CLI: `maitre janitor --dry-run` prints one line per room (`<room>  <decision>  <reasons>`), acts on nothing; `maitre janitor` without `--dry-run` runs one real tick (for scripts/tests).
- [ ] **Step 1: Failing tests:** idle clean code room → closed, minutes written, worktree removed, branch still exists, `closedBy: janitor`; idle with commits not pushed → couch with that reason, nothing removed; a couch whose room got a new event → cleared; dead room with nothing pending → closed with fallback minutes; dead room with pending → skip, untouched; `git worktree remove` failing → room closed, branch kept, note in the minutes; `--dry-run` changes no file; two concurrent `closeWithMinutes` → one `'busy'`; `room close` by hand writes minutes and keeps the worktree; a room from before M3a (no transcript) closes with fallback minutes; a record like a real M2a dead room (`closedAt` set, no `closedBy`) is processed, not skipped; a `rec.dir` outside the maître folders → `error`, nothing moved; an event arriving while the minutes are written → close aborted (`room became active`), tab still open; a closing marker left by a dead pid is taken over and the half-done close completes; `deliverToRoom` to a closing room fails with `<room> is closing`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(janitor): close idle rooms with minutes, couch the rest`.

### Task 6: The doorman

**Files:**
- Create: `src/doorman.ts`
- Modify: `src/router.ts` (dispatch of a new room asks the doorman; queued rooms visible to the router), `src/lounge-reception.ts` (queued reply), `src/room-open.ts` (`listRoomRows` shows queued/failed; `closeRoom` on a queued room removes it), `src/cli.ts`
- Test: `test/doorman.test.ts`, `test/router.test.ts`, `test/lounge-reception.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2; `openRoom`, `dispatchRouteDetailed`, `routeRequests`.
- Produces:
  - `activeCount(env?): Promise<number>`; `withQueueLock<T>(env, fn: () => T | Promise<T>): Promise<T>`; `readQueue(env?)`, `queuedRooms(env?): { room: string; position: number; project?: string }[]`.
  - `admit(route: Route, requestIds: string[], env?): Promise<{ kind: 'open'; release: () => void } | { kind: 'queued'; position: number }>` — under the lock: a free seat → write the `opening` reservation and return `open` (the caller opens outside the lock, then calls `release`); else enqueue.
  - `appendToQueued(room: string, requestIds: string[], env?): boolean`.
  - `doormanTick(env?, deps?): Promise<string[]>` — returns at once when the queue is empty (no herdr probe); otherwise reserves a seat for the oldest entry under the lock, opens it outside the lock, repeats while seats are free, counts failures, moves a 3-time failure to `queue-failed.json`; returns the opened room names.
  - `dispatchRouteDetailed` for a new room: `admit` → open as today, or return `{ room, lines: ['queued: <room> waits for a seat (position N)'], needsYou: false, queued: true }` (and a hint line when no lounge is live). For an existing room that is queued: `appendToQueued` and say so.
  - Router: queued names join `taken` and the open-room list (state `queued`).
- [ ] **Step 1: Failing tests:** cap 2 with 2 active rooms → a new route is queued at position 1, a second at 2; a follow-up to a queued room appends its ids (one entry, two request ids); `doormanTick` after a room closes opens the oldest only; two concurrent `admit`s with one free seat → one `open`, one `queued` (the `opening` reservation counts); the queue lock is never held while a room opens; an `opening` reservation whose pid died is dropped; `room close` on a queued room removes it; a head that fails 3 times moves to `queue-failed.json` and the next opens; couched and PR rooms don't count; the router sees a queued name as taken (no duplicate slug); the reception reply for a queued room says "queued".
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(doorman): room capacity and the sidewalk queue`.

### Task 7: The lounge process and live states

**Files:**
- Modify: `src/cli.ts` (`serve`/`lounge` run the ticks), `src/live-api.ts`, `src/room-state.ts` (`LiveState` gains `queue` and `couch`), `lounge/js/live.js`, `lounge/js/panel.js`, `lounge/js/i18n.js`
- Test: `test/live-api.test.ts`, `test/lounge/live.test.mjs`, `test/lounge/panel.test.mjs`

**Interfaces:**
- Consumes: `janitorTick`, `doormanTick`, `queuedRooms` (Tasks 5–6).
- Produces:
  - Live lounges run `janitorTick` + `doormanTick` once at start, then every `intervalMs`, and `doormanTick` also after any room change (debounced 2 s); a tick never overlaps the previous one; errors are logged, never crash the lounge.
  - `LiveRooms` overlays `couch` (non-stale) as state `couch` with `couchReasons`, and adds queued rooms (from `queue.json`, re-read on change) as rooms in state `queue` with `queuePosition`.
  - Front end: live `queue` → the demo's `queue` (sidewalk) state; live `couch` → the demo's `sleep` (couch) state; the panel shows "Waiting for a seat (position N)" / "On the couch: <reasons>" (en, pt-BR).
- [ ] **Step 1: Failing tests:** a ticking lounge closes an idle clean room and opens the queued one (fake herdr, fake clock); a couched room shows as `couch` with reasons and goes back to its live state after a new event; queued rooms appear in `/api/state` with positions; `roomToAgents` maps `queue`/`couch` to `queue`/`sleep`; panel texts in both languages; demo visuals unchanged (`npm run assets` clean).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(lounge): doorman and janitor in the lounge, sidewalk and couch live`.

### Task 8: Docs and end-to-end

**Files:**
- Modify: `README.md`, `docs/design.md`

- [ ] **Step 1: Docs:** README doorman/janitor marked today; the never-lose-work rules (including `.env`); where minutes live; settings rows (`capacity`, `janitor.idleHours`, `janitor.intervalMinutes`, `vault`); `maitre janitor --dry-run`; the FAQ "Will the janitor delete my work?"; roadmap M3a done, M3b next. design.md §6.6 and §7.1 note what M3a does and what moved to M3b.
- [ ] **Step 2: e2e in isolation** (temp `MAITRE_HOME`, `MAITRE_HERDR_SESSION=maitre-m3a-e2e`, temp repo with a bare remote, real herdr and router, `capacity: 1`, `janitor.idleHours: 0.01`): a second request is queued and opens when the first closes; an idle room with an unpushed commit goes to the couch; after pushing, the next tick closes it with minutes (real Haiku), the worktree is gone and the branch remains; a scratch room's files land in the vault; `maitre janitor --dry-run` matches what happens.
- [ ] **Step 3:** `npm test` green, `npm run assets` clean, forbidden-words scan clean.
- [ ] **Step 4:** Commit `docs: M3a — doorman and janitor`.
- [ ] **Step 5 (controller, after merge, with the owner):** update `~/maitre`, build, run `maitre janitor --dry-run` on the real `~/.maitre` and show the owner what the first tick would do, before restarting the service.
