import { describe, expect, it } from 'vitest';
import { displaySection, orderByDisplaySection, splitDescription } from '../../src/editor/settings-layout.js';
import { SETTING_METADATA } from '../../src/editor/settings.js';

describe('splitDescription', () => {
  it('shows short descriptions whole', () => {
    expect(splitDescription('Turns it on.')).toEqual({ summary: 'Turns it on.', rest: '' });
  });

  it('keeps the first sentence and puts the rest behind More', () => {
    const text =
      'Sets the format the Save-As dialog defaults to for a doc you haven\'t saved before. .docx is the default — Word- and Verbatim-compatible. Pick .cmir to make every new doc save natively.';
    const { summary, rest } = splitDescription(text);
    expect(summary).toBe('Sets the format the Save-As dialog defaults to for a doc you haven\'t saved before.');
    expect(rest.startsWith('.docx is the default')).toBe(true);
  });

  it('does not split on e.g.', () => {
    const text =
      'When on, the Pocket carries the speech name (e.g. "Speech 1NC") at the top of every new speech doc you open. Turn off to start with a fully blank document instead.';
    expect(splitDescription(text).summary).toMatch(/at the top of every new speech doc you open\.$/);
  });

  it('uses the first line of a line-broken description', () => {
    const text = 'The name New Speech Document gives a new file.\n{speech} is the name you type.\nyear - YYYY 2026, YY 26\nmonth - M 4, MM 04';
    const { summary, rest } = splitDescription(text);
    expect(summary).toBe('The name New Speech Document gives a new file.');
    expect(rest.startsWith('{speech}')).toBe(true);
  });

  it('never loses text', () => {
    for (const m of SETTING_METADATA) {
      const d = m.description;
      if (!d) continue;
      const { summary, rest } = splitDescription(d);
      const norm = (t: string) => t.replace(/\s+/g, ' ').trim();
      expect(norm(rest ? `${summary} ${rest}` : summary)).toBe(norm(d));
    }
  });
});

describe('display sections', () => {
  it('splits Send / Read / Marked into their own sections without touching the registry', () => {
    const send = SETTING_METADATA.find((m) => m.key === 'sendDocFormat')!;
    expect(send.section).toBe('Send / Read / Marked docs');
    expect(displaySection(send)).toBe('Send Doc');
    const files = orderByDisplaySection(SETTING_METADATA.filter((m) => m.category === 'files'));
    const seq = files.map((m) => displaySection(m));
    // Each section appears as one contiguous run.
    const runs = seq.filter((s, i) => s !== seq[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
    expect(runs).toEqual(expect.arrayContaining(['Send Doc', 'Read Doc', 'Marked Cards']));
    expect(files).toHaveLength(SETTING_METADATA.filter((m) => m.category === 'files').length);
  });
});
