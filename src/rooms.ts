import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './config.js';
import { maitreHome, roomDir } from './paths.js';

export interface RoomRecord {
  room: string;
  project?: string;
  kind: 'code' | 'scratch';
  dir: string;
  branch?: string;
  model: string;
  taskType: string;
  herdr?: { session: string; workspaceId: string; paneId: string };
  createdAt: number;
  closedAt?: number;
}

function roomFile(room: string, env: NodeJS.ProcessEnv): string {
  return join(roomDir(room, env), 'room.json');
}

export function readRoom(room: string, env: NodeJS.ProcessEnv = process.env): RoomRecord | undefined {
  return readJson(roomFile(room, env)) as RoomRecord | undefined;
}

export function writeRoom(rec: RoomRecord, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(roomFile(rec.room, env), rec);
}

export function listRooms(env: NodeJS.ProcessEnv = process.env): RoomRecord[] {
  const root = join(maitreHome(env), 'state', 'rooms');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const out: RoomRecord[] = [];
  for (const name of names.sort()) {
    const file = join(root, name, 'room.json');
    if (!existsSync(file)) continue;
    try {
      const rec = readJson(file);
      if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) out.push(rec as RoomRecord);
    } catch {
      continue;
    }
  }
  return out;
}
