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

/** Who and what a session was (mirrors the renderer's HistoryInfo). */
export interface HistoryInfoIpc {
  role?: 'host' | 'participant' | 'spectator';
  startedBy?: string;
  people?: string[];
  fileName?: string;
  filePath?: string;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;

/** Keep only well-formed info fields (the file is ours, but a torn or
 *  hand-edited one must not put junk in the dialog). */
export function sanitizeHistoryInfo(raw: unknown): HistoryInfoIpc | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: HistoryInfoIpc = {};
  if (r['role'] === 'host' || r['role'] === 'participant' || r['role'] === 'spectator') out.role = r['role'];
  const startedBy = str(r['startedBy'], 80);
  if (startedBy) out.startedBy = startedBy;
  if (Array.isArray(r['people'])) {
    const people = r['people'].map((x) => str(x, 80)).filter((x): x is string => !!x).slice(0, 60);
    if (people.length) out.people = people;
  }
  const fileName = str(r['fileName'], 260);
  if (fileName) out.fileName = fileName;
  const filePath = str(r['filePath'], 4096);
  if (filePath) out.filePath = filePath;
  return Object.keys(out).length ? out : undefined;
}

export interface HistoryEnvelopeIpc {
  v: 1;
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  changeTimes: { peer: string; counter: number; at: number }[];
  info?: HistoryInfoIpc;
  snapshotB64: string;
}

export interface HistoryHeader {
  roomId: string;
  docTitle: string;
  startedAt: number;
  updatedAt: number;
  sizeBytes: number;
  info?: HistoryInfoIpc;
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
    const info = sanitizeHistoryInfo(p.info);
    return {
      v: 1,
      roomId: p.roomId,
      ...(info ? { info } : {}),
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
 *  isn't a valid v1 envelope. Anything the head cannot vouch for (the
 *  snapshot not last, a head that does not parse, a file that does not end
 *  as an envelope) falls back to a full parse. */
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
      // The head stands for the file only when the head parses AND the file
      // ends as a whole envelope does. Otherwise let the full parse decide:
      // it lists a valid file whose head we cut in the wrong place (the key
      // text inside a nested value), and it rejects a file torn at the end
      // — listed from its head, that one would fail only when opened.
      if (env && (await endsLikeAnEnvelope(handle, size))) return toHeader(env, size);
      break;
    }
    const env = parseHistoryEnvelope(await fs.readFile(fullPath, 'utf8'));
    return env && toHeader(env, size);
  } finally {
    await handle.close();
  }
}

/** `JSON.stringify` ends the envelope with the snapshot's closing quote and
 *  the object's brace. */
async function endsLikeAnEnvelope(handle: fs.FileHandle, size: number): Promise<boolean> {
  if (size < 2) return false;
  const tail = Buffer.alloc(2);
  const { bytesRead } = await handle.read(tail, 0, 2, size - 2);
  return bytesRead === 2 && tail.toString('latin1') === '"}';
}

function toHeader(env: HistoryEnvelopeIpc, sizeBytes: number): HistoryHeader {
  return {
    roomId: env.roomId,
    docTitle: env.docTitle,
    startedAt: env.startedAt,
    updatedAt: env.updatedAt,
    sizeBytes,
    ...(env.info ? { info: env.info } : {}),
  };
}
