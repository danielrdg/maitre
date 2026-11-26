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
  synthetic?: boolean;
  status?: 'working' | 'waiting' | 'blocked';
  text?: string;
  options?: string[];
}
