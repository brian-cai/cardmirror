// @vitest-environment jsdom
/** Contacts tied to relays: the Send pill and pickers offer the contacts on
 *  the relay cards go through now; untagged contacts (old ones, team files,
 *  the original app's) stay on every relay. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_RELAY_TAG,
  groupsHere,
  newContact,
  onRelay,
  partnersElsewhere,
  partnersHere,
  relayTag,
  tagImported,
} from '../../src/editor/pairing/contact-relays.js';
import { SendPillController } from '../../src/editor/pairing/send-pill-ui.js';
import { sanitizePairingPartners, settings } from '../../src/editor/settings.js';

const HS = 'https://relay.example.test/r/highschool';
const COLLEGE = 'https://relay.example.test/r/college';

afterEach(() => {
  document.body.innerHTML = '';
  settings.set('pairingEnabled', false);
  settings.set('pairingRelayUrl', '');
  settings.set('pairingPartners', []);
  settings.set('pairingGroups', []);
});

describe('relay tags', () => {
  it('normalizes the URL: trailing slashes, host case; empty is the built-in relay', () => {
    expect(relayTag('HTTPS://Relay.Example.TEST/r/HighSchool/ ')).toBe('https://relay.example.test/r/HighSchool');
    expect(relayTag('')).toBe(BUILTIN_RELAY_TAG);
  });

  it('untagged contacts are on every relay', () => {
    expect(onRelay({}, relayTag(HS))).toBe(true);
    expect(onRelay({ relays: [] }, BUILTIN_RELAY_TAG)).toBe(true);
    expect(onRelay({ relays: [relayTag(HS)] }, relayTag(COLLEGE))).toBe(false);
    expect(onRelay({ relays: [relayTag(HS), relayTag(COLLEGE)] }, relayTag(COLLEGE))).toBe(true);
  });

  it('new contacts get the custom relay; on the built-in relay they stay untagged', () => {
    settings.set('pairingRelayUrl', HS);
    expect(newContact('cmk1.a', 'Ari')).toEqual({ code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS)] });
    settings.set('pairingRelayUrl', '');
    expect(newContact('cmk1.a', 'Ari')).toEqual({ code: 'cmk1.a', name: 'Ari' });
  });

  it('filters contacts and groups to the current relay', () => {
    settings.set('pairingPartners', [
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS)] },
      { code: 'cmk1.b', name: 'Bo', relays: [relayTag(COLLEGE)] },
      { code: 'cmk1.c', name: 'Cy' },
    ]);
    settings.set('pairingGroups', [
      { id: 'g1', label: 'HS varsity', memberCodes: ['cmk1.a'] },
      { id: 'g2', label: 'College', memberCodes: ['cmk1.b'] },
    ]);
    settings.set('pairingRelayUrl', HS);
    expect(partnersHere().map((p) => p.name)).toEqual(['Ari', 'Cy']);
    expect(partnersElsewhere()).toBe(1);
    expect(groupsHere().map((g) => g.label)).toEqual(['HS varsity']);
    settings.set('pairingRelayUrl', COLLEGE);
    expect(partnersHere().map((p) => p.name)).toEqual(['Bo', 'Cy']);
  });
});

describe('team list import tags', () => {
  const tag = relayTag(COLLEGE);
  it('new people get the relay; tagged people gain it; untagged people stay on every relay', () => {
    const before = [
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS)] },
      { code: 'cmk1.c', name: 'Cy' },
    ];
    const merged = [...before, { code: 'cmk1.b', name: 'Bo' }, { code: 'cmk1.z', name: 'Not listed' }];
    const out = tagImported(merged, before, ['cmk1.a', 'cmk1.b', 'cmk1.c'], tag);
    expect(out).toEqual([
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS), tag] },
      { code: 'cmk1.c', name: 'Cy' },
      { code: 'cmk1.b', name: 'Bo', relays: [tag] },
      { code: 'cmk1.z', name: 'Not listed' },
    ]);
  });
});

describe('settings round trip (original app compatibility)', () => {
  it('keeps relays, and a contact without them loads unchanged', () => {
    expect(sanitizePairingPartners([
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS), relayTag(HS), ''] },
      { code: 'cmk1.c', name: 'Cy', relays: 'not a list' },
    ])).toEqual([
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS)] },
      { code: 'cmk1.c', name: 'Cy' },
    ]);
  });
});

describe('send pill', () => {
  it('lists the contacts on this relay and says how many are elsewhere', () => {
    settings.set('pairingEnabled', true);
    settings.set('pairingRelayUrl', HS);
    settings.set('pairingPartners', [
      { code: 'cmk1.a', name: 'Ari', relays: [relayTag(HS)] },
      { code: 'cmk1.b', name: 'Bo', relays: [relayTag(COLLEGE)] },
    ]);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    new SendPillController().mount({ parent });
    const text = parent.querySelector('.pmd-send-panel')!.textContent ?? '';
    expect(text).toContain('Ari');
    expect(text).not.toContain('Bo');
    expect(text).toContain('1 contact is on other relays');
  });
});
