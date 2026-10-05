// @vitest-environment jsdom
/**
 * The binding's identity fast path (patches/loro-prosemirror,
 * cardmirrorSkipLeft / cardmirrorSkipRight): unchanged children are
 * skipped in JS, and the per-child Loro scans resume where identity
 * stops. These pin the shapes that broke it during development, with the
 * suite-wide verification (tests/_setup-jsdom.ts) checking every skip.
 */
import { describe, it, expect } from 'vitest';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { createLoroPeers, syncAll, settle, para, docOf, docText } from './_loro-helpers.js';

/** Position of top-level child `i`. */
function posOf(doc: PMNode, i: number): number {
  let pos = 0;
  for (let k = 0; k < i; k++) pos += doc.child(k).nodeSize;
  return pos;
}

describe('sync fast path', () => {
  it('duplicating a block (an equal copy inserted beside it) syncs exactly', async () => {
    // The overlap shape: the identity prefix stops at the copy; the
    // per-child scan matches the copy to the original's container (equal
    // content) and runs on; a suffix computed BEFORE that scan had
    // already claimed the original — prefix and suffix overlapped and the
    // duplicate never reached the CRDT (partner never saw it).
    const peers = await createLoroPeers(docOf(para('A'), para('B'), para('C')), 2);
    const [p0, p1] = peers as [(typeof peers)[0], (typeof peers)[0]];
    const v = p0.view;
    const b = v.state.doc.child(1);
    v.dispatch(v.state.tr.insert(posOf(v.state.doc, 1), b.type.create(b.attrs, b.content, b.marks)));
    expect(docText(v.state.doc)).toBe('ABBC'.split('').join('\n'));
    await syncAll(peers);
    await settle();
    expect(docText(p1.doc())).toBe(docText(p0.doc()));
    expect(p1.doc().eq(p0.doc())).toBe(true);
    peers.forEach((p) => p.destroy());
  });

  it('pasting a run of copies of the blocks around it syncs exactly', async () => {
    const peers = await createLoroPeers(docOf(para('A'), para('B'), para('C'), para('D')), 2);
    const [p0, p1] = peers as [(typeof peers)[0], (typeof peers)[0]];
    const v = p0.view;
    const copies = [1, 2].map((i) => {
      const n = v.state.doc.child(i);
      return n.type.create(n.attrs, n.content, n.marks);
    });
    v.dispatch(v.state.tr.insert(posOf(v.state.doc, 1), Fragment.from(copies)));
    await syncAll(peers);
    await settle();
    expect(p1.doc().eq(p0.doc())).toBe(true);
    peers.forEach((p) => p.destroy());
  });

  it('typing in the middle of many blocks, then a partner edit at both ends, converges', async () => {
    const blocks = Array.from({ length: 40 }, (_, i) => para(`block ${i}`));
    const peers = await createLoroPeers(docOf(...blocks), 2);
    const [p0, p1] = peers as [(typeof peers)[0], (typeof peers)[0]];
    for (let i = 0; i < 5; i++) {
      p0.view.dispatch(p0.view.state.tr.insertText('x', posOf(p0.view.state.doc, 20) + 3));
    }
    const d1 = p1.view.state.doc;
    p1.view.dispatch(p1.view.state.tr.insertText('<', 1));
    p1.view.dispatch(p1.view.state.tr.insert(p1.view.state.doc.content.size, Fragment.from(para('tail'))));
    void d1;
    await syncAll(peers);
    await settle();
    // Typing after the merge keeps using the fast path on a remotely
    // rendered document.
    p0.view.dispatch(p0.view.state.tr.insertText('y', posOf(p0.view.state.doc, 10) + 2));
    await syncAll(peers);
    await settle();
    expect(p1.doc().eq(p0.doc())).toBe(true);
    expect(docText(p0.doc())).toContain('tail');
    peers.forEach((p) => p.destroy());
  });
});
