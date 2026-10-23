/**
 * A session record keeps the relay it was first saved on: the persistence
 * layer rebuilds the record without `relay` on every write, and the relay
 * setting may have moved since (an edit in Settings doesn't leave the
 * session), so re-tagging would send the Join dialog to the wrong relay.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { loadSessionRecord, saveSessionRecord, type PersistedSessionRecord } from '../../src/editor/collab/collab-store.js';
import { settings } from '../../src/editor/settings.js';

const rec = (roomId: string): PersistedSessionRecord =>
  ({
    roomId,
    shareCode: 'x',
    role: 'host',
    lastSeq: 0,
    sentVersion: new Uint8Array(),
    snapshot: new Uint8Array(),
    increments: [],
    updatedAt: 1,
  }) as unknown as PersistedSessionRecord;

describe('session record relay', () => {
  it('is the relay in use at the first save, and stays that after the setting moves', async () => {
    settings.set('pairingRelayUrl', 'https://a.example/r/one');
    await saveSessionRecord(rec('room-1'));
    expect((await loadSessionRecord('room-1'))?.relay).toBe('https://a.example/r/one');
    settings.set('pairingRelayUrl', 'https://b.example/r/two');
    await saveSessionRecord(rec('room-1'));
    expect((await loadSessionRecord('room-1'))?.relay).toBe('https://a.example/r/one');
    // A new room takes the relay in use now.
    await saveSessionRecord(rec('room-2'));
    expect((await loadSessionRecord('room-2'))?.relay).toBe('https://b.example/r/two');
    settings.set('pairingRelayUrl', '');
  });
});
