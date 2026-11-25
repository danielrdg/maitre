import { spawn, spawnSync } from 'node:child_process';

function hasBinary(name: string): boolean {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

export function openApp(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  const attempts: [string, string[]][] = [
    ...['google-chrome', 'chromium', 'chromium-browser'].map((b): [string, string[]] => [b, [`--app=${url}`]]),
    ['xdg-open', [url]],
  ];
  for (const [bin, args] of attempts) {
    if (!hasBinary(bin)) continue;
    const child = spawn(bin, args, { stdio: 'ignore', detached: true, env });
    child.on('error', () => {});
    child.unref();
    return true;
  }
  return false;
}
