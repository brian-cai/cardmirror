/**
 * Import settings merges instead of wiping: preferences come from the
 * file, collections are unioned, identity and this-computer-only state
 * stay, and folders that don't exist here are skipped.
 */
import { describe, it, expect } from 'vitest';
import { mergeImportedSettings } from '../../src/editor/settings-import.js';
import { settings, type Settings } from '../../src/editor/settings.js';

const A = 'a'.repeat(43);
const B = 'b'.repeat(43);
const ME = 'm'.repeat(43);
const COACH = 'c'.repeat(43);

function mine(over: Partial<Settings> = {}): Settings {
  return {
    ...settings.all(),
    pairingOwnCode: ME,
    pairingDisplayName: 'Me',
    pairingPartners: [{ code: A, name: 'Alex' }],
    pairingGroups: [{ id: 'g1', label: 'Varsity', memberCodes: [A] }],
    fileSearchRoots: ['/Users/me/Dropbox'],
    fileSearchHighestFolders: [],
    sendDocFolder: '/Users/me/Send',
    keyboardMacros: [{ id: 'k1', key: 'Mod-Shift-q', text: 'mine' }],
    ribbonKeyOverrides: { save: 'Mod-s', openFile: 'Mod-o' },
    theme: 'light',
    ...over,
  } as Settings;
}

const here = new Set(['/Users/me/Dropbox', '/Shared/Backfiles', '/Shared/Send']);
const exists = async (p: string): Promise<boolean> => here.has(p);

describe('mergeImportedSettings', () => {
  it('takes preferences from the file but keeps settings it does not mention', async () => {
    const { merged } = await mergeImportedSettings(mine({ ribbonScale: 150 }), { theme: 'dark' }, { exists });
    expect(merged['theme']).toBe('dark');
    expect(merged['ribbonScale']).toBe(150); // not reset to the default
  });

  it('never takes your sharing code, name or app permissions from the file', async () => {
    const { merged } = await mergeImportedSettings(
      mine(),
      { pairingOwnCode: COACH, pairingDisplayName: 'Coach', externalAppConsents: [{ id: 'evil', decision: 'allow', firstSeen: '', lastSeen: '' }] },
      { exists },
    );
    expect(merged['pairingOwnCode']).toBe(ME);
    expect(merged['pairingDisplayName']).toBe('Me');
    expect(merged['externalAppConsents']).toEqual(settings.all().externalAppConsents);
  });

  it('merges contacts and groups like a team file: adds, never removes, never adds yourself', async () => {
    const { merged } = await mergeImportedSettings(
      mine(),
      {
        pairingPartners: [{ code: B, name: 'Bo' }, { code: ME, name: 'You' }, { code: A, name: 'Other name' }],
        pairingGroups: [{ id: 'x', label: 'varsity', memberCodes: [B, ME] }, { id: 'y', label: 'JV', memberCodes: [B] }],
      },
      { exists },
    );
    const partners = merged['pairingPartners'] as { code: string; name: string }[];
    expect(partners.map((p) => p.name)).toEqual(['Alex', 'Bo']);
    const groups = merged['pairingGroups'] as { label: string; memberCodes: string[] }[];
    expect(groups.find((g) => g.label === 'Varsity')!.memberCodes).toEqual([A, B]);
    expect(groups.map((g) => g.label)).toEqual(['Varsity', 'JV']);
  });

  it('adds only folders that exist here, keeps yours, and reports the rest', async () => {
    const { merged, skippedFolders } = await mergeImportedSettings(
      mine(),
      {
        fileSearchRoots: ['C:\\Users\\coach\\Dropbox', '/Shared/Backfiles'],
        fileSearchHighestFolders: ['/Shared/Backfiles'],
        sendDocFolder: 'C:\\Users\\coach\\Send',
        readDocFolder: '/Shared/Send',
      },
      { exists },
    );
    expect(merged['fileSearchRoots']).toEqual(['/Users/me/Dropbox', '/Shared/Backfiles']);
    expect(merged['fileSearchHighestFolders']).toEqual(['/Shared/Backfiles']);
    expect(merged['sendDocFolder']).toBe('/Users/me/Send');
    expect(merged['readDocFolder']).toBe('/Shared/Send');
    expect(skippedFolders.sort()).toEqual(['C:\\Users\\coach\\Dropbox', 'C:\\Users\\coach\\Send'].sort());
  });

  it('unions macros (yours win a clash) and merges shortcut overrides per command (the file wins)', async () => {
    const { merged } = await mergeImportedSettings(
      mine(),
      {
        keyboardMacros: [{ id: 'z', key: 'Mod-Shift-q', text: 'theirs' }, { id: 'w', key: 'Mod-Shift-w', text: 'new' }],
        ribbonKeyOverrides: { save: 'Mod-Alt-s' },
      },
      { exists },
    );
    expect((merged['keyboardMacros'] as { text: string }[]).map((m) => m.text)).toEqual(['mine', 'new']);
    expect(merged['ribbonKeyOverrides']).toEqual({ save: 'Mod-Alt-s', openFile: 'Mod-o' });
  });

  it('an empty relay in the file does not blank yours', async () => {
    const { merged } = await mergeImportedSettings(
      mine({ pairingRelayUrl: 'https://relay.example', pairingRelayToken: 'tok' }),
      { pairingRelayUrl: '', pairingRelayToken: '' },
      { exists },
    );
    expect(merged['pairingRelayUrl']).toBe('https://relay.example');
    expect(merged['pairingRelayToken']).toBe('tok');
  });

  it('survives replaceAll sanitizing', async () => {
    const before = settings.all();
    const { merged } = await mergeImportedSettings(mine(), { theme: 'dark', pairingPartners: [{ code: B, name: 'Bo' }] }, { exists });
    settings.replaceAll(merged);
    expect(settings.get('theme')).toBe('dark');
    expect(settings.get('pairingPartners').map((p) => p.name)).toEqual(['Alex', 'Bo']);
    settings.replaceAll(before);
  });
});
