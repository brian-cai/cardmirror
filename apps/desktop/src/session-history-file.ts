/**
 * Collab session history files (`{roomId}.cmir-history`) — parsing, and a
 * header-only read for listings.
 *
 * A history file is one JSON envelope whose last key is the base64 Loro
 * snapshot, often most of a tournament master. Listing sessions (Recover
 * Previous Version) only needs the fields before it, so `readHistoryHeader`
 * reads the file's head up to the snapshot key and parses that, instead of
 * reading and parsing every retained file whole (the folder is capped at
 * 500 MB) on the main process.
 */

import { promises as fs } from 'node:fs';

export interface HistoryEnvelopeIpc {
  v: 1;
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  changeTimes: { peer: string; counter: number; at: number }[];
  snapshotB64: string;
}

export interface HistoryHeader {
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
}

export function parseHistoryEnvelope(text: string): HistoryEnvelopeIpc | null {
  try {
    const p = JSON.parse(text) as Partial<HistoryEnvelopeIpc>;
    if (
      p?.v !== 1 ||
      typeof p.roomId !== 'string' ||
      !p.roomId ||
      typeof p.snapshotB64 !== 'string' ||
      !p.snapshotB64 ||
      typeof p.startedAt !== 'number' ||
      typeof p.updatedAt !== 'number' ||
      !Array.isArray(p.changeTimes)
    ) {
      return null;
    }
    return {
      v: 1,
      roomId: p.roomId,
      docTitle: typeof p.docTitle === 'string' ? p.docTitle : 'Untitled',
      startedAt: p.startedAt,
      updatedAt: p.updatedAt,
      changeTimes: p.changeTimes.filter(
        (t): t is { peer: string; counter: number; at: number } =>
          typeof t?.peer === 'string' && typeof t?.counter === 'number' && typeof t?.at === 'number',
      ),
      snapshotB64: p.snapshotB64,
    };
  } catch {
    return null;
  }
}

/** The snapshot key as `JSON.stringify` writes it after another member. It
 *  can't occur inside a string value: a quote there is escaped. */
const SNAPSHOT_KEY = ',"snapshotB64":"';
const HEAD_CHUNK = 64 * 1024;

/** A history file's listing fields, read from its head. Null when the file
 *  isn't a valid v1 envelope. Files written without the snapshot last (none
 *  are, but a hand-edited one could be) fall back to a full parse. */
export async function readHistoryHeader(fullPath: string): Promise<HistoryHeader | null> {
  const handle = await fs.open(fullPath, 'r');
  try {
    const { size } = await handle.stat();
    let head = '';
    let offset = 0;
    const buf = Buffer.alloc(HEAD_CHUNK);
    while (offset < size) {
      const { bytesRead } = await handle.read(buf, 0, HEAD_CHUNK, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      // The keys before the snapshot are ASCII apart from the title; decode
      // the whole prefix again each round so a split character can't garble.
      head += buf.toString('latin1', 0, bytesRead);
      const at = head.indexOf(SNAPSHOT_KEY);
      if (at === -1) continue;
      const valueStart = at + SNAPSHOT_KEY.length;
      if (valueStart >= head.length && offset < size) continue; // need 1 more byte
      if (head[valueStart] === '"') return null; // empty snapshot: invalid, as parse says
      const prefix = Buffer.from(head.slice(0, at), 'latin1').toString('utf8');
      const env = parseHistoryEnvelope(`${prefix},"snapshotB64":"-"}`);
      return env && toHeader(env, size);
    }
    const env = parseHistoryEnvelope(await fs.readFile(fullPath, 'utf8'));
    return env && toHeader(env, size);
  } finally {
    await handle.close();
  }
}

function toHeader(env: HistoryEnvelopeIpc, sizeBytes: number): HistoryHeader {
  return {
    roomId: env.roomId,
    docTitle: env.docTitle,
    startedAt: env.startedAt,
    updatedAt: env.updatedAt,
    sizeBytes,
  };
}
