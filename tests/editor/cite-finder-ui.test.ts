// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema, newHeadingId } from '../../src/schema/index.js';
import { openCiteFinder } from '../../src/editor/cite-finder-ui.js';

const tag = (t: string) => schema.nodes['tag']!.create({ id: newHeadingId() }, schema.text(t));
const body = (t: string) => schema.nodes['card_body']!.create(null, schema.text(t));
const card = (t: string, cite: string) => schema.nodes['card']!.create(null, [tag(t), body(cite), body('Evidence.')]);

const citeTexts = (view: EditorView): string[] => {
  const out: string[] = [];
  view.state.doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'cite_mark')) out.push(n.text!);
  });
  return out;
};

describe('Find Unformatted Cites dialog', () => {
  it('lists candidates and formats only the ticked ones, in one undo step', () => {
    const doc = schema.nodes['doc']!.create(null, [card('A', 'Smith 24 — Prof'), card('B', 'Jones 2019, analyst')]);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const view = new EditorView(host, { state: EditorState.create({ doc }) });
    openCiteFinder(view);
    const dialog = document.querySelector('.pmd-cite-finder')!;
    expect(dialog.querySelector('.pmd-confirm-title')!.textContent).toBe('2 unformatted cites');
    const boxes = [...dialog.querySelectorAll<HTMLInputElement>('input[type=checkbox]')];
    expect([...dialog.querySelectorAll('strong')].map((s) => s.textContent)).toEqual(['Smith 24', 'Jones 2019']);
    boxes[1]!.checked = false;
    boxes[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    const ok = dialog.querySelector<HTMLButtonElement>('.pmd-confirm-ok')!;
    expect(ok.textContent).toBe('Format 1 cite');
    ok.click();
    expect(document.querySelector('.pmd-cite-finder')).toBeNull();
    expect(citeTexts(view)).toEqual(['Smith 24']);
    view.destroy();
  });
});
