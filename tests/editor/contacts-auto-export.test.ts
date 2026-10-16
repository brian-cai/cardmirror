// @vitest-environment jsdom
/**
 * Contacts auto-export (rewrites the chosen .cmteam after each local
 * contacts/groups change) and Add-to-contacts from a received invite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const writes = vi.hoisted(() => [] as Array<{ path: string; text: string }>);

vi.mock('../../src/editor/host/index.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/host/index.js')>();
  return {
    ...mod,
    getElectronHost: () => ({
      writeFileAtPath: async (path: string, bytes: Uint8Array) => {
        writes.push({ path, text: new TextDecoder().decode(bytes) });
      },
    }),
  };
});

const prompt = vi.hoisted(() => ({ answer: null as string | null }));
vi.mock('../../src/editor/text-prompt.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/text-prompt.js')>();
  return { ...mod, promptForText: async () => prompt.answer };
});

import { settings } from '../../src/editor/settings.js';
import {
  contactsFileText,
  installContactsAutoExport,
  writeContactsFile,
} from '../../src/editor/pairing/contacts-auto-export.js';
import { parseTeamFile } from '../../src/editor/pairing/team-file.js';
import {
  addSenderAsContact,
  canAddSenderAsContact,
} from '../../src/editor/pairing/receive-pill-ui.js';

const ME = 'cmk1.MEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEM';
const ANA = 'cmk1.ANAANAANAANAANAANAANAANAANAANAANAANAANAANA';
const BEN = 'cmk1.BENBENBENBENBENBENBENBENBENBENBENBENBENBEN';

beforeEach(() => {
  vi.useFakeTimers();
  writes.length = 0;
  settings.set('pairingOwnCode', ME);
  settings.set('pairingDisplayName', 'Coach');
  settings.set('pairingPartners', [{ code: ANA, name: 'Ana' }]);
  settings.set('pairingGroups', []);
  settings.set('contactsAutoExportPath', '');
});

afterEach(() => {
  vi.useRealTimers();
  settings.set('contactsAutoExportPath', '');
  settings.set('pairingPartners', []);
});

describe('contacts auto-export', () => {
  it('writes a team file that imports back to the same contacts', () => {
    const text = contactsFileText(settings.all(), '/x/Westside.cmteam');
    const file = parseTeamFile(JSON.parse(text));
    expect(file?.name).toBe('Westside');
    expect(file?.people).toEqual([
      { code: ME, name: 'Coach' },
      { code: ANA, name: 'Ana' },
    ]);
    expect(file?.relay).toBeUndefined();
    expect(file?.sessions).toBeUndefined();
  });

  it('rewrites the file after a contact or group change, once per burst', async () => {
    installContactsAutoExport();
    settings.set('contactsAutoExportPath', '/x/team.cmteam');
    settings.set('pairingPartners', [...settings.get('pairingPartners'), { code: BEN, name: 'Ben' }]);
    settings.set('pairingGroups', [{ id: 'grp-1', label: 'Novices', memberCodes: [ANA, BEN] }]);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(1);
    const file = parseTeamFile(JSON.parse(writes[0]!.text));
    expect(file?.people.map((p) => p.name)).toEqual(['Coach', 'Ana', 'Ben']);
    expect(file?.groups).toEqual([{ label: 'Novices', memberCodes: [ANA, BEN] }]);
  });

  it('ignores unrelated settings and does nothing while off', async () => {
    installContactsAutoExport();
    settings.set('pairingPartners', [{ code: BEN, name: 'Ben' }]);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(0);
    settings.set('contactsAutoExportPath', '/x/team.cmteam');
    await vi.runAllTimersAsync();
    writes.length = 0;
    settings.set('pairingPollSeconds', settings.get('pairingPollSeconds') + 5);
    await vi.runAllTimersAsync();
    expect(writes).toHaveLength(0);
  });

  it('skips a write when the contents are unchanged', async () => {
    settings.set('contactsAutoExportPath', '/x/same.cmteam');
    await writeContactsFile(true);
    await writeContactsFile();
    expect(writes).toHaveLength(1);
  });
});

describe('add the inviter to contacts', () => {
  it('offers only for an unknown sender who is not you', () => {
    expect(canAddSenderAsContact({ senderCode: BEN })).toBe(true);
    expect(canAddSenderAsContact({ senderCode: ANA })).toBe(false);
    expect(canAddSenderAsContact({ senderCode: ME })).toBe(false);
    expect(canAddSenderAsContact({ senderCode: "" })).toBe(false);
    expect(canAddSenderAsContact({ senderCode: 'not-a-code' })).toBe(false);
  });

  it('adds them under the name typed (pre-filled from their display name)', async () => {
    prompt.answer = 'Ben Wu';
    expect(await addSenderAsContact({ senderCode: BEN, senderName: 'Ben' })).toBe(true);
    expect(settings.get('pairingPartners')).toEqual([
      { code: ANA, name: 'Ana' },
      { code: BEN, name: 'Ben Wu' },
    ]);
  });

  it('adds nothing when the name prompt is cancelled', async () => {
    prompt.answer = null;
    expect(await addSenderAsContact({ senderCode: BEN, senderName: 'Ben' })).toBe(false);
    expect(settings.get('pairingPartners')).toEqual([{ code: ANA, name: 'Ana' }]);
  });
});
