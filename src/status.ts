import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { HookLine } from './events.js';
import { roomDir, roomSlug } from './paths.js';

export const STATUSES = ['working', 'waiting', 'blocked'] as const;
export type RoomStatus = (typeof STATUSES)[number];

const MAX_TEXT = 500;
const MAX_OPTIONS = 10;
const MAX_OPTION = 100;

type Extra = Omit<HookLine, 'v' | 'ts' | 'room' | 'session' | 'event'>;

function clip(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : chars.slice(0, max - 1).join('') + '…';
}

// Same file, modes and single append as hooks/maitre-hook.mjs, so the tail reads both alike.
export function appendRoomLine(room: string, event: string, extra: Extra = {}, env: NodeJS.ProcessEnv = process.env): void {
  const slug = roomSlug(room);
  const line: HookLine = { v: 1, ts: Date.now(), room: slug, session: '', event, ...extra };
  const dir = roomDir(slug, env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(line) + '\n', { mode: 0o600 });
}

export function runStatus(status: RoomStatus, text: string, options: string[], env: NodeJS.ProcessEnv = process.env): number {
  const room = env.MAITRE_ROOM ?? '';
  try {
    roomSlug(room);
  } catch {
    console.error('maitre: not inside a maître room (MAITRE_ROOM is not set); start one with `maitre room run <name>`');
    return 1;
  }
  try {
    appendRoomLine(room, 'MaitreStatus', {
      status,
      text: clip(text, MAX_TEXT),
      options: options.slice(0, MAX_OPTIONS).map((o) => clip(o, MAX_OPTION)),
    }, env);
  } catch (err) {
    console.error(`maitre: could not record the status: ${(err as Error).message}`);
    return 1;
  }
  return 0;
}
