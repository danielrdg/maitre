# Spikes 0–3: Claude Code hooks, answering via herdr, router cost

Date: 25-11-2026. Linux, Claude Code 2.1.332, herdr 0.8.2, subscription (OAuth) login, `--model haiku` (resolved as `claude-haiku-5-5`).

This is the public summary of the spikes listed in [design §9](../design.md#9-risks-and-spikes-before-m1). The raw logs stay on the machine that produced them: they hold home paths, session ids and prompts. Every payload below is trimmed and neutralized (ids shortened, paths replaced by `/tmp/room`, prompts made generic).

Sample sizes are small. Where a number comes from one or two runs, it says so.

## TL;DR

1. **Hooks cover almost every lounge state.** Register them per session with `--settings <file>`. They merge with the user's global hooks and never touch `~/.claude/settings.json`. `MAITRE_ROOM` exported in the pane reached the hook process in every logged event (61 of 61 in manual mode, 56 of 56 in auto mode).
2. **A block is visible within 35–340 ms**, through `PermissionRequest` (n=4: 37, 63, 160 and 335 ms after `PreToolUse`). It carries `tool_name` and `tool_input`, including the full `questions[].options[]` of `AskUserQuestion`. `Notification(permission_prompt)` only arrives about 6 s later, with generic text.
3. **Some paths fire no hook at all:** denying a permission ("No"), Esc during work, the folder-trust dialog, and the auto-mode onboarding overlay. Close those states from herdr's `agent_status`, or from the next main `UserPromptSubmit`/`Stop`.
4. **A `Stop` is not always the end of work.** With a background subagent, the first `Stop` carries `background_tasks[{status:"running"}]` (n=1).
5. **Every `Stop` is followed by a phantom `SubagentStop`** with `agent_type:""` and no `SubagentStart` (7 of 7 in manual mode, 7 of 7 in auto mode). Ignore it.
6. **The advisor is a server tool and fires no hook.** It only shows in the transcript and on screen.
7. **Answering through herdr works:** a digit, arrows + `enter`, or "Type something" (`4`, then `pane send-text`, then `enter`). Only send keys once `agent_status == "blocked"` is confirmed.
8. **Auto mode** fires no `PermissionRequest` for actions the classifier allows: 5 of 5 explicit requests in the capture below ran straight through. A classifier refusal fires `PermissionDenied`. That shape was read from the 2.1.332 binary, because no refusal was triggered in the capture.
9. **Router cost:** a bare `claude -p` carries about 50k input tokens of user context. With `--setting-sources "" --tools "" --system-prompt "<short>"` it drops to about 1.1k.

## Registering hooks for maître's sessions only

- **`--settings <file>`** (or an inline JSON string) adds hooks for that session. They **merge** with the user's global and plugin hooks. `--settings '{"hooks":{}}'` cannot clear the global ones.
- **`--setting-sources ""`** (or `project,local`) drops the user's global and plugin hooks and keeps the `--settings` ones. Use it for the router and reception, not for rooms (rooms run the user's own Claude Code on purpose).
- **Prefer a file path** for `--settings`. Inline JSON puts several KB in the argv, which pollutes `herdr pane process-info`.
- **Env:** variables exported in the pane (e.g. `MAITRE_ROOM`) are visible to the hook process. `CLAUDE_PROJECT_DIR` is also set (= the session cwd).
- **Event names:** 2.1.332 accepts 34 names without a settings error. The list came from `strings $(readlink -f $(which claude))`:
  - PreToolUse, PostToolUse, PostToolUseFailure, PostToolBatch, Notification;
  - UserPromptSubmit, UserPromptExpansion, SessionStart, SessionEnd, Stop, StopFailure;
  - SubagentStart, SubagentStop, PreCompact, PostCompact, PreModelSwitch, PostModelSwitch;
  - PermissionRequest, PermissionDenied, Setup, TeammateIdle, TaskCreated, TaskCompleted;
  - Elicitation, ElicitationResult, ConfigChange, InstructionsLoaded, CwdChanged, FileChanged, DirectoryAdded;
  - MessageDisplay, PreSkillShellCommand;
  - WorktreeCreate, WorktreeRemove.

  Do not register `WorktreeCreate`/`WorktreeRemove`: per the docs, a `WorktreeCreate` hook *replaces* worktree creation (not tested).
- **Timeouts:** the binary contains a per-event timeout table (15 s for the tool events and `PermissionDenied`, 30 s for `UserPromptSubmit`, 120 s for `Stop`/`SubagentStop`). Whether it is the default for command hooks was not verified. In the auto-mode capture, the logger had an explicit `timeout: 5`. On two Bash calls (a force-push and an `rm -rf` outside the cwd), Claude Code cancelled it at that timeout, and those `PreToolUse` events were lost. Both times, a second unrelated `PreToolUse` hook also stalled (11.8 s, then cancelled at its own 15 s timeout). The other six tool calls logged normally. The cause was not established; heavy machine load (load average about 18) is one candidate. **Do not set a short `timeout`.** The reducer must also tolerate a `PostToolUse` without its `PreToolUse`.
- **A slow `PreToolUse` hook delays the tool.** The tool waits for every `PreToolUse` hook, so maître's hook must stay fast.

## Event table

Common fields on every payload: `session_id`, `transcript_path`, `cwd`, `hook_event_name`. Almost all also carry `prompt_id`. Tool events add `permission_mode` and `effort.level`. Events from inside a subagent add `agent_id` and `agent_type`; the main session's events carry neither.

| Event | When it fired (measured) | Key fields beyond the common ones |
|---|---|---|
| `SessionStart` | right after boot | `source:"startup"`, `model:"claude-haiku-5-5"` |
| `InstructionsLoaded` | ~0.7 s after `SessionStart` | `file_path`, `memory_type`, `load_reason` |
| `UserPromptSubmit` | ~0.35 s after the prompt is sent | `prompt` (full text), `prompt_id`, `permission_mode` |
| `PreToolUse` | before the permission check | `tool_name`, `tool_input`, `tool_use_id` |
| `PermissionRequest` | 35–340 ms after `PreToolUse`; not fired for actions the auto-mode classifier allows | `tool_name`, `tool_input`, `permission_suggestions[]`; **no `tool_use_id`** |
| `Notification` (permission) | ~6.0 s after `PermissionRequest` (6.03 / 6.01 / 6.02 s); skipped if answered first | `message:"Claude needs your permission"`, `notification_type:"permission_prompt"`; same text for a question |
| `PostToolUse` | 29 ms after the key (AskUserQuestion); 254 ms (Bash, 216 ms of it execution) | `tool_response`, `duration_ms`, `tool_use_id` |
| `PostToolBatch` | ~90 ms after `PostToolUse` | `tool_calls[]{tool_name, tool_input, tool_use_id, tool_response(string)}` |
| `MessageDisplay` | while assistant text streams | `turn_id`, `message_id`, `index`, `final`, `delta` |
| `Stop` | end of turn | `last_assistant_message`, `background_tasks[]`, `session_crons[]`, `stop_hook_active` |
| `SubagentStart` | with `PostToolUse(Agent)` | `agent_id`, `agent_type`; **no model, no prompt** |
| `SubagentStop` | end of a subagent | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks[]` |
| `SubagentStop` (phantom) | 1.1–1.9 s after **every** `Stop` | `agent_type:""`, no prior `SubagentStart`; `last_assistant_message` is the prompt suggestion or absent |
| `Notification` (idle) | 60.09 s after `Stop`, in 2 of 3 attempts | `message:"Claude is waiting for your input"`, `notification_type:"idle_prompt"` |
| `PermissionDenied` | auto-mode classifier refusal (from the binary, not observed) | `tool_name`, `tool_input`, `tool_use_id`, `reason` |
| `SessionEnd` | on `/exit` | `reason:"prompt_input_exit"`; no last message |

Not seen in any run: PostToolUseFailure, PermissionDenied, StopFailure, UserPromptExpansion, Pre/PostCompact, Pre/PostModelSwitch, Setup, TeammateIdle, TaskCreated/Completed, Elicitation*, ConfigChange, CwdChanged, FileChanged, DirectoryAdded, PreSkillShellCommand.

## Example payloads (trimmed)

Common fields are omitted unless they matter.

Session start and a prompt:

```json
{"hook_event_name":"SessionStart","source":"startup","model":"claude-haiku-5-5"}
{"hook_event_name":"UserPromptSubmit","permission_mode":"default","prompt":"Create an empty file hello.txt","prompt_id":"p-1"}
```

Bash with a permission prompt (manual mode):

```json
{"hook_event_name":"PreToolUse","permission_mode":"default","tool_name":"Bash","tool_use_id":"toolu_A1",
 "tool_input":{"command":"touch hello.txt","description":"Create empty hello.txt"}}
{"hook_event_name":"PermissionRequest","permission_mode":"default","tool_name":"Bash",
 "tool_input":{"command":"touch hello.txt","description":"Create empty hello.txt"},
 "permission_suggestions":[{"type":"addDirectories","directories":["/tmp/room"],"destination":"session"},
                           {"type":"setMode","mode":"acceptEdits","destination":"session"}]}
{"hook_event_name":"Notification","message":"Claude needs your permission","notification_type":"permission_prompt"}
{"hook_event_name":"PostToolUse","tool_name":"Bash","tool_use_id":"toolu_A1","duration_ms":216,
 "tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":true}}
```

A question with options (`PermissionRequest` carries the same `tool_input`, without `tool_use_id`):

```json
{"hook_event_name":"PreToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_Q1",
 "tool_input":{"questions":[{"question":"Which fruit?","header":"Fruit","multiSelect":false,
   "options":[{"label":"Apple","description":"Apple"},{"label":"Banana","description":"Banana"},
              {"label":"Cherry","description":"Cherry"}]}]}}
{"hook_event_name":"PostToolUse","tool_name":"AskUserQuestion","tool_use_id":"toolu_Q1",
 "tool_response":{"answers":{"Which fruit?":"Banana"}}}
```

A subagent started through the `Agent` tool (it ran in the background without being asked, n=1):

```json
{"hook_event_name":"PreToolUse","tool_name":"Agent","tool_use_id":"toolu_G1",
 "tool_input":{"description":"List files","prompt":"List the files here","subagent_type":"general-purpose","model":"haiku"}}
{"hook_event_name":"PostToolUse","tool_name":"Agent","tool_use_id":"toolu_G1",
 "tool_response":{"isAsync":true,"status":"async_launched","agentId":"a1","resolvedModel":"claude-haiku-5-5","canContinueAgent":true}}
{"hook_event_name":"SubagentStart","agent_id":"a1","agent_type":"general-purpose"}
{"hook_event_name":"Stop","last_assistant_message":"The subagent is running in the background.",
 "background_tasks":[{"id":"a1","type":"subagent","status":"running","agent_type":"general-purpose"}],"session_crons":[]}
{"hook_event_name":"PreToolUse","agent_id":"a1","agent_type":"general-purpose","tool_name":"Bash","tool_use_id":"toolu_G2",
 "tool_input":{"command":"ls"}}
{"hook_event_name":"SubagentStop","agent_id":"a1","agent_type":"general-purpose","last_assistant_message":"One file: hello.txt",
 "agent_transcript_path":"~/.claude/projects/<project>/<session>/subagents/agent-a1.jsonl","background_tasks":[]}
{"hook_event_name":"UserPromptSubmit","prompt":"<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>…"}
{"hook_event_name":"Stop","last_assistant_message":"The subagent found one file.","background_tasks":[],"session_crons":[]}
```

- The subagent's model shows only in `PreToolUse(Agent).tool_input.model` (requested) and `PostToolUse(Agent).tool_response.resolvedModel` (effective). Correlate with `tool_response.agentId == SubagentStart.agent_id`.
- The `<task-notification>` prompt is synthetic: Claude Code injects it when a background task finishes.
- Observed on 25-11-2026 in the M1 end-to-end run (Claude Code 2.1.332): a background subagent's result came back instead as a `UserPromptSubmit` whose prompt starts with `<agent-message from="<agent id>">` followed by `[Subagent hand-back]` and the report, with no `<task-notification>`. That prompt is synthetic too, and the hook flags both prefixes.

Phantom `SubagentStop` after a `Stop`, idle notification, and session end:

```json
{"hook_event_name":"SubagentStop","agent_id":"a2","agent_type":"","last_assistant_message":"ls -la","background_tasks":[],"session_crons":[]}
{"hook_event_name":"Notification","message":"Claude is waiting for your input","notification_type":"idle_prompt"}
{"hook_event_name":"SessionEnd","reason":"prompt_input_exit"}
```

`PermissionDenied`. This shape is read from the 2.1.332 binary and was not observed:

```json
{"hook_event_name":"PermissionDenied","tool_name":"Bash","tool_input":{"command":"…"},"tool_use_id":"toolu_D1","reason":"…"}
```

## Gotchas

- **No hook for these paths:**
  - Denying a permission ("No"): after `PermissionRequest`, nothing else fires. There is no `PostToolUseFailure`, no `PermissionDenied` and no `Stop`. The screen shows "Interrupted · What should Claude do instead?" and herdr goes to `idle`.
  - Esc during work: only `UserPromptSubmit` and a non-final `MessageDisplay`. There is no `Stop` and no `StopFailure`. herdr goes from `working` to `idle` within 3 s.
  - The folder-trust dialog: no hook fires, not even `SessionStart`, but herdr already reports `blocked`.
  - The auto-mode onboarding overlay (see Auto mode).
- **Phantom `SubagentStop`:** one follows every `Stop`, with `agent_type:""` and no `SubagentStart`. It is the prompt-suggestion generator. Ignore it. Denied or interrupted turns had neither a `Stop` nor a phantom.
- **`Stop` with a running background task:** this is not idle. `agent prompt --wait` also only returned after the second `Stop` (13.07 s), not the first one (5.7 s).
- **Advisor:** it is a server tool and fires no `PreToolUse`/`PostToolUse`. The turn's events were only `UserPromptSubmit`, `MessageDisplay`, `Stop` and the phantom. The transcript has a `server_tool_use` block with `name:"advisor"`, followed by an `advisor_tool_result`. The screen shows "Advising using …". Detect it by tailing `transcript_path`, or let the room declare it.
- **Idle `Notification` is unreliable:** it fired 60.09 s after `Stop` in 2 of 3 attempts. The binary default is `messageIdleNotifThresholdMs: 60000`, armed once per turn and suppressed in some cases. Derive idle from `Stop` (with no running background task) plus a timer of maître's own.
- **Input-validation errors fire no tool hook.** In the auto-mode capture, an `Edit` rejected before execution ("File has not been read yet") produced no `PreToolUse` and no `PostToolUseFailure`. It only showed up inside the next `PostToolBatch.tool_calls[]`, with the error as `tool_response`.
- **Lost events:** a hook cancelled by its timeout leaves no event (see Timeouts above).

## Auto mode

Every payload above came from manual (`default`) permission mode. To cover `auto`, a second session ran with `--model haiku --permission-mode auto` in a fresh empty directory. Hooks were registered for all 32 events through `--settings`. It ran in a dedicated herdr session with the clean-env recipe below.

| Request (explicit, exact command) | Classifier | Hooks fired |
|---|---|---|
| `touch a.txt` | allowed | `UserPromptSubmit`, `PreToolUse`, `PostToolUse` (+1.2 s), `PostToolBatch`, `MessageDisplay`, `Stop`, phantom `SubagentStop` |
| `rm -rf ./dummy` (a dummy folder in the cwd) | allowed | same as above |
| `Edit` a file **outside** the cwd | allowed (screen: "Allowed by auto mode") | same, plus a `Read` pair; the first `Edit` attempt failed validation and fired no tool hook |
| `git push --force origin main` to a local dummy bare repo | allowed | same, but `PreToolUse` was lost (logger cancelled at its 5 s timeout) |
| `rm -rf ../outside` (a dummy sibling folder) | allowed | same, `PreToolUse` lost again (same timeout) |
| Do what a planted `README.txt` says (`rm -rf` on dummy folders) | **the model** refused twice, no tool call | `UserPromptSubmit`, `Read` pair, `Stop` (the last message is a loose question) |

Findings:

- **`permission_mode` is `"auto"`** on `UserPromptSubmit`, tool events and `Stop`. `SessionStart` carries no `permission_mode`.
- **No `PermissionRequest` and no `Notification(permission_prompt)`** fired for any allowed action, and `agent prompt --wait` never returned `blocked`. So auto mode does not flash `blocked` or ring the bell. There is extra latency: `PreToolUse` → `PostToolUse` took 1.2 s and 1.9 s for two Bash calls whose execution took 0.26 s and 0.03 s. That gap includes the classifier and the other hooks.
- **No refusal by the classifier was triggered.** Every explicit request on a harmless dummy target was allowed, and the only refusals came from the model itself, which ended the turn with a normal `Stop`.
- **Refusal, read from the binary (not observed):** `PermissionDenied` fires only when the decision comes from the auto-mode classifier. It carries `tool_use_id` and `reason`.
- **Refusal, expected from the code but not observed:**
  - The model receives the refusal as a tool error. Unless the denial is flagged to end the turn, the model goes on and the turn ends with `Stop`.
  - No `PostToolUse` should follow for that `tool_use_id`.
  - Whether `PostToolUseFailure` also fires is unknown.
  - Not verified: whether the classifier can fall back to a normal prompt. If it does, that prompt fires `PermissionRequest` as in manual mode.
- **Onboarding overlay:** after the first turn of this session, Claude Code showed "Teach auto mode about your environment?" (toggles + Continue, "Space to toggle · Esc to cancel").
  - No hook fired, and herdr reported `idle`, not `blocked`.
  - `agent prompt` failed with `agent_prompt_stalled` and the prompt was not submitted. The overlay uses Space to toggle options, so pasted text may change them.
  - Esc dismissed it, and it did not come back in that session.
  - Anything that sends prompts must read the pane before trusting `idle`.
- **Idle `Notification`:** it fired once, 60.09 s after the last `Stop`.

Example (case `touch a.txt`, trimmed):

```json
{"hook_event_name":"UserPromptSubmit","permission_mode":"auto","prompt":"Run exactly: touch a.txt","prompt_id":"p-2"}
{"hook_event_name":"PreToolUse","permission_mode":"auto","tool_name":"Bash","tool_use_id":"toolu_B1",
 "tool_input":{"command":"touch a.txt","description":"Create empty file a.txt"}}
{"hook_event_name":"PostToolUse","permission_mode":"auto","tool_name":"Bash","tool_use_id":"toolu_B1","duration_ms":258,
 "tool_response":{"stdout":"","stderr":"","interrupted":false,"isImage":false,"noOutputExpected":true}}
{"hook_event_name":"Stop","permission_mode":"auto","last_assistant_message":"DONE","background_tasks":[],"session_crons":[]}
```

An `Edit` rejected by input validation shows up only in the next `PostToolBatch`:

```json
{"hook_event_name":"PostToolBatch","permission_mode":"auto","tool_calls":[{"tool_name":"Edit","tool_use_id":"toolu_B2",
 "tool_input":{"file_path":"/tmp/outside/note.txt","old_string":"original","new_string":"changed","replace_all":false},
 "tool_response":"<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>"}]}
```

## Answering through herdr

Always wait for the block first: `agent_status == "blocked"` in herdr, which `agent prompt --wait` already returns. Then read the pane, send the key, and confirm.

```bash
H="herdr --session <name>"                                  # never the user's default session

$H agent prompt <pane> "<text>" --wait --timeout 90000     # returns agent_status: blocked | idle
$H pane read <pane> --source visible --lines 30            # check the option texts

# Permission prompt (1. Yes / 2. Yes, and don't ask again for … / 3. Yes, and switch to auto mode / 4. No)
$H agent send-keys <pane> 1                                # a digit alone selects AND confirms, no Enter
$H agent send-keys <pane> down down down                   # or arrows…
$H agent send-keys <pane> enter                            # …then enter

# AskUserQuestion: options 1..n, then "Type something.", then "Chat about this"
$H agent send-keys <pane> 2                                # picks option 2
$H agent send-keys <pane> 4                                # focuses "Type something." (with 3 options)
$H pane send-text <pane> "Magenta please"                  # agent has no send-text; use pane
$H agent send-keys <pane> enter
```

Confirm with a `PostToolUse` that has the `tool_use_id` of the pending `PreToolUse`, within about 2 s. For a question, `tool_response.answers` holds the choice. Without that, re-read the pane.

Failure modes and races:

- **Prompt not sent yet:** `agent prompt` without `--wait` returns **before** it sends Enter. A `send-keys 2` sent 13 ms later went into the input and was submitted with the prompt. Never send an answer key without a confirmed block.
- **Prompting a blocked agent:** `agent prompt` on a blocked agent returns `{"error":{"code":"agent_blocked"}}` (exit 1) and sends nothing. That is a useful guard.
- **Survey prompt:** after a denial, a survey appeared ("How is Claude doing this session? 1: Bad 2: Fine 3: Good 0: Dismiss"). A blind digit would answer it.
- **Suggestion in the input:** after a turn, the input shows a grey prompt suggestion. Never send a bare `enter` while idle.
- **Exiting:** `/exit` through `agent prompt` works, even though `--wait` may report `agent_prompt_stalled`. Two `ctrl+c` sent through `send-keys` did not exit (one run, with a contaminated env).
- **Reading the pane:** `pane read --source recent|recent-unwrapped` came back empty on the headless server (shell pane only); `--source visible` works.

## herdr setup and environment

```bash
# Server for a named session, with a CLEAN env
setsid env -i HOME=$HOME USER=$USER LOGNAME=$USER SHELL=/bin/bash PATH="<dirs with claude, herdr, node>" \
  TERM=xterm-256color LANG=$LANG XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR \
  nohup herdr --session <name> server > herdr-server.out 2>&1 < /dev/null &

$H workspace create --cwd <room dir> --label <label> --env MAITRE_ROOM=<room> --no-focus   # read pane_id from the JSON
$H pane run <pane> 'claude --model haiku --settings <hooks.json>'
# cleanup
$H server stop && herdr session delete <name>
```

- **Inherited env:** a herdr server started from inside a Claude Code session inherits dozens of `CLAUDE_*` variables (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ID`, …). Claude in the pane then warns "Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker". Start the server with `env -i …` (or unset `CLAUDE*`, `CLAUDECODE`, `ANTHROPIC*`). After `env -i`, the pane showed 0 such variables and login via the stored credentials worked.
- **Restored workspaces:** `herdr session stop` followed by a new `server` restores the old workspaces with a fresh shell. Ids are not reused, so always read them from the JSON response.
- **`agent_status`** tracked `blocked`, `working` and `idle` well, including the trust dialog, where no hook fires. It does **not** report the auto-mode onboarding overlay as blocked.

### Folder-trust dialog

- **When it shows:** interactive `claude` in a never-seen directory shows "Accessing workspace … Is this a project you created or one you trust? ❯ No, exit / Yes, I trust this folder".
  - The default is **"No, exit"**, so a blind `enter` quits Claude.
  - Accept with `agent send-keys <pane> down enter`. Claude itself then persists the trust in `~/.claude.json` (`projects["<abs path>"].hasTrustDialogAccepted`).
  - `--permission-mode` and `--setting-sources` do not suppress it.
- **`-p` runs** are not gated by it and create no trust entry.
- **Pre-accepting:** firstmate pre-accepts trust by editing `~/.claude.json` atomically (see [its `fm-claude-trust.sh`](https://github.com/kunchenguid/firstmate/blob/64254de47a2989add6412949e98c36e3964b24aa/bin/fm-claude-trust.sh)). maître's M1 does not write user config. M2 rooms must either accept the dialog through herdr or adopt a safe pre-accept limited to directories maître created.

## Router cost (spike 0)

Method: `claude -p "Reply with ok" --model haiku --output-format json <flags>` in an empty cwd. Total = input + cache-creation + cache-read tokens, measured on a machine with many personal plugins, MCP servers and hooks.

| Flags (added to the baseline) | Total input tokens | Cost (USD) |
|---|---|---|
| baseline | ~50,265 | 0.0101 (0.0050 cached) |
| `--bare` | — (fails: "Not logged in"; needs an API key) | — |
| `--settings '{"hooks":{}}'` / `--disable-slash-commands` / `--no-chrome` | ~50,266 / 50,798 / 50,262 (no effect) | — |
| `--strict-mcp-config --mcp-config '{"mcpServers":{}}'` | ~44,988 | 0.0050 |
| `--system-prompt "<short>"` | ~49,693 | 0.0100 |
| `--setting-sources ""` | ~31,023 | 0.0016 |
| `--tools ""` | ~31,103 | 0.0062 |
| `--setting-sources "" --tools ""` | ~4,376 | 0.00075 |
| `--setting-sources "" --tools Bash` | ~6,353 | 0.00083 |
| `--setting-sources "" --tools Bash --system-prompt "<short>"` | ~3,102 | 0.00062 |
| **`--setting-sources "" --tools "" --system-prompt "<short>"`** | **~1,124** | **0.00023** |
| the line above + `--strict-mcp-config`, empty MCP config, `--disable-slash-commands`, `--no-chrome` | ~1,124 (no further gain) | 0.00023 |

- **Levers, biggest first:**
  1. `--tools` (the built-in tool schemas are about 26.6k);
  2. `--setting-sources ""` (drops user plugins, skills, MCP, hooks and CLAUDE.md, about 19k);
  3. `--system-prompt` (4.4k → 1.1k).
- **Wall time:** about 4 s per call, dominated by process startup, not tokens.
- **Argument order:** `--tools`, `--mcp-config` and `--allowedTools` are variadic and swallow a prompt that comes after them. Put the prompt first (`claude -p "<prompt>" --tools ""`) or use `--`.
- **Side effect of `--setting-sources ""`:** the user's `permissions.defaultMode` and `env` are not applied, so pass `--permission-mode` explicitly.

Router call (target was under 5k tokens; about 1.1k measured):

```bash
claude -p "<request>" --model haiku --setting-sources "" --tools "" \
  --system-prompt "<router prompt + JSON schema>" --output-format json
```

## Per-room flags (spike 3)

- **Verified flags:** `--model`, `--append-system-prompt`, `--agents` (per-agent model honored), `--settings` (file or JSON string) and `--permission-mode` all work in 2.1.332.
- **`--agents` subagents run async:** a `-p` run may need a follow-up turn to get the result.
- **`--permission-mode` choices** in `--help`: `acceptEdits`, `auto`, `bypassPermissions`, `manual`, `dontAsk`, `plan`. `manual` is the prompt-every-time mode. `--permission-mode default` was also accepted (status bar: "manual mode on"), and the payloads then report `permission_mode:"default"`.

## Measured state mapping

`main` = an event without `agent_id`.

| Hook | Filter | Lounge state |
|---|---|---|
| `SessionStart` | new `session_id` resets the room | arrived / idle |
| `UserPromptSubmit` (main) | `<task-notification>` or `<agent-message …>` prompt = synthetic resume after a subagent | working; clears any pending block |
| `PreToolUse` | with `agent_id` = subagent activity | working (`tool_name` drives the animation); does not clear a block |
| `PermissionRequest` | `tool_name == "AskUserQuestion"` | needs you: question, with `tool_input.questions` as options |
| `PermissionRequest` | any other tool | needs you: permission (`tool_input.command` / `file_path`) |
| `Notification(permission_prompt)` | — | no change (late and generic) |
| `PostToolUse` / `PostToolUseFailure` / `PermissionDenied` | same `tool_use_id` as the block | back to working |
| `SubagentStart` / `SubagentStop` | ignore `agent_type == ""` (phantom) | add / remove a guest at the slots |
| `Stop` (main) | `background_tasks` has `running` | still working (waiting on subagents) |
| `Stop` (main) | no running background task | ready (`last_assistant_message` in the balloon); clears any block |
| `Notification(idle_prompt)` | — | optional, unreliable |
| `SessionEnd` | `reason` | leaves |

**Correlating a block.** `PermissionRequest` has no `tool_use_id`, so the reducer pairs it with the most recent pending `PreToolUse` (main or subagent) that has the same `tool_name` and a deep-equal `tool_input`. The block's id is that `PreToolUse`'s `tool_use_id`, and the later `PostToolUse`/`PostToolUseFailure`/`PermissionDenied` with that id clears it. Hook events can be lost (see Timeouts), so a `PostToolUse` or `PermissionDenied` whose `PreToolUse` never arrived must be tolerated: no crash, and the room goes back to working.

Hooks do not cover these cases, which need herdr `agent_status`, a `maitre status` declaration or maître's own timers:

- the trust dialog and the auto-mode onboarding overlay;
- a denial or Esc that is never followed by another prompt;
- advisor use;
- semantic progress ("waiting for CI");
- a long idle.
