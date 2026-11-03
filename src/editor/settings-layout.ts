/**
 * How the Settings dialog lays rows out, kept apart from the registry.
 *
 * SETTING_METADATA stays exactly as upstream writes it (merges stay
 * clean), so tidying the dialog happens here, at display time only:
 *  - long descriptions show their first sentence, the rest behind More;
 *  - a few crowded sections are split for display (Send / Read / Marked);
 *  - sections fold (see settings-ui.ts makeSectionsCollapsible).
 * Nothing here changes a setting's key, value, default or stored shape.
 *
 * Pure (no DOM) so it's unit-testable.
 */

import type { SettingMeta } from './settings.js';

/** Descriptions at or under this length show whole. */
const SHORT_DESCRIPTION = 140;
/** A split must leave at least this much behind More, else show whole. */
const MIN_REST = 40;
/** Abbreviations whose period doesn't end a sentence. */
const NOT_A_SENTENCE_END = /(?:\b(?:e\.g|i\.e|etc|vs|approx|incl)|\.\.)$/i;

/** Split a description into the line that always shows and the rest,
 *  which goes behind More. `rest` is '' when the text shows whole. A
 *  description with line breaks (a token table) keeps its first line as
 *  the summary; otherwise the summary is the first sentence. */
export function splitDescription(text: string): { summary: string; rest: string } {
  const whole = { summary: text, rest: '' };
  const nl = text.indexOf('\n');
  if (nl > 0) {
    const summary = text.slice(0, nl).trimEnd();
    const rest = text.slice(nl + 1).replace(/^\n+/, '').trimEnd();
    return rest.length >= MIN_REST || (rest && text.length > SHORT_DESCRIPTION) ? { summary, rest } : whole;
  }
  if (text.length <= SHORT_DESCRIPTION) return whole;
  const end = /[.!?](?=\s+["“‘'(\[A-Z0-9.])/g;
  let m: RegExpExecArray | null;
  while ((m = end.exec(text))) {
    const cut = m.index + 1;
    if (cut < 25) continue;
    if (text[m.index] === '.' && NOT_A_SENTENCE_END.test(text.slice(0, m.index))) continue;
    const rest = text.slice(cut).trim();
    if (rest.length < MIN_REST) return whole;
    return { summary: text.slice(0, cut), rest };
  }
  return whole;
}

/** Display-only section names for rows whose registry section is too
 *  crowded. Order within a tab follows first appearance, so the rows of
 *  each new section are pulled together under their own heading. */
const DISPLAY_SECTIONS: Partial<Record<string, string>> = {
  prefixPresetSaveFilenames: 'Save As presets',
  sendDocPrefix: 'Send Doc',
  sendDocDestination: 'Send Doc',
  sendDocFolder: 'Send Doc',
  sendDocFormat: 'Send Doc',
  sendDocNumbering: 'Send Doc',
  readDocPrefix: 'Read Doc',
  readDocDestination: 'Read Doc',
  readDocFolder: 'Read Doc',
  readDocFormat: 'Read Doc',
  markedDocPrefix: 'Marked Cards',
  markedCardsDestination: 'Marked Cards',
  markedCardsFolder: 'Marked Cards',
  markedDocFormat: 'Marked Cards',
  markedDocNumbering: 'Marked Cards',
};

/** The section heading a row shows under in the dialog. */
export function displaySection(meta: Pick<SettingMeta, 'key' | 'section'>): string | undefined {
  return DISPLAY_SECTIONS[meta.key as string] ?? meta.section;
}

/** Rows grouped so each display section is contiguous, sections in order
 *  of first appearance, rows in registry order within a section. Rows
 *  with no section keep their place relative to the section before them. */
export function orderByDisplaySection<T extends Pick<SettingMeta, 'key' | 'section'>>(entries: readonly T[]): T[] {
  const groups = new Map<string, T[]>();
  const order: string[] = [];
  let last = '';
  for (const e of entries) {
    const s = displaySection(e) ?? last;
    last = s;
    if (!groups.has(s)) {
      groups.set(s, []);
      order.push(s);
    }
    groups.get(s)!.push(e);
  }
  return order.flatMap((s) => groups.get(s)!);
}
