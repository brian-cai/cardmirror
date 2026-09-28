/**
 * The live-view re-derive walk descends only into node types the schema lets
 * hold a `self_ref` (so a keystroke doesn't visit every text node). Pin that
 * set: if the schema ever lets a view nest somewhere new, this fails instead
 * of that view silently never re-deriving.
 */
import { describe, it, expect } from 'vitest';
import { schema } from '../../src/schema/index.js';
import { typesHoldingSelfRef } from '../../src/editor/self-transclusion.js';

describe('typesHoldingSelfRef', () => {
  it('is exactly the containers whose content expression admits a self_ref', () => {
    const names = [...typesHoldingSelfRef(schema)].map((t) => t.name).sort();
    expect(names).toEqual(['doc', 'self_ref', 'transclusion_ref']);
  });

  it('never descends into cards, headings or tables', () => {
    const holders = typesHoldingSelfRef(schema);
    for (const name of ['card', 'tag', 'card_body', 'pocket', 'hat', 'block', 'table', 'paragraph']) {
      expect(holders.has(schema.nodes[name]!)).toBe(false);
    }
  });
});
