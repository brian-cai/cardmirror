/**
 * Contacts auto-export — keep a team file (.cmteam) on disk in step with
 * your contacts and groups, so a change (a new contact, a new group, a
 * rename) never has to be re-exported by hand.
 *
 * The file is the same one Export team… writes: your own code and
 * display name, every contact, every group. Never the relay token or live
 * sessions — the file is rewritten silently, so it must not carry secrets
 * the user didn't choose to share each time.
 *
 * Desktop only (it writes to a fixed path). Only the window where a change
 * was MADE writes (`meta.remote` is false there): the other windows see the
 * same change arrive over the storage event and would otherwise all race
 * to write the same file.
 */
import { settings, type Settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { showToast } from '../toast.js';
import { buildTeamFile, serializeTeamFile } from './team-file.js';

/** The settings that feed the file. */
const WATCHED: readonly (keyof Settings)[] = [
  'pairingPartners',
  'pairingGroups',
  'pairingDisplayName',
  'pairingOwnCode',
];
const DEBOUNCE_MS = 800;

let installed = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWritten: { path: string; text: string } | null = null;
let failureToasted = false;

/** The team name inside the file: the file's own name, minus extension. */
function teamNameFor(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.(cmteam|json)$/i, '') || 'Contacts';
}

/** The file's contents for `path` from the current settings. */
export function contactsFileText(s: Readonly<Settings>, path: string): string {
  return serializeTeamFile(
    buildTeamFile({
      name: teamNameFor(path),
      ownCode: s.pairingOwnCode,
      ownName: s.pairingDisplayName,
      partners: s.pairingPartners,
      groups: s.pairingGroups,
    }),
  );
}

/** Write the file now (skipped when nothing changed since the last write).
 *  Resolves false on a write failure. */
export async function writeContactsFile(force = false): Promise<boolean> {
  const electron = getElectronHost();
  const path = settings.get('contactsAutoExportPath');
  if (!electron || !path) return true;
  const text = contactsFileText(settings.all(), path);
  if (!force && lastWritten?.path === path && lastWritten.text === text) return true;
  try {
    await electron.writeFileAtPath(path, new TextEncoder().encode(text));
    lastWritten = { path, text };
    failureToasted = false;
    return true;
  } catch (err) {
    console.error('Contacts auto-export failed:', err);
    // Once per failure streak: a missing drive shouldn't toast on every edit.
    if (!failureToasted) {
      failureToasted = true;
      showToast(
        `Couldn’t update your contacts file (${path}). Change or stop it in Settings → Collaboration → Team file.`,
      );
    }
    return false;
  }
}

/** Watch contacts / groups and rewrite the file after each local change. */
export function installContactsAutoExport(): void {
  if (installed || !getElectronHost()) return;
  installed = true;
  let prev: Readonly<Settings> = { ...settings.all() };
  settings.subscribe((s, meta) => {
    const before = prev;
    prev = s;
    if (meta.remote || !s.contactsAutoExportPath) return;
    const pathChanged = before.contactsAutoExportPath !== s.contactsAutoExportPath;
    if (!pathChanged && !WATCHED.some((k) => before[k] !== s[k])) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeContactsFile();
    }, DEBOUNCE_MS);
  });
}
