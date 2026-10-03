/**
 * File-search folder priority (`fileSearchHighestFolders` /
 * `fileSearchPreferredFolders`): highest-priority matches list above every
 * other match; preferred matches win ties within a match tier; the deepest
 * entry wins when the sections nest.
 */

import { describe, expect, it } from 'vitest';
import {
  folderPriorityFor,
  makeFileEntry,
  searchFiles,
  type FolderPriority,
} from '../../src/editor/file-search.js';
import { settings } from '../../src/editor/settings.js';

const f = (relPath: string, mtimeMs = 0) => makeFileEntry(`/root/${relPath}`, relPath, mtimeMs);
const names = (xs: { relPath: string }[]) => xs.map((x) => x.relPath);
const pri = (highest: string[] = [], preferred: string[] = []): FolderPriority => ({ highest, preferred });

describe('folderPriorityFor', () => {
  it('covers the subtree, separator-aware', () => {
    const p = pri(['/root/Current']);
    expect(folderPriorityFor('/root/Current/A.cmir', p)).toBe(2);
    expect(folderPriorityFor('/root/CurrentX/A.cmir', p)).toBe(0);
    expect(folderPriorityFor('C:\\root\\Cur\\A.cmir', pri([], ['C:\\root\\Cur\\']))).toBe(1);
  });

  it('the deepest entry wins across sections; single files work', () => {
    const p = pri(['/root/Current', '/root/Camp/Key.cmir'], ['/root/Current/Old', '/root/Camp']);
    expect(folderPriorityFor('/root/Current/Old/A.cmir', p)).toBe(1);
    expect(folderPriorityFor('/root/Current/New/A.cmir', p)).toBe(2);
    expect(folderPriorityFor('/root/Camp/Key.cmir', p)).toBe(2);
    expect(folderPriorityFor('/root/Camp/Other.cmir', p)).toBe(1);
  });
});

describe('searchFiles with folder priority', () => {
  // "da" is a prefix (tier 1) of "DA Answers", a word-start (tier 2) in "Warming DA".
  const files = [f('Camp/DA Answers.cmir', 9), f('Current/Warming DA.cmir', 1)];

  it('highest priority lists above better matches elsewhere', () => {
    expect(names(searchFiles(files, 'da', 'recency', pri(['/root/Current'])))).toEqual([
      'Current/Warming DA.cmir',
      'Camp/DA Answers.cmir',
    ]);
  });

  it('preferred wins ties but not against a better match', () => {
    expect(names(searchFiles(files, 'da', 'recency', pri([], ['/root/Current'])))).toEqual([
      'Camp/DA Answers.cmir',
      'Current/Warming DA.cmir',
    ]);
    const tie = [f('Camp/Warming DA.cmir', 9), f('Current/Warming DA.cmir', 1)];
    expect(names(searchFiles(tie, 'warming', 'recency', pri([], ['/root/Current'])))[0])
      .toBe('Current/Warming DA.cmir');
  });

  it('highest-priority results stay ordered by match, then preferred-first', () => {
    const fs = [f('Top/Warming DA.cmir', 9), f('Top/DA Answers.cmir', 1), f('Top/Pref/DA 2.cmir', 1)];
    expect(names(searchFiles(fs, 'da', 'recency', pri(['/root/Top'])))).toEqual([
      'Top/DA Answers.cmir',
      'Top/Pref/DA 2.cmir',
      'Top/Warming DA.cmir',
    ]);
  });

  it('an empty query lists highest, then preferred, then the rest; non-matches stay out', () => {
    const fs = [f('A/x.cmir', 3), f('B/y.cmir', 2), f('C/z.cmir', 1)];
    expect(names(searchFiles(fs, '', 'recency', pri(['/root/C'], ['/root/B'])))).toEqual([
      'C/z.cmir',
      'B/y.cmir',
      'A/x.cmir',
    ]);
    expect(names(searchFiles(fs, 'nothing', 'recency', pri(['/root/C'])))).toEqual([]);
  });
});

describe('priority settings', () => {
  it('sanitize as trimmed, de-duplicated path lists', () => {
    settings.replaceAll({
      fileSearchHighestFolders: [' /a ', '/a', '', 7],
      fileSearchPreferredFolders: 'nope',
    });
    expect(settings.get('fileSearchHighestFolders')).toEqual(['/a']);
    expect(settings.get('fileSearchPreferredFolders')).toEqual([]);
    settings.replaceAll({});
  });
});
