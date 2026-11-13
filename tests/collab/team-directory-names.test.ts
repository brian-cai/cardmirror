import { describe, expect, it } from 'vitest';
import { followDirectoryNames } from '../../src/editor/collab/team-directory.js';

const A = 'cmk1.' + 'a'.repeat(43);
const B = 'cmk1.' + 'b'.repeat(43);
const dir = (name: string) => ({ people: [{ code: A, name, self: true }] });

describe('contacts follow renames on the team list', () => {
  it('a contact from before keeps its name and starts following', () => {
    const out = followDirectoryNames([{ code: A, name: 'Jane Doe' }], dir('Jane Doe'));
    expect(out).toEqual([{ code: A, name: 'Jane Doe', dirName: 'Jane Doe' }]);
    const handMade = followDirectoryNames([{ code: A, name: 'Ana (mine)' }], dir('Ana'));
    expect(handMade[0]).toMatchObject({ name: 'Ana (mine)', dirName: 'Ana' });
  });

  it('a rename on the list carries over', () => {
    const out = followDirectoryNames([{ code: A, name: 'Jane D.', dirName: 'Jane D.' }], dir('JD'));
    expect(out[0]).toMatchObject({ name: 'JD', dirName: 'JD' });
  });

  it('a name changed here (a nickname) is kept', () => {
    const out = followDirectoryNames([{ code: A, name: 'Partner', dirName: 'Jane D.' }], dir('JD'));
    expect(out[0]).toMatchObject({ name: 'Partner', dirName: 'JD' });
  });

  it('contacts not on the list are untouched, and nothing changes when nothing did', () => {
    const same = [{ code: A, name: 'JD', dirName: 'JD' }, { code: B, name: 'Other' }];
    const out = followDirectoryNames(same, dir('JD'));
    expect(out[0]).toBe(same[0]);
    expect(out[1]).toBe(same[1]);
  });
});
