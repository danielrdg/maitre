# maître M3b — Seats, PRs and Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A quiet room gives up its Claude process and seat and comes back with `claude --resume` when needed; maître follows each room's PR (CI/review notices, merge → dance → close, closed → close); a new room on an old topic starts with the old room's minutes.

**Architecture:** Builds on M3a (stacked on `feat/m3a-doorman-janitor`). A per-room `pr.json` keeps the PR state; a PR watcher on its own lounge timer polls `gh` and records notices and merges; the janitor tick parks quiet rooms (`seat` on the record) and closes merged/closed-PR rooms after their dance; `wakeRoom` reopens a parked or dead room with `--resume` through an `opening` reservation; the router sees recent minutes and parked rooms.

**Tech Stack:** Node ≥ 20, TypeScript strict, `node:test`, zero runtime deps; git, `gh`, herdr 0.8.x, Claude Code 2.1.x.

**Spec:** `docs/superpowers/specs/2026-11-27-m3b-seats-prs-memory-design.md` (local, git-ignored; its "Decisions from the builder check" bind) and `docs/design.md` §7.1. Written during the owner's overnight `/goal`; the owner reviews the designer's calls in the morning.

## Global Constraints

- Everything from M3a's constraints still holds: never lose work (no `--force`, no branch deletion, any failed check = pending), cleanEnv on every spawn, no shell strings, strict path guard, tests with fakes only, never the real `~/.maitre`, service on 8737, herdr session `maitre`, real repos or PRs; public-repo privacy.
- **Settings** (`$MAITRE_HOME/config.json`, same validate-and-keep rules as M3a): `seat.releaseMinutes` (number > 0, default `30`), `pr.autoWake` (boolean, default `false`), `pr.danceMinutes` (number > 0, default `3`), `pr.pollMinutes` (number > 0, default `2`).
- **Quiet:** live state `ready`|`coffee`|`whisky`|`couch`, herdr `idle`, last countable event older than the threshold. `isIdle` (M3a) is unchanged.
- **Record fields:** `seat?: { releasedAt: number; session: string }`; `pr.json` at `state/rooms/<room>/pr.json` = `{ url, number, state: 'OPEN'|'MERGED'|'CLOSED', headRefName, seenAt, failing: string[], lastFeedbackAt?: string, reviewDecision?: string, notice?: { kind: 'ci'|'review'|'merged'|'closed', text, url, since }, dance?: { until } }` (0600, atomic).
- **Active (updated):** not active when `pr.json` says OPEN (replaces the reducer's `prUrl`), when `seat` is set, plus M3a's rules.
- **Who parks (design §7.1, literal):** a room on the couch (M3a couch record, not stale) or with an open PR (`pr.json` OPEN), quiet for `seat.releaseMinutes`. Plain idle rooms are NOT parked (the wider rule is a question for the owner).
- **Parking:** runs under the room's closing marker; record `seat` first (session id from the newest event with one), then stop Claude through the M3a close path minus minutes/removal (input-box check, `/exit` only on an empty box, tab closed); a draft → skip, retry next tick. Worktree, branch, session, `pr.json` stay.
- **Wake:** `wakeRoom(room)` = `opening` reservation (never queued, capacity soft) → new herdr tab in the room's dir started with the same command builder `openRoom` uses (same `--permission-mode`, `--agents`, `--settings`, model), plus `--resume <session>` (argv parity tested); behaviour on resume per the Task 0 spike → wait for the agent (trust timeout) → `patchRoom` (fresh read) with the new `herdr` ids, clearing `seat` and `closedAt` → release. Resume failure → fresh `claude` with a brief of the room's fallback minutes + the pending request, and the reply says so.
- **Outside text never becomes a prompt:** with `pr.autoWake`, the line delivered to a room carries only the kind, the author login and the URL (never a comment body); `notice.text` is filtered like `shownPaths` (control/bidi characters replaced) and clipped; `continues` is validated with `roomSlug` before any file lookup.
- **PR polling:** own lounge timer every `pr.pollMinutes`; ≤ 4 concurrent `gh` calls, 20 s timeout each; `gh pr view <url> --json state,headRefName,mergedAt,closedAt,author,statusCheckRollup,latestReviews,comments,reviewDecision`. First poll = baseline. Ignore feedback whose author login equals the PR author. Notices clear on the room's next real prompt or a PR state change.
- **Merge/close:** MERGED → `dance.until = now + danceMinutes`; after it, the janitor closes the room if nothing pending (M3a rules; landed applies), else couches. CLOSED unmerged → close with minutes noting it, branch kept (pending → couch).
- **Router memory:** prompt section with up to 10 newest minutes (room, project, closed date, first line of "What was asked"), inside the data fence; output may carry `continues: <closed room>` → the brief gets that room's newest minutes file appended (≤ 6 KB) under `# Minutes of <room> (closed <date>)`. Parked/dead-with-session rooms are listed to the router with state `parked`.
- Commits: repo-local identity; messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; branch `feat/m3b-seats-prs` in `~/maitre--worktrees/m3b`, stacked on `feat/m3a-doorman-janitor`; PR based on the M3a branch; merges only on the owner's word.

## Review Focus

1. **Parking loses nothing** (draft in the input, a turn starting during the park, the session id missing) → skip, never stop a working room. → Task 3.
2. **A woken room is the same room** (a closer in flight, the doorman opening the same name, two wakes at once, a dead room after a reboot) → one wake, no double tab. → Task 4.
3. **PR noise and silence** (first poll, the owner's own comments, a bot review, a flaky `gh`, a PR of another branch printed in a Bash call) → baseline once, notices only for real news, never a notice storm. → Task 2.
4. **Merged with local work left** (commits after the merge, a `.env`) → couch, never close. → Task 3.
5. **Router memory injection** (minutes text with instructions or fences) → stays data. → Task 5.

---

### Task 0: Spike — `claude --resume` in a herdr tab

**Files:** Create `docs/spikes/2026-11-27-m3b-resume.md`.

- [ ] Step 1: In isolation (temp `XDG_*`/`MAITRE_HOME`, herdr session `maitre-m3b-spike`, a temp scratch dir), check with real Claude Code: after `--resume <id>`, do the hooks report the same session id, and does `SessionStart` fire (with which `source`)? With an unknown id, or an id from another folder, does `claude --resume` exit with an error or open a picker (and what does herdr's agent status say)? Does any prompt appear on resume, and how does herdr classify it? Also capture one real `gh pr view --json statusCheckRollup,latestReviews,comments,author,reviewDecision,state,headRefName` shape (read-only, any public PR) for the fake gh fixture.
- [ ] Step 2: Write the findings and the recipe Task 4 uses (how to detect a failed resume reliably). Never touch the owner's real install.
- [ ] Step 3: Commit `docs(spike): claude --resume in a herdr tab`.

### Task 1: Settings, PR state and quiet rooms

**Files:** Modify `src/config.ts`, `src/rooms.ts`, `src/activity.ts`; Create `src/pr-state.ts`. Test: `test/projects.test.ts`, `test/activity.test.ts`, `test/pr-state.test.ts`.

**Interfaces:**
- Produces: `settings()` gains `releaseMs`, `autoWake`, `danceMs`, `pollMs`; `RoomRecord.seat?`; `readPr(room, env?) / writePr(room, pr, env?)` (atomic 0600, tolerant read → undefined); `isQuiet(a: RoomActivity, herdr: RoomLiveness, now, ms): boolean`; `isActive(rec, activity, running, pr?)` uses `pr?.state === 'OPEN'` and `rec.seat`.
- [ ] Step 1: failing tests — defaults/validation/round-trip for the 4 settings; pr.json round-trip and corrupt → undefined; `isQuiet` truth table (whisky/couch quiet; working herdr not quiet; recent event not quiet; Notification ignored); `isActive` false with OPEN pr or seat, true when pr MERGED/absent.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(m3b): seat and PR settings, PR state, quiet rooms`.

### Task 2: PR watcher

**Files:** Create `src/pr-watch.ts`; extend `test/fixtures/fake-gh.mjs` (`pr view`, `pr list` per URL/branch). Test: `test/pr-watch.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces: `prTick(env?, deps?: { now?; gh?; concurrency? }): Promise<PrEvent[]>` with `PrEvent = { room; kind: 'adopted'|'ci'|'review'|'merged'|'closed'|'error'; text }` — for each not-closed code room: adopt a PR (reducer `prUrl` with matching `headRefName`, else branch discovery at most every 15 min), poll it, baseline on first sight, write notices, set `dance.until` on MERGED, never throw.
- [ ] Step 1: failing tests — adoption by branch and by matching `prUrl`; a `prUrl` of another branch ignored; first poll = no notice; a new failing check → one `ci` notice, the same failure next poll → none; a review by a bot → `review` notice; a comment by the PR author → none; MERGED → `dance.until`; CLOSED → `closed` event; `gh` failure → `error`, state unchanged; at most 4 calls in flight.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(m3b): watch each room's PR`.

### Task 3: Parking and PR-driven closes in the janitor

**Files:** Create `src/seats.ts`; Modify `src/janitor.ts`, `src/room-open.ts` (reuse the input-box check and tab close). Test: `test/seats.test.ts`, `test/janitor.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2; M3a `closeRoomTab`, `checkInput`, `closeWithMinutes`, `checkPending`.
- Produces: `parkRoom(rec, env?, deps?): Promise<'parked'|'skip'>`; `janitorTick` parks quiet rooms (decision `park`), treats parked rooms as idle for the 4 h rule, closes MERGED rooms after `dance.until` (landed) or couches them, closes CLOSED-PR rooms with a minutes note, keeps every M3a guarantee.
- [ ] Step 1: failing tests — a quiet couched room parks and a quiet room with an OPEN PR parks (seat written before the tab closes, session id kept); a quiet room with neither does not park; a draft → skip; a working room never parks; parking runs under the closing marker; a parked room whose PR merges closes after `dance.until` (no R10 dead-room wait); a parked clean room closes after `idleHours`; MERGED + clean → closed after `dance.until` (not before); MERGED + an unpushed commit → couch; CLOSED → closed with "PR closed without merge" in the minutes; `--dry-run` shows `park`.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(m3b): idle rooms give up their seat; merged and closed PRs close the room`.

### Task 4: Waking

**Files:** Create `src/wake.ts`; Modify `src/router.ts` (dispatch to a parked/dead room wakes then delivers; parked/dead-with-session rooms listed as `parked`), `src/cli.ts` (`maitre room wake <room>`), `src/room-run.ts` (pass-through `--resume`). Test: `test/wake.test.ts`, `test/router.test.ts`.

**Interfaces:**
- Produces: `wakeRoom(room, env?, deps?): Promise<{ resumed: boolean; lines: string[] }>` per Global Constraints; `dispatchRouteDetailed` existing branch: parked/dead → wake → `deliverToRoom`.
- [ ] Step 1: failing tests — wake writes a reservation, opens one tab whose argv equals `openRoom`'s plus `--resume <session>` (parity test), patches herdr ids and clears seat/closedAt; two concurrent wakes → one tab; a closer in flight → wake refused (`is closing`); resume failure → fresh claude with the fallback brief, reply says so; a follow-up to a parked room wakes it and is delivered; the router lists a dead room with a session as `parked`.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(m3b): wake a parked room with --resume`.

### Task 5: Router memory

**Files:** Modify `src/router.ts`, `src/minutes.ts` (list recent minutes). Test: `test/router.test.ts`.

**Interfaces:**
- Produces: `recentMinutes(env?, limit = 10)`; router prompt section; `Route.continues?`; dispatch appends the old minutes to the brief.
- [ ] Step 1: failing tests — the prompt carries up to 10 newest minutes inside the fence; minutes containing a fence or instructions stay data (fence length chosen as today); `continues` naming a closed room appends its newest minutes (≤ 6 KB, header with date); `continues` naming an unknown room is ignored.
- [ ] Step 2–4: FAIL → implement → PASS.
- [ ] Step 5: Commit `feat(m3b): the router reads recent minutes`.

### Task 6: Lounge

**Files:** Modify `src/lounge-ticks.ts` (PR timer; `pr.autoWake`), `src/live-api.ts` (parked/dance/notice overlay), `src/lounge-reception.ts` (`POST /api/rooms/<room>/wake`), `lounge/js/live.js`, `panel.js`, `i18n.js`, `style.css`. Test: `test/lounge-ticks.test.ts`, `test/live-api.test.ts`, `test/lounge/*.test.mjs`.

**Interfaces:**
- Produces: the PR timer (start + every `pollMs`, never overlapping, caught/logged); `autoWake` wakes and delivers one line per notice; view states `parked` (couch, dimmed) and `dance` (dance floor); `notice` → an orange balloon (no bell); panel shows the notice with the PR link and a Wake button for parked rooms; en/pt-BR; demo/assets unchanged.
- [ ] Step 1: failing tests — PR timer runs and survives a throwing `prTick`; autoWake off → no wake; on → one wake + one delivered line carrying kind, login and URL only (a comment body with instructions never reaches the room); parked room visible as `parked` though its reducer state is `exit`; merged room shows `dance` until it closes; the wake endpoint (POST only, CSRF) wakes; panel strings in both languages.
- [ ] Step 2–4: FAIL → implement → PASS; `npm run assets` clean.
- [ ] Step 5: Commit `feat(m3b): parked, dancing and noticed rooms in the lounge`.

### Task 7: Docs and end-to-end

- [ ] Step 1: README/design: M3b behaviours, settings rows, `maitre room wake`, notices, the dance, router memory, roadmap M3b done; every designer's call listed for the owner.
- [ ] Step 2: e2e in isolation (temp `XDG_*`/`MAITRE_HOME`, herdr session `maitre-m3b-e2e`, lounge on a free port, `seat.releaseMinutes: 0.5`, `pr.pollMinutes: 0.25`, a temp repo whose origin is a fake GitHub via the fake gh — never a real PR): a quiet room parks and a follow-up wakes it with `--resume` (the conversation continues); a fake PR goes merged → dance → close with minutes; a fake failing check → notice; a new request on a closed room's topic gets the old minutes in its brief.
- [ ] Step 3: `npm test` green, `npm run assets` clean, forbidden-words scan clean.
- [ ] Step 4: Commit `docs: M3b — seats, PRs and memory`.
