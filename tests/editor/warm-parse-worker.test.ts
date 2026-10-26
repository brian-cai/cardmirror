// @vitest-environment node
/**
 * The warm-parse worker sends back only what the palette's search needs
 * (objects + outline) unless a dive asks for the doc — and those objects
 * are exactly what extracting from the parsed doc gives, so a dive on a
 * warmed file (which re-parses for the doc) lists the same results.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toDocx } from '../../src/export/index.js';
import { serializeNative } from '../../src/native/index.js';
import { schema } from '../../src/schema/index.js';
import { extractFile, type FileObjectKind } from '../../src/editor/file-search.js';
import { mixedDoc } from '../collab/_loro-helpers.js';

const KINDS: FileObjectKind[] = ['pocket', 'hat', 'block', 'tag', 'cite', 'analytic'];
const replies: Record<string, unknown>[] = [];
const fake = { postMessage: (m: Record<string, unknown>) => replies.push(m), onmessage: null as ((e: { data: unknown }) => void) | null };
const g = globalThis as unknown as { self?: unknown };

beforeAll(async () => {
  g.self = fake;
  await import('../../src/editor/warm-parse-worker.js');
});
afterAll(() => {
  delete g.self;
});

async function ask(req: Record<string, unknown>): Promise<Record<string, unknown>> {
  replies.length = 0;
  fake.onmessage!({ data: req });
  for (let i = 0; i < 300 && replies.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return replies[0]!;
}

describe('warm-parse worker', () => {
  it('warming gets objects + outline only; a dive also gets the doc, with the same results', async () => {
    for (const format of ['docx', 'cmir'] as const) {
      const bytes = format === 'docx' ? await toDocx(mixedDoc()) : serializeNative(mixedDoc());
      const warm = await ask({ id: 1, bytes, format, kinds: KINDS });
      expect(warm['ok']).toBe(true);
      expect('docJson' in warm).toBe(false);
      expect((warm['objects'] as unknown[]).length).toBeGreaterThan(0);
      const dive = await ask({ id: 2, bytes, format, kinds: KINDS, wantDoc: true });
      expect(dive['objects']).toEqual(warm['objects']);
      expect(dive['outline']).toEqual(warm['outline']);
      // The re-parsed doc a dive gets yields the warm pass's results.
      const re = extractFile(schema.nodeFromJSON(dive['docJson']), new Set(KINDS));
      expect(re.objects).toEqual(warm['objects']);
      expect(re.outline).toEqual(warm['outline']);
    }
  });
});
