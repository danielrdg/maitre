import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './config.js';
import type { HookLine } from './events.js';
import { roomDir } from './paths.js';
import { BRIEF_HEADER } from './room-state.js';
import type { RoomRecord } from './rooms.js';

export interface PrNotice {
  kind: 'ci' | 'review' | 'merged' | 'closed';
  text: string;
  url: string;
  since: number;
}

export interface PrState {
  url: string;
  number: number;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  headRefName: string;
  seenAt: number;
  failing: string[];
  lastFeedbackAt?: string;
  // The feedback seen at exactly lastFeedbackAt (gh's times have a one-second resolution).
  lastFeedbackKeys?: string[];
  reviewDecision?: string;
  notice?: PrNotice;
  dance?: { until: number };
}

// How every line pr.autoWake sends a room starts.
export const NOTICE_PROMPT = 'maître PR notice (';

// The room's next real prompt reads a notice: the main agent's, not synthetic, and not autoWake telling it
// (a fresh Claude's brief, after its header, starts with the same lines).
export function readsNotice(line: Pick<HookLine, 'event' | 'agent_id' | 'synthetic' | 'prompt'>): boolean {
  if (line.event !== 'UserPromptSubmit' || line.agent_id !== undefined || line.synthetic === true) return false;
  if (typeof line.prompt !== 'string') return true;
  const p = line.prompt.startsWith(BRIEF_HEADER) ? line.prompt.slice(BRIEF_HEADER.length) : line.prompt;
  return !p.trimStart().startsWith(NOTICE_PROMPT);
}

function prFile(room: string, env: NodeJS.ProcessEnv): string {
  return join(roomDir(room, env), 'pr.json');
}

export function prSeekFile(room: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(roomDir(room, env), 'pr-seek.json');
}

// A new opening of a room name starts with no PR: what an earlier opening watched is not its PR.
export function dropPrState(room: string, env: NodeJS.ProcessEnv = process.env): void {
  rmSync(prFile(room, env), { force: true });
  rmSync(prSeekFile(room, env), { force: true });
}

const NOTICE_KINDS = ['ci', 'review', 'merged', 'closed'];

function finite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function notice(v: unknown): PrNotice | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined;
  const n = v as Record<string, unknown>;
  if (typeof n.kind !== 'string' || !NOTICE_KINDS.includes(n.kind)) return undefined;
  if (typeof n.text !== 'string' || typeof n.url !== 'string' || !finite(n.since)) return undefined;
  return { kind: n.kind as PrNotice['kind'], text: n.text, url: n.url, since: n.since };
}

// Missing, unreadable or malformed: no state, never an error (the poller rewrites it on its next pass).
// A bad optional field is dropped, so readers never guard against it.
export function readPr(room: string, env: NodeJS.ProcessEnv = process.env): PrState | undefined {
  let raw: unknown;
  try {
    raw = readJson(prFile(room, env));
  } catch {
    return undefined;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.url !== 'string' || !finite(p.number)) return undefined;
  if (p.state !== 'OPEN' && p.state !== 'MERGED' && p.state !== 'CLOSED') return undefined;
  if (typeof p.headRefName !== 'string' || !finite(p.seenAt) || !Array.isArray(p.failing)) return undefined;
  const pr: PrState = {
    url: p.url,
    number: p.number,
    state: p.state,
    headRefName: p.headRefName,
    seenAt: p.seenAt,
    failing: p.failing.filter((f): f is string => typeof f === 'string'),
  };
  if (typeof p.lastFeedbackAt === 'string') pr.lastFeedbackAt = p.lastFeedbackAt;
  if (Array.isArray(p.lastFeedbackKeys)) pr.lastFeedbackKeys = p.lastFeedbackKeys.filter((k): k is string => typeof k === 'string');
  if (typeof p.reviewDecision === 'string') pr.reviewDecision = p.reviewDecision;
  const n = notice(p.notice);
  if (n !== undefined) pr.notice = n;
  const d = p.dance;
  if (typeof d === 'object' && d !== null && finite((d as Record<string, unknown>).until)) pr.dance = { until: (d as { until: number }).until };
  return pr;
}

export function writePr(room: string, pr: PrState, env: NodeJS.ProcessEnv = process.env): void {
  writeJsonAtomic(prFile(room, env), pr);
}

// Read-modify-write against pr.json as it is now, so a change written meanwhile (a notice, a merge) is
// kept. Nothing is written when the file is gone or `fn` returns undefined.
export function patchPr(room: string, fn: (pr: PrState) => PrState | undefined, env: NodeJS.ProcessEnv = process.env): PrState | undefined {
  const fresh = readPr(room, env);
  if (fresh === undefined) return undefined;
  const next = fn(fresh);
  if (next !== undefined) writePr(room, next, env);
  return next;
}

// A pr.json of this opening of the room: one an earlier room of the same name left (on another branch,
// or last seen before this one opened) says nothing about it.
export function ownsPr(rec: Pick<RoomRecord, 'branch' | 'createdAt'>, pr: Pick<PrState, 'headRefName' | 'seenAt'>): boolean {
  return pr.headRefName === rec.branch && pr.seenAt >= rec.createdAt;
}

export function roomPr(rec: Pick<RoomRecord, 'room' | 'branch' | 'createdAt'>, env: NodeJS.ProcessEnv = process.env): PrState | undefined {
  const pr = readPr(rec.room, env);
  return pr !== undefined && ownsPr(rec, pr) ? pr : undefined;
}
