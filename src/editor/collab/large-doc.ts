/**
 * Large-document warnings for co-editing.
 *
 * Sharing cost grows with document size, and past a point it is felt by
 * everyone in the session (measured 2026-10-05 on real debate files):
 *
 *   - Past ~1.2M characters the CRDT copy no longer fits in one relay
 *     update, so the seed ships as chunks and every joiner replays it op
 *     by op — 7 s for a 3.5M-character file, 30 s–2 min for 10M —
 *     until the room's first compaction snapshot lands. Each keystroke
 *     also costs more (~20 ms at 3.5M characters, ~40 ms at 10M).
 *   - Past ~7.5M characters the compaction snapshot is over the relay's
 *     snapshot cap, so the room never compacts: joins stay slow, and the
 *     host's periodic snapshot attempt freezes it for seconds and fails.
 *
 * Share is warned from the document's size (O(1): `content.size` is about
 * one position per character); join, which can't see the document before
 * downloading it, is warned from the downloaded sync data's size, before
 * the expensive import.
 */
import type { Node as PMNode } from 'prosemirror-model';

export type DocSizeClass = 'normal' | 'large' | 'huge';

/** Document positions (≈ characters) past which sharing is warned. */
export const LARGE_DOC_POSITIONS = 1_200_000;
export const HUGE_DOC_POSITIONS = 7_500_000;

/** Sync-data bytes on join with the same meanings: one relay update's
 *  worth (the seed was chunked), and the relay's snapshot cap. */
export const LARGE_SYNC_BYTES = 4_500_000;
export const HUGE_SYNC_BYTES = 28_000_000;

export function docSizeClass(doc: PMNode): DocSizeClass {
  const n = doc.content.size;
  return n >= HUGE_DOC_POSITIONS ? 'huge' : n >= LARGE_DOC_POSITIONS ? 'large' : 'normal';
}

export function syncSizeClass(bytes: number): DocSizeClass {
  return bytes >= HUGE_SYNC_BYTES ? 'huge' : bytes >= LARGE_SYNC_BYTES ? 'large' : 'normal';
}

/** "about 240,000 words" — rough (≈6 characters per word with spacing). */
function wordsLabel(positions: number): string {
  const words = positions / 6;
  const rounded = words >= 1_000_000 ? `${(words / 1_000_000).toFixed(1)} million` : (Math.round(words / 10_000) * 10_000).toLocaleString('en-US');
  return `about ${rounded} words`;
}

/** Where people can merge copies they edited separately — the reassurance
 *  that "everyone keeps their own copy" is a fine alternative. */
export const MERGE_COPIES_LINK = {
  label: 'extinction.gg/conflictingdocx',
  url: 'https://extinction.gg/conflictingdocx',
};

const HUGE_NOTE =
  '\n\nAt this size the relay can’t keep a compact copy of the session, so joins stay slow for as long as it runs, and your app may pause for a few seconds now and then while it tries.';

/** Confirm-dialog body for starting a session on a large document. */
export function shareWarning(doc: PMNode): string | null {
  const cls = docSizeClass(doc);
  if (cls === 'normal') return null;
  return (
    `This is a ${cls === 'huge' ? 'very large' : 'large'} document (${wordsLabel(doc.content.size)}). Sharing it works, but:\n` +
    '• partners may wait from several seconds to over a minute to join\n' +
    '• typing can lag for everyone while the session is open' +
    (cls === 'huge' ? HUGE_NOTE : '') +
    '\n\nFor a smoother session, share a smaller document with just the part you need. ' +
    'It’s also fine for everyone to keep their own copy and edit separately: conflicting copies can be merged afterward at'
  );
}

/** Confirm-dialog body for joining a session whose sync data is large. */
export function joinWarning(bytes: number): string | null {
  const cls = syncSizeClass(bytes);
  if (cls === 'normal') return null;
  const mb = Math.round(bytes / 1_000_000);
  return (
    `This shared document is ${cls === 'huge' ? 'very large' : 'large'} (about ${mb} MB to open). Joining works, but:\n` +
    '• opening it can take from several seconds to over a minute, and the app is unresponsive meanwhile\n' +
    '• typing can lag while you’re in the session' +
    (cls === 'huge' ? HUGE_NOTE : '') +
    '\n\nYou can also ask for a copy and work on it separately: conflicting copies can be merged afterward at'
  );
}
