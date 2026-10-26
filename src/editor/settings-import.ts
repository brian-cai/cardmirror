/**
 * Import settings without wiping out what's already here.
 *
 * A settings file is often someone else's (a coach's, a teammate's), so
 * importing one must not replace things you've built up or things that
 * only make sense on this computer, and must never change what runs on
 * this computer or where your data goes. Only the settings listed in
 * IMPORTABLE_SETTING_KEYS (settings.ts) are taken from a file — an
 * allowlist, so a new setting stays out until someone decides it's safe:
 *
 * - Preferences (theme, shortcuts, sizes, toggles…): the file's value wins.
 *   That's what importing settings is for. Settings the file doesn't
 *   mention keep their current value instead of resetting to defaults.
 * - Collections you build up (contacts, groups, file search folders,
 *   macros, custom ribbon buttons, autocorrects, readers…): merged. Your
 *   entries all stay, the file's new ones are added.
 * - Everything else keeps its current value: identity and this-computer
 *   state (your sharing code and name, app permissions, voice
 *   calibration), and anything that loads code or decides where data goes
 *   (the card cutter, plugins, relays and team keys, update checks). An
 *   imported card-cutter engine path once ran the file's code. Relay
 *   settings in a file are reported (`skippedRelay`) so the user can be
 *   told to use an invite link instead.
 *
 * Folder paths are machine-specific: an imported folder is used only if
 * it exists on this computer (`exists`), otherwise it's left out (lists)
 * or your current folder is kept (single folders).
 *
 * The result goes through `settings.replaceAll`, which sanitizes it.
 */
import type { PairingGroup, PairingPartner, Settings } from './settings.js';
import { mergeTeamFile, TEAM_FILE_KIND } from './pairing/team-file.js';
import { normalizePairingCode } from './pairing/pairing-ids.js';
import {
  AI_PROVIDER_SETTING_KEYS,
  IMPORTABLE_SETTING_KEYS,
  MAX_RIBBON_CUSTOM_BUTTONS,
} from './settings.js';
import { relayMatchKey } from './relay-protocol.js';

/** Settings a file may carry that are never applied, and that the import
 *  summary mentions when the file would have changed them. */
const PROTECTED_KEYS = [
  'cardCutterEnabled',
  'cardCutterEnginePath',
  'pluginsEnabled',
  'pluginCommunityInstalls',
  'externalInsertPolicy',
  'externalAppConsents',
] as const;

/** Single-folder settings: the file's folder only if it exists here. */
const FOLDER_KEYS = ['defaultSpeechDocFolder', 'sendDocFolder', 'readDocFolder', 'markedCardsFolder'] as const;

/** Folder lists: union, keeping only imported folders that exist here. */
const FOLDER_LIST_KEYS = [
  'fileSearchRoots',
  'fileSearchHighestFolders',
  'fileSearchPreferredFolders',
  'fileSearchDeprioritizedFolders',
] as const;

/** Plain string lists: union. */
const STRING_LIST_KEYS = [
  'fileSearchExclusions',
  'pairingBlockedCodes',
  'cleanProtectedStyles',
  'quickCardActiveTags',
] as const;

export interface ImportMergeOptions {
  /** Whether a folder exists on this computer. Omitted (no way to check,
   *  e.g. the web edition) → imported folders are accepted as-is. */
  exists?: (path: string) => Promise<boolean>;
  /** The user chose "Import with API keys": the provider choice that
   *  goes with the keys (AI_PROVIDER_SETTING_KEYS) comes along. The keys
   *  themselves are applied by `replaceAll`'s `importSecrets`. */
  importSecrets?: boolean;
}

export interface ImportMergeResult {
  /** The settings object to hand `settings.replaceAll`. */
  merged: Record<string, unknown>;
  /** Imported folders left out because they aren't on this computer. */
  skippedFolders: string[];
  /** The file names a relay (address, token or saved relays) that differs
   *  from yours. Never applied; a relay comes from an invite link. */
  skippedRelay: boolean;
  /** The file would have changed card cutter, plugin or app-permission
   *  settings. Never applied. */
  skippedProtected: boolean;
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `current` entries first, then imported ones whose key isn't taken. */
function unionBy<T>(current: readonly T[], incoming: readonly unknown[], key: (x: T) => string): T[] {
  const out = [...current];
  const seen = new Set(current.map(key));
  for (const raw of incoming) {
    if (!isObj(raw) && typeof raw !== 'string') continue;
    const item = raw as T;
    let k: string;
    try {
      k = key(item);
    } catch {
      continue;
    }
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export async function mergeImportedSettings(
  current: Readonly<Settings>,
  incoming: Record<string, unknown>,
  opts: ImportMergeOptions = {},
): Promise<ImportMergeResult> {
  const cur = current as unknown as Record<string, unknown>;
  // Start from what's here, so settings the file doesn't mention stay,
  // and take only the allowlisted ones from the file.
  const merged: Record<string, unknown> = { ...cur };
  for (const key of IMPORTABLE_SETTING_KEYS) {
    if (key in incoming) merged[key] = incoming[key];
  }
  if (opts.importSecrets) {
    for (const key of AI_PROVIDER_SETTING_KEYS) {
      if (key in incoming) merged[key] = incoming[key];
    }
  }
  const skippedFolders: string[] = [];
  const existsCache = new Map<string, Promise<boolean>>();
  const exists = (p: string): Promise<boolean> => {
    if (!opts.exists) return Promise.resolve(true);
    let hit = existsCache.get(p);
    if (!hit) {
      hit = opts.exists(p).catch(() => false);
      existsCache.set(p, hit);
    }
    return hit;
  };

  for (const key of FOLDER_KEYS) {
    const v = incoming[key];
    if (typeof v !== 'string' || !v.trim() || v === cur[key]) continue;
    if (!(await exists(v))) {
      merged[key] = cur[key];
      skippedFolders.push(v);
    }
  }

  for (const key of FOLDER_LIST_KEYS) {
    if (!(key in incoming)) continue;
    const mine = arr(cur[key]).filter((x): x is string => typeof x === 'string');
    const out = [...mine];
    for (const p of arr(incoming[key])) {
      if (typeof p !== 'string' || !p.trim() || out.includes(p)) continue;
      if (await exists(p)) out.push(p);
      else if (!skippedFolders.includes(p)) skippedFolders.push(p);
    }
    merged[key] = out;
  }

  for (const key of STRING_LIST_KEYS) {
    if (!(key in incoming)) continue;
    merged[key] = unionBy(arr(cur[key]) as string[], arr(incoming[key]), (s) => String(s));
  }

  // Contacts and groups: exactly the team-file rules — add people you
  // don't have (never yourself), add groups by name or top up a group
  // you already have; nothing of yours is removed or renamed.
  if ('pairingPartners' in incoming || 'pairingGroups' in incoming) {
    const people = arr(incoming['pairingPartners'])
      .filter(isObj)
      .map((p) => ({ code: normalizePairingCode(String(p['code'] ?? '')), name: String(p['name'] ?? '') }))
      .filter((p) => p.code);
    const groups = arr(incoming['pairingGroups'])
      .filter(isObj)
      .map((g) => ({
        label: String(g['label'] ?? '').trim(),
        memberCodes: arr(g['memberCodes']).map((c) => normalizePairingCode(String(c))).filter(Boolean),
      }))
      .filter((g) => g.label);
    const result = mergeTeamFile({
      file: { kind: TEAM_FILE_KIND, version: 1, name: '', people, groups },
      ownCode: String(cur['pairingOwnCode'] ?? ''),
      partners: arr(cur['pairingPartners']) as PairingPartner[],
      groups: arr(cur['pairingGroups']) as PairingGroup[],
      // Your own settings file: top up groups as before (team-review.ts
      // guards only shared team files and relay lists).
      topUp: true,
    });
    merged['pairingPartners'] = result.partners;
    merged['pairingGroups'] = result.groups;
  }

  // Relays are never taken from a file (an http:// relay, or one that
  // isn't yours, would see everything you share). Note whether the file
  // named one you don't have, so the summary can say so.
  const mineRelays = new Set(
    [
      relayMatchKey(String(cur['pairingRelayUrl'] ?? ''), String(cur['pairingRelayToken'] ?? '')),
      ...arr(cur['relayProfiles'])
        .filter(isObj)
        .map((p) => relayMatchKey(String(p['url'] ?? ''), String(p['token'] ?? ''))),
    ],
  );
  const fileRelays: [unknown, unknown][] = [
    [incoming['pairingRelayUrl'], incoming['pairingRelayToken'] ?? cur['pairingRelayToken']],
    ...arr(incoming['relayProfiles'])
      .filter(isObj)
      .map((p): [unknown, unknown] => [p['url'], p['token']]),
  ];
  const skippedRelay = fileRelays.some(
    ([url, token]) =>
      typeof url === 'string' &&
      url.trim() !== '' &&
      !mineRelays.has(relayMatchKey(url, typeof token === 'string' ? token : '')),
  );
  const skippedProtected = PROTECTED_KEYS.some(
    (key) => key in incoming && JSON.stringify(incoming[key]) !== JSON.stringify(cur[key]),
  );

  // Things you've made: keep all of yours, add the file's new ones.
  const lists: [string, (x: Record<string, unknown>) => string][] = [
    ['keyboardMacros', (m) => String(m['key'])],
    ['customAutocorrects', (a) => String(a['from'])],
    ['readers', (r) => String(r['name']).toLowerCase()],
    ['acronymPatterns', (a) => String(a['phrase'])],
    ['shrinkCustomProtections', (p) => `${p['isRegex'] ? 'r' : 's'}:${p['pattern']}`],
  ];
  for (const [key, k] of lists) {
    if (!(key in incoming)) continue;
    merged[key] = unionBy(arr(cur[key]) as Record<string, unknown>[], arr(incoming[key]), k);
  }
  if ('ribbonCustomButtons' in incoming) {
    // A button that flips a setting may only flip one a file could set.
    const allowed = arr(incoming['ribbonCustomButtons']).filter((b) => {
      const m = isObj(b) ? /^(?:toggle|cycle):(.*)$/.exec(String(b['command'] ?? '')) : null;
      return !m || IMPORTABLE_SETTING_KEYS.has(m[1]!);
    });
    merged['ribbonCustomButtons'] = unionBy(
      arr(cur['ribbonCustomButtons']) as Record<string, unknown>[],
      allowed,
      (b) => String(b['command']),
    ).slice(0, MAX_RIBBON_CUSTOM_BUTTONS);
  }

  // Keyed preferences: per entry, the file wins; entries only you have stay.
  for (const key of ['ribbonKeyOverrides', 'customColorOverrides'] as const) {
    if (isObj(incoming[key])) merged[key] = { ...(isObj(cur[key]) ? cur[key] : {}), ...incoming[key] };
  }

  return { merged, skippedFolders, skippedRelay, skippedProtected };
}
