// UserPromptSubmit hook for the maître reception: stores the user's message as
// $MAITRE_HOME/reception/requests/<n>.md (next free integer, created exclusively, 0600) and tells
// the model its id, so the reception only ever passes ids to `maitre`. It never blocks the
// prompt: always exit 0, and print nothing unless the message was stored.
// Registered for SessionStart too: it then only writes $MAITRE_HOME/reception/session-started,
// which tells `maitre` that this Claude got past the folder-trust dialog.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { storeRequest, unwrapPasted } from './requests.mjs';

// Prompts Claude Code injects itself (a background task or subagent reporting back), not the user's.
const SYNTHETIC = /^(?:<task-notification>|<agent-message[\s>])/;

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const home = process.env.MAITRE_HOME ? resolve(process.env.MAITRE_HOME) : join(homedir(), '.maitre');
  const raw = input?.prompt;
  if (input?.hook_event_name === 'SessionStart') {
    const dir = join(home, 'reception');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'session-started'), String(input.session_id ?? ''), { mode: 0o600 });
  } else if (typeof raw === 'string' && raw.trim() !== '' && !SYNTHETIC.test(raw)) {
    const text = unwrapPasted(raw);
    const id = storeRequest(home, text);
    if (id !== undefined) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `This message is request ${id}.` } }),
      );
    }
  }
} catch {
  // Never block the user's message.
}
process.exitCode = 0;
