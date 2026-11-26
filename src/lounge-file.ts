import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './config.js';
import { maitreHome } from './paths.js';

export interface LoungeInfo {
  port: number;
  token: string;
  pid: number;
}

const PROBE_MS = 2000;
const MAX_PING_BYTES = 4096;

export function loungeFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(maitreHome(env), 'lounge.json');
}

export function readLoungeInfo(env: NodeJS.ProcessEnv = process.env): LoungeInfo | undefined {
  let raw: unknown;
  try {
    raw = readJson(loungeFile(env));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { port, token, pid } = raw as Record<string, unknown>;
  if (!Number.isInteger(port) || (port as number) < 0 || (port as number) > 65535) return undefined;
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return undefined;
  if (!Number.isInteger(pid) || (pid as number) < 0) return undefined;
  return { port: port as number, token, pid: pid as number };
}

export function loungeToken(env: NodeJS.ProcessEnv = process.env): string {
  const existing = readLoungeInfo(env);
  if (existing) return existing.token;
  const token = randomBytes(32).toString('hex');
  writeJsonAtomic(loungeFile(env), { port: 0, token, pid: process.pid });
  return token;
}

// ESRCH: the owner is gone. EPERM: the pid now belongs to another user, so not to our lounge.
function ownProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Sends no token: a port that fails this check may belong to any program.
export function probeLounge(info: LoungeInfo, timeoutMs = PROBE_MS): Promise<boolean> {
  if (!Number.isInteger(info.port) || info.port <= 0 || info.port > 65535 || info.pid <= 0) return Promise.resolve(false);
  if (!ownProcessAlive(info.pid)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(ok);
    };
    const req = request({ host: '127.0.0.1', port: info.port, path: '/api/ping', agent: false }, (res) => {
      if (res.statusCode !== 200) return finish(false);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        body += c;
        if (body.length > MAX_PING_BYTES) finish(false);
      });
      res.on('end', () => {
        try {
          const ping = JSON.parse(body) as { app?: unknown; pid?: unknown } | null;
          finish(ping?.app === 'maitre' && ping.pid === info.pid);
        } catch {
          finish(false);
        }
      });
      res.on('error', () => finish(false));
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    req.on('error', () => finish(false));
    req.end();
  });
}

export async function liveLounge(env: NodeJS.ProcessEnv = process.env): Promise<LoungeInfo | undefined> {
  const info = readLoungeInfo(env);
  if (!info || !(await probeLounge(info))) return undefined;
  return info;
}

export function claimLounge(port: number, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(loungeFile(env), { port, token: loungeToken(env), pid: process.pid });
}

// Keeps the token so a restart leaves open windows' cookies valid; pid 0 never passes the probe.
export function releaseLounge(env: NodeJS.ProcessEnv = process.env): void {
  const info = readLoungeInfo(env);
  if (info?.pid === process.pid) writeJsonAtomic(loungeFile(env), { ...info, pid: 0 });
}
