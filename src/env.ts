// Claude Code configuration that happens to share the CLAUDE_CODE_ prefix of its session markers.
const USER_CONFIG = new Set([
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
]);

// The markers of the Claude Code session maître may run from: inherited, they turn transcript saving off.
function isSessionMarker(key: string): boolean {
  return key === 'CLAUDECODE' || (key.startsWith('CLAUDE_CODE_') && !USER_CONFIG.has(key));
}

export function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!isSessionMarker(k)) out[k] = v;
  return out;
}
