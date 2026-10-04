// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { byFrequency, groupKey, recordSend, sendScores } from '../../src/editor/pairing/send-frequency.js';
import { listRecipientChoices, recipientMatches } from '../../src/editor/pairing/send-to-recipient.js';

const DAY = 24 * 60 * 60 * 1000;
const ANA = 'cmk1.ana';
const BEN = 'cmk1.ben';
const CAL = 'cmk1.cal';

beforeEach(() => localStorage.clear());

describe('send frequency', () => {
  it('counts sends per recipient and per group', () => {
    const t = 1_000_000_000_000;
    recordSend([BEN], undefined, t);
    recordSend([BEN], undefined, t);
    recordSend([ANA, BEN], 'Varsity', t);
    const s = sendScores(t);
    expect(s(BEN)).toBe(3);
    expect(s(ANA)).toBe(1);
    expect(s(groupKey('varsity'))).toBe(1);
    expect(s(CAL)).toBe(0);
  });

  it('fades: recent sends outrank old ones', () => {
    const t = 1_000_000_000_000;
    for (let i = 0; i < 4; i++) recordSend([ANA], undefined, t); // 4 sends, long ago
    recordSend([BEN], undefined, t + 90 * DAY); // 1 send, today
    recordSend([BEN], undefined, t + 90 * DAY);
    const s = sendScores(t + 90 * DAY);
    expect(s(BEN)).toBeGreaterThan(s(ANA));
  });

  it('sorts most-sent first, ties keep their order', () => {
    const score = (k: string) => ({ b: 2, c: 2 } as Record<string, number>)[k] ?? 0;
    expect(byFrequency(['a', 'b', 'c', 'd'], (x) => x, score)).toEqual(['b', 'c', 'a', 'd']);
  });
});

describe('Send to Recipient picker', () => {
  const partners = [
    { code: ANA, name: 'Ana Lopez' },
    { code: BEN, name: 'Kabeer Arora' },
    { code: CAL, name: 'Cal', hidden: true },
  ];
  const groups = [{ id: 'g1', label: 'Varsity', memberCodes: [ANA, BEN] }];

  it('orders people and groups together by sends; hidden last', () => {
    const score = (k: string) => ({ [groupKey('Varsity')]: 5, [BEN]: 2 } as Record<string, number>)[k] ?? 0;
    expect(listRecipientChoices(partners, groups, score).map((c) => c.label)).toEqual([
      'Varsity',
      'Kabeer Arora',
      'Ana Lopez',
      'Cal',
    ]);
  });

  it('with no history keeps contacts, then groups, then hidden', () => {
    expect(listRecipientChoices(partners, groups).map((c) => c.label)).toEqual(['Ana Lopez', 'Kabeer Arora', 'Varsity', 'Cal']);
  });

  it('search matches every word, in any order', () => {
    const [ana, kab] = listRecipientChoices(partners, groups);
    expect(recipientMatches(kab!, 'kab ar')).toBe(true);
    expect(recipientMatches(kab!, 'arora kabeer')).toBe(true);
    expect(recipientMatches(ana!, 'kab')).toBe(false);
  });
});
