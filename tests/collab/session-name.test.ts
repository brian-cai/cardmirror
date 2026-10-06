// @vitest-environment jsdom
/** Session naming at Start Session (collab-ui.ts): the default is
 *  "Filename - Display Name", never "Untitled". */
import { describe, it, expect } from 'vitest';
import { defaultSessionName, namedDocTitle } from '../../src/editor/collab/collab-ui.js';

const at = new Date(2026, 9, 5, 20, 14);

describe('session names', () => {
  it('a saved document: "Filename - Display Name", extension dropped', () => {
    expect(defaultSessionName(namedDocTitle('Aff.docx'), 'Brian', at)).toBe('Aff - Brian');
    expect(defaultSessionName(namedDocTitle('Neg Blocks.cmir'), 'Brian', at)).toBe('Neg Blocks - Brian');
  });

  it('an unsaved document: the date stands in for the filename, never "Untitled"', () => {
    expect(namedDocTitle('Untitled')).toBeNull();
    expect(namedDocTitle('Untitled 3')).toBeNull();
    expect(namedDocTitle('')).toBeNull();
    expect(defaultSessionName(null, 'Brian', at)).toBe('Oct 5, 8:14 PM - Brian');
  });

  it('no display name set: just the first part', () => {
    expect(defaultSessionName('Aff', '  ', at)).toBe('Aff');
    expect(defaultSessionName(null, '', at)).toBe('Oct 5, 8:14 PM');
  });
});
