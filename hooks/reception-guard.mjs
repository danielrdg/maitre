// PreToolUse hook for the maître reception: the reception may only run a short allowlist of
// id-only `maitre` commands, written exactly. Every other tool or command is denied. It fails
// closed: a deny decision on stdout with exit 0, or exit 2 (also a block) if even that fails.
// Any other non-zero exit would let the tool run.
import { readFileSync } from 'node:fs';

const ID = '[0-9]{1,12}';
const SLUG = '[a-z0-9][a-z0-9-]{0,39}';
const ALLOW = [
  new RegExp(`^maitre route ${ID}(?: ${ID}){0,31}$`),
  new RegExp(`^maitre dispatch ${ID}$`),
  /^maitre room list$/,
  new RegExp(`^maitre room close ${SLUG}$`),
  /^maitre projects$/,
];
const PREFIX = 'maître reception guard:';
const COMMANDS =
  'maitre route <id> [<id>...] (at most 32 ids), maitre dispatch <id>, maitre room list, maitre room close <slug>, maitre projects';

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `${PREFIX} ${reason}` },
    }),
  );
}

function decide(raw) {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return 'malformed hook input; nothing may run.';
  }
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return 'malformed hook input; nothing may run.';
  const tool = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 64) : '?';
  if (tool !== 'Bash') return `the ${tool} tool is not allowed. The reception only runs: ${COMMANDS}.`;
  const ti = input.tool_input;
  if (ti === null || typeof ti !== 'object' || Array.isArray(ti) || typeof ti.command !== 'string') {
    return 'malformed Bash input; nothing may run.';
  }
  if (ti.run_in_background === true) return 'commands may not run in the background.';
  if (ALLOW.some((re) => re.test(ti.command))) return undefined;
  return `only these exact commands may run (digit ids, lowercase slugs, single spaces, nothing else on the line): ${COMMANDS}. Never put the user's words in a command.`;
}

try {
  const reason = decide(readFileSync(0, 'utf8'));
  if (reason !== undefined) deny(reason);
  process.exitCode = 0;
} catch {
  process.exitCode = 2;
  process.stderr.write(`${PREFIX} internal error; nothing may run.\n`);
}
