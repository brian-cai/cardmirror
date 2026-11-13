import { afterEach, describe, expect, it } from 'vitest';
import { appTitle, stripAppTitle, windowTitle } from '../../src/editor/app-title.js';
import { __setLiteForTests } from '../../src/editor/lite.js';

describe('app title (which CardMirror this is)', () => {
  afterEach(() => __setLiteForTests(null));

  it('names the build in every window title', () => {
    expect(appTitle()).toBe("CardMirror (BCai's build)");
    expect(windowTitle('1AC.docx')).toBe("1AC.docx — CardMirror (BCai's build)");
    expect(windowTitle(null)).toBe("CardMirror (BCai's build)");
  });

  it('Lite stays plain CardMirror', () => {
    __setLiteForTests(true);
    expect(windowTitle('a.docx')).toBe('a.docx — CardMirror');
  });

  it('strips either build’s suffix, and a bare title is empty', () => {
    expect(stripAppTitle("1AC.docx — CardMirror (BCai's build)")).toBe('1AC.docx');
    expect(stripAppTitle('1AC.docx — CardMirror')).toBe('1AC.docx');
    expect(stripAppTitle('a · b — CardMirror Lite')).toBe('a · b');
    expect(stripAppTitle("CardMirror (BCai's build)")).toBe('');
    expect(stripAppTitle('CardMirror')).toBe('');
    expect(stripAppTitle('Notes on CardMirror (draft).docx')).toBe('Notes on CardMirror (draft).docx');
  });
});
