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

// Claude Code's own reminders (the idle one comes about a minute after Stop) are not the room doing
// anything: they never reset the idle clock, make a couch stale or abort a close.
export function countsAsActivity(line: Pick<HookLine, 'event'>): boolean {
  return line.event !== 'Notification';
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
  text?: string;
  options?: string[];
}
