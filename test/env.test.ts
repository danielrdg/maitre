import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanEnv } from '../src/env.js';

const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT'];
const USER_CONFIG = {
  ANTHROPIC_API_KEY: 'k',
  ANTHROPIC_BASE_URL: 'https://gateway.example',
  ANTHROPIC_MODEL: 'm',
  CLAUDE_CONFIG_DIR: '/cfg',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLAUDE_CODE_OAUTH_TOKEN: 't',
  CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  CLAUDE_CODE_SKIP_VERTEX_AUTH: '1',
};

test('cleanEnv drops only the Claude Code session markers and keeps auth and user config', () => {
  const input: NodeJS.ProcessEnv = { PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/ssh', ...USER_CONFIG };
  for (const k of MARKERS) input[k] = 'outer';
  const out = cleanEnv(input);
  for (const k of MARKERS) assert.equal(out[k], undefined, k);
  assert.deepEqual(out, { PATH: '/usr/bin', SSH_AUTH_SOCK: '/run/ssh', ...USER_CONFIG });
  assert.equal(input.CLAUDECODE, 'outer', 'the input is not modified');
});
