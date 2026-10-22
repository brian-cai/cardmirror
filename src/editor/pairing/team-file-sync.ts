/**
 * Team file sync — keep this machine in step with the team file (.cmteam)
 * it imported, usually one sitting in a shared Dropbox / Drive folder.
 *
 * - Re-read on launch, on window focus and every few minutes. New people,
 *   groups and sessions merge in (additive, like Import team: nothing you
 *   have is removed). A changed relay is NOT applied silently — a shared
 *   file must not be able to reroute everyone's cards without asking; that
 *   still takes a manual Import team.
 * - Add yourself: when your code isn't in the file, your pairing code and
 *   display name are appended (every other field kept as it was), so the
 *   file collects the whole team as each person imports it.
 * - Team key (team sessions): a file with a key gives it to a machine
 *   that has none; a machine's own key is never replaced — a file with a
 *   different one gets a quiet notice. A file without a key gets this
 *   machine's (minted here if it has none), so a team that started before
 *   team sessions picks one up without re-exporting.
 *
 * Desktop only (reads / writes a path). Windows coordinate through a
 * localStorage timestamp so only one of them syncs at a time.
 */
import { settings } from '../settings.js';
import { getElectronHost } from '../host/index.js';
import { showToast } from '../toast.js';
import { looksLikePairingCode, normalizePairingCode } from './pairing-ids.js';
import {
  addPersonToTeamFileJson,
  addTeamKeyToTeamFileJson,
  mergeTeamFile,
  parseTeamFile,
  type TeamFile,
} from './team-file.js';
import { generateTeamKey, isTeamKey, mergeTeamKey } from './team-key.js';
import { postNotice } from '../status-notices.js';

const POLL_MS = 5 * 60_000;
const FOCUS_MIN_GAP_MS = 60_000;
/** Another window synced this recently → skip (they share settings). */
const LOCK_KEY = 'pmd-team-sync-at';
const LOCK_MS = 20_000;
/** Room ids already offered from the team file, so a session you removed
 *  from your recents doesn't come back on the next sync. */
const SEEN_ROOMS_KEY = 'pmd-team-sync-seen-rooms';

let installed = false;
let running = false;
let lastSyncAt = 0;
let failureToasted = false;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode / quota — sync still works, just less coordinated */
  }
}

/** Your own entry for the file, or null when you have no code or name yet. */
export function ownTeamEntry(): { code: string; name: string } | null {
  const code = normalizePairingCode(settings.get('pairingOwnCode'));
  const name = settings.get('pairingDisplayName').trim();
  if (!looksLikePairingCode(code) || !name) return null;
  return { code, name };
}

/** Is your code missing from `file`? */
export function teamFileMissesYou(file: TeamFile): boolean {
  const code = normalizePairingCode(settings.get('pairingOwnCode'));
  return looksLikePairingCode(code) && !file.people.some((p) => p.code === code);
}

/** Append yourself to the team file at `path` (re-read just before writing,
 *  to keep the window for a teammate's concurrent edit small). Resolves
 *  true when written. */
export async function addYourselfToTeamFile(path: string): Promise<boolean> {
  const electron = getElectronHost();
  const me = ownTeamEntry();
  if (!electron?.readTeamFile || !me) return false;
  const fresh = await electron.readTeamFile(path);
  if (!fresh) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fresh.bytes));
  } catch {
    return false;
  }
  const next = addPersonToTeamFileJson(raw, me);
  if (!next) return false;
  await electron.writeFileAtPath(path, new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n'));
  return true;
}

/** Take the team key from `file` under the merge rule (team-key.ts): a
 *  machine with no key adopts the file's; one with a different key keeps
 *  its own and gets a quiet notice (no toast — it's not urgent, and a
 *  synced file would repeat it every few minutes; the key coalesces). */
export function applyTeamKeyFromFile(file: TeamFile): 'adopted' | 'conflict' | 'unchanged' {
  const m = mergeTeamKey(settings.get('teamSessionsKey'), file.teamKey);
  if (m.adopted) {
    settings.set('teamSessionsKey', m.key);
    return 'adopted';
  }
  if (m.conflict) {
    postNotice({
      severity: 'info',
      title: 'Team file has a different team key',
      body:
        `\u201c${file.name}\u201d carries a different team sessions key from the one on this computer, so ` +
        'yours was kept. Teammates using the file\u2019s key won\u2019t see your listed sessions (or you theirs) ' +
        'until you all share one file.',
      key: 'team-key-conflict',
      toast: false,
    });
    return 'conflict';
  }
  return 'unchanged';
}

/** This machine's team key, minted (and kept) when it has none. */
export function ensureLocalTeamKey(): string {
  const have = settings.get('teamSessionsKey');
  if (isTeamKey(have)) return have;
  const key = generateTeamKey();
  settings.set('teamSessionsKey', key);
  return key;
}

/** Write this machine's team key into the file at `path` when the file has
 *  none (re-read just before writing; every other field kept). Resolves
 *  true when written. */
export async function addTeamKeyToFile(path: string): Promise<boolean> {
  const electron = getElectronHost();
  if (!electron?.readTeamFile) return false;
  const fresh = await electron.readTeamFile(path);
  if (!fresh) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(fresh.bytes));
  } catch {
    return false;
  }
  const next = addTeamKeyToTeamFileJson(raw, ensureLocalTeamKey());
  if (!next) return false;
  await electron.writeFileAtPath(path, new TextEncoder().encode(JSON.stringify(next, null, 2) + '\n'));
  return true;
}

/** One sync pass. `force` skips the cross-window lock (an explicit
 *  "Sync now" or a just-chosen file). Resolves 'changed' / 'unchanged',
 *  or 'failed' / 'skipped'. */
export async function syncTeamFile(force = false): Promise<'changed' | 'unchanged' | 'failed' | 'skipped'> {
  const electron = getElectronHost();
  const path = settings.get('teamFileSyncPath');
  if (!electron?.readTeamFile || !path || running) return 'skipped';
  const now = Date.now();
  if (!force && now - readJson<number>(LOCK_KEY, 0) < LOCK_MS) return 'skipped';
  writeJson(LOCK_KEY, now);
  running = true;
  lastSyncAt = now;
  try {
    const got = await electron.readTeamFile(path);
    let file: TeamFile | null = null;
    if (got) {
      try {
        file = parseTeamFile(JSON.parse(new TextDecoder().decode(got.bytes)));
      } catch {
        file = null;
      }
    }
    if (!file) {
      if (!failureToasted) {
        failureToasted = true;
        showToast(
          `Couldn’t read your team file “${baseName(path)}”. ` +
            'Change or stop syncing in Settings → Collaboration → Team file.',
        );
      }
      return 'failed';
    }
    failureToasted = false;

    const merged = mergeTeamFile({
      file,
      ownCode: settings.get('pairingOwnCode'),
      partners: settings.get('pairingPartners'),
      groups: settings.get('pairingGroups'),
    });
    const news: string[] = [];
    if (merged.addedPeople > 0) {
      const names = merged.partners.slice(-merged.addedPeople).map((p) => p.name);
      news.push(names.length <= 3 ? names.join(', ') : `${merged.addedPeople} people`);
    }
    if (merged.addedGroups > 0) news.push(`${merged.addedGroups} group${merged.addedGroups === 1 ? '' : 's'}`);
    if (merged.addedPeople || merged.addedGroups || merged.updatedGroups) {
      settings.set('pairingPartners', merged.partners);
      settings.set('pairingGroups', merged.groups);
    }

    // Team key: adopt the file's, or give the file ours (quietly — a key
    // isn't news to the user, it just turns team sessions on).
    applyTeamKeyFromFile(file);
    if (!file.teamKey) {
      try {
        await addTeamKeyToFile(path);
      } catch (err) {
        console.warn('[team-sync] could not add the team key to the team file:', err);
      }
    }

    const newRooms = await addNewSessions(file);
    if (newRooms > 0) news.push(`${newRooms} session${newRooms === 1 ? '' : 's'} to join`);
    let changed = news.length > 0;
    if (changed) showToast(`Team “${file.name}”: added ${news.join(', ')}.`);

    if (teamFileMissesYou(file) && ownTeamEntry()) {
      try {
        if (await addYourselfToTeamFile(path)) {
          changed = true;
          showToast(`Added you to the team file “${baseName(path)}” so teammates can send to you.`);
        }
      } catch (err) {
        console.warn('[team-sync] could not add yourself to the team file:', err);
      }
    }
    return changed ? 'changed' : 'unchanged';
  } finally {
    running = false;
  }
}

async function addNewSessions(file: TeamFile): Promise<number> {
  if (!file.sessions?.length) return 0;
  const seen = new Set(readJson<string[]>(SEEN_ROOMS_KEY, []));
  const fresh = file.sessions.filter((s) => !seen.has(s.roomId));
  if (fresh.length === 0) return 0;
  let added = 0;
  try {
    const store = await import('../collab/collab-store.js');
    for (const s of fresh) {
      seen.add(s.roomId);
      if (await store.loadRecentRoom(s.roomId)) continue;
      await store.saveRecentRoom({
        roomId: s.roomId,
        shareCode: s.shareCode,
        guestPass: s.guestPass ?? null,
        role: 'participant',
        docTitle: s.docTitle,
        lastActiveAt: Date.now(),
      });
      added++;
    }
  } catch {
    return added;
  } finally {
    writeJson(SEEN_ROOMS_KEY, [...seen]);
  }
  return added;
}

/** Remember the imported file's sessions as already offered (Import team
 *  saves them itself). */
export function markTeamSessionsSeen(file: TeamFile): void {
  if (!file.sessions?.length) return;
  const seen = new Set(readJson<string[]>(SEEN_ROOMS_KEY, []));
  for (const s of file.sessions) seen.add(s.roomId);
  writeJson(SEEN_ROOMS_KEY, [...seen]);
}

/** Start syncing (idempotent; desktop only). */
export function installTeamFileSync(): void {
  if (installed || !getElectronHost()?.readTeamFile) return;
  installed = true;
  setTimeout(() => void syncTeamFile(), 3000);
  setInterval(() => void syncTeamFile(), POLL_MS);
  window.addEventListener('focus', () => {
    if (Date.now() - lastSyncAt >= FOCUS_MIN_GAP_MS) void syncTeamFile();
  });
  let prevPath = settings.get('teamFileSyncPath');
  settings.subscribe((s, meta) => {
    if (s.teamFileSyncPath === prevPath) return;
    prevPath = s.teamFileSyncPath;
    failureToasted = false;
    if (!meta.remote && s.teamFileSyncPath) void syncTeamFile(true);
  });
}
