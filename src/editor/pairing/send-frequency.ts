/**
 * How often you send to each recipient — orders the Send pill and the Send
 * to Recipient picker, most-sent first.
 *
 * A decaying score per key (a partner's code, or `group:<label>` for a
 * group send): each send adds 1, and the score halves every three weeks, so
 * the order follows who you send to LATELY (a new partnership rises within a
 * day or two; last season's fades). Per-machine convenience state in
 * localStorage — never synced, never exported.
 */
import { normalizePairingCode } from './pairing-ids.js';

const STORAGE_KEY = 'pmd-send-frequency';
const HALF_LIFE_MS = 21 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 300;

interface Entry {
  /** Score as of `t`. */
  s: number;
  /** When `s` was last updated (ms). */
  t: number;
}

type Table = Record<string, Entry>;

function load(): Table {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Table) : {};
  } catch {
    return {};
  }
}

function save(table: Table): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
  } catch {
    /* storage full / disabled — ordering just stays as is */
  }
}

function decayed(e: Entry | undefined, now: number): number {
  if (!e || !Number.isFinite(e.s) || !Number.isFinite(e.t)) return 0;
  return e.s * Math.pow(0.5, Math.max(0, now - e.t) / HALF_LIFE_MS);
}

export function groupKey(label: string): string {
  return `group:${label.trim().toLowerCase()}`;
}

/** Record one delivered send: every recipient code, plus the group it went
 *  through (`via`, the group's label) when there was one. */
export function recordSend(codes: readonly string[], via?: string, now = Date.now()): void {
  const table = load();
  const keys = new Set(codes.map(normalizePairingCode).filter(Boolean));
  if (via && via.trim()) keys.add(groupKey(via));
  for (const k of keys) table[k] = { s: decayed(table[k], now) + 1, t: now };
  // Keep the table small: drop the weakest entries past the cap.
  const all = Object.entries(table);
  if (all.length > MAX_ENTRIES) {
    all.sort((a, b) => decayed(b[1], now) - decayed(a[1], now));
    save(Object.fromEntries(all.slice(0, MAX_ENTRIES)));
    return;
  }
  save(table);
}

/** Current score per key (0 for never / long ago). */
export function sendScores(now = Date.now()): (key: string) => number {
  const table = load();
  return (key) => decayed(table[key], now);
}

/** Stable sort by score, highest first (ties keep their original order). */
export function byFrequency<T>(items: readonly T[], keyOf: (item: T) => string, score: (key: string) => number): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(keyOf(item)) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}
