import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentInfo, readPane, sendKeys } from './herdr.js';
import { maitreHome } from './paths.js';

// no-agent: no Claude in the pane at the deadline (never started, or exited); unresolved: an agent
// is there, but neither the dialog went away nor SessionStart was seen in time; needs-you: the
// dialog is up in a worktree, for the user to answer.
export type TrustResult = 'accepted' | 'not-shown' | 'unresolved' | 'no-agent' | 'needs-you';

// The dialog's own option lines (default "No, exit"), not the phrase anywhere on screen: a brief may quote it.
const OPTION = (label: string) => new RegExp(`^[\\s│|]*(?:❯\\s*)?(?:\\d+\\.\\s*)?${label}[\\s│|]*$`, 'm');
const YES = OPTION('Yes, I trust this folder');
const NO = OPTION('No, exit');

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(real(root), target);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

// answer: maître's own folders. ask: a worktree, whose trust Claude Code records on the user's main
// clone, so only the user may give it. outside: never looked at.
export type TrustScope = 'answer' | 'ask' | 'outside';

export function trustScope(dir: string, env: NodeJS.ProcessEnv = process.env): TrustScope {
  const target = real(dir);
  const home = maitreHome(env);
  if (relative(real(join(home, 'reception')), target) === '' || inside(join(home, 'scratch'), target)) return 'answer';
  return inside(join(home, 'worktrees'), target) ? 'ask' : 'outside';
}

// herdr reports a starting Claude as idle long before it draws anything, so idle never settles.
// `started` says whether this launch's SessionStart hook has run: it fires only once trust has
// passed or was never needed.
export async function handleTrust(
  paneId: string,
  dir: string,
  opts: { timeoutMs?: number; pollMs?: number; env?: NodeJS.ProcessEnv; started?: () => boolean } = {},
): Promise<TrustResult> {
  const scope = trustScope(dir, opts.env);
  if (scope === 'outside') return 'not-shown';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let sent = false;
  let checkedAfterSend = false;
  let seenAgent = false;
  let missing = 0;
  for (;;) {
    const info = await agentInfo(paneId);
    if (info.status === 'gone') return 'no-agent';
    const hasAgent = info.agent !== undefined || info.status !== 'unknown';
    // An agent missing twice in a row before anything was answered has exited; once may be herdr catching up.
    missing = seenAgent && !hasAgent ? missing + 1 : 0;
    if (!sent && missing >= 2) return 'no-agent';
    seenAgent ||= hasAgent;
    if (sent) {
      const screen = await readPane(paneId);
      if (!(YES.test(screen) && NO.test(screen)) && info.status !== 'unknown') return 'accepted';
      checkedAfterSend = true;
    } else if (info.status === 'working') {
      // The dialog only comes before the first turn, so a later prompt is never answered here.
      return 'not-shown';
    } else if (opts.started?.() === true) {
      return 'not-shown';
    } else if (info.status === 'blocked') {
      const screen = await readPane(paneId);
      if (YES.test(screen) && NO.test(screen)) {
        if (scope === 'ask') return 'needs-you';
        await sendKeys(paneId, 'down', 'enter');
        sent = true;
      }
    }
    if (Date.now() >= deadline && (!sent || checkedAfterSend)) return sent || hasAgent ? 'unresolved' : 'no-agent';
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
