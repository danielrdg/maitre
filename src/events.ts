export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'SessionEnd',
  'PermissionDenied',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

// A wake's mark on a resumed Claude herdr does not show yet: only the still-starting guard reads it.
export const UNSEEN_EVENT = 'MaitreUnseen';

// Claude Code's own reminders (the idle one comes about a minute after Stop) are not the room doing
// anything: they never reset the idle clock, make a couch stale or abort a close. Nor is maître's unseen mark.
export function countsAsActivity(line: Pick<HookLine, 'event'>): boolean {
  return line.event !== 'Notification' && line.event !== UNSEEN_EVENT;
}

export interface HookLine {
  v: 1;
  ts: number;
  room: string;
  session: string;
  event: string;
  agent_id?: string;
  agent_type?: string;
  tool?: string;
  tool_use_id?: string;
  input?: unknown;
  response?: {
    agentId?: string;
    resolvedModel?: string;
    stdout?: string;
    answers?: Record<string, string>;
    is_error?: boolean;
  };
  notification_type?: string;
  message?: string;
  last_message?: string;
  background_running?: number;
  model?: string;
  prompt?: string;
  transcript?: string;
  synthetic?: boolean;
  status?: 'working' | 'waiting' | 'blocked';
  // MaitreStatus written by maître while a room starts: the room's SessionStart clears it.
  starting?: boolean;
  // On a starting note: the session the start resumes (a wake); none for a fresh open.
  resumes?: string;
  // On MaitreExit: the id of the `maitre room run` that ended (`--run`), when it was given one. On a
  // wake's starting note: the run it started, whose exit line alone ends the start.
  run?: string;
  text?: string;
  options?: string[];
}
