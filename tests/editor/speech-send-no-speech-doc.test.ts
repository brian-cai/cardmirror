// @vitest-environment jsdom
/**
 * ` with no speech doc offers a way forward (create one and send, or pick
 * an open doc) instead of an alert naming two unbound commands; ` inside
 * the speech doc drops the red "Marked h:mm" reading marker, as Verbatim
 * marks the card there.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => ({
  choices: [] as { message: string; choices: { value: string; label: string; primary?: boolean }[] }[],
  answer: null as string | null,
  alerts: [] as string[],
}));
vi.mock('../../src/editor/text-prompt.js', async (orig) => ({
  ...(await orig<typeof import('../../src/editor/text-prompt.js')>()),
  promptForChoice: (opts: (typeof prompts.choices)[number]) => {
    prompts.choices.push(opts);
    return Promise.resolve(prompts.answer);
  },
  alertDialog: (m: string) => {
    prompts.alerts.push(m);
    return Promise.resolve();
  },
}));

import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { schema } from '../../src/schema/index.js';
import { sendToSpeech, waitForSpeechDoc } from '../../src/editor/speech-doc-send.js';
import { getSpeechDocResolver } from '../../src/editor/speech-doc-registry.js';

function doc(...children: PMNode[]): PMNode {
  return schema.nodes['doc']!.create(null, children);
}
function card(tag: string, body: string): PMNode {
  return schema.nodes['card']!.create(null, [
    schema.nodes['tag']!.create(null, schema.text(tag)),
    schema.nodes['card_body']!.create(null, schema.text(body)),
  ]);
}
function para(text = ''): PMNode {
  return schema.nodes['paragraph']!.create(null, text ? schema.text(text) : undefined);
}
const views: EditorView[] = [];
function mkView(d: PMNode, uid: string): EditorView {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const v = new EditorView(host, { state: EditorState.create({ doc: d, schema }) });
  getSpeechDocResolver().registerView(uid, v);
  views.push(v);
  return v;
}
function caretInBody(v: EditorView): void {
  let pos = -1;
  v.state.doc.descendants((n, p) => {
    if (n.type.name === 'card_body' && pos < 0) pos = p + 2;
    return true;
  });
  v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, pos)));
}
const settle = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

afterEach(() => {
  const r = getSpeechDocResolver();
  r.setSpeechByUid(null);
  for (const v of views.splice(0)) {
    const uid = r.uidForView(v);
    if (uid) r.unregisterView(uid);
    v.destroy();
  }
  prompts.choices.length = 0;
  prompts.alerts.length = 0;
  prompts.answer = null;
});

describe('` with no speech doc', () => {
  it('offers Create speech doc and send (Enter) and, once made, sends the card into it', async () => {
    const src = mkView(doc(card('MY TAG', 'card body words'), para()), 'src');
    caretInBody(src);
    let speech: EditorView | null = null;
    const createSpeechDoc = vi.fn(async () => {
      speech = mkView(doc(para()), 'speech');
      getSpeechDocResolver().setSpeech(speech);
      return true;
    });
    prompts.answer = 'create';
    sendToSpeech(src, false, undefined, {
      createSpeechDoc,
      resend: () => sendToSpeech(src, false),
    });
    await settle();
    expect(prompts.alerts).toEqual([]);
    expect(prompts.choices).toHaveLength(1);
    const offered = prompts.choices[0]!.choices;
    expect(offered[0]).toMatchObject({ value: 'create', label: 'Create speech doc and send', primary: true });
    // The web has no other windows to pick from.
    expect(offered.map((c) => c.value)).toEqual(['create']);
    expect(createSpeechDoc).toHaveBeenCalledOnce();
    await settle();
    expect(speech!.state.doc.textContent).toContain('MY TAG');
    expect(speech!.state.doc.textContent).toContain('card body words');
  });

  it('Cancel sends nothing and creates nothing', async () => {
    const src = mkView(doc(card('T', 'b'), para()), 'src');
    caretInBody(src);
    const createSpeechDoc = vi.fn(async () => true);
    const resend = vi.fn();
    sendToSpeech(src, false, undefined, { createSpeechDoc, resend });
    await settle();
    expect(prompts.choices).toHaveLength(1);
    expect(createSpeechDoc).not.toHaveBeenCalled();
    expect(resend).not.toHaveBeenCalled();
  });

  it('a cancelled New Speech Document prompt sends nothing', async () => {
    const src = mkView(doc(card('T', 'b'), para()), 'src');
    const resend = vi.fn();
    prompts.answer = 'create';
    sendToSpeech(src, false, undefined, { createSpeechDoc: async () => false, resend });
    await settle();
    expect(resend).not.toHaveBeenCalled();
  });

  it('where no speech doc can be made or picked, says how to get one', async () => {
    const src = mkView(doc(card('T', 'b'), para()), 'src');
    sendToSpeech(src, false, undefined, { resend: () => {} });
    await settle();
    expect(prompts.choices).toHaveLength(0);
    expect(prompts.alerts[0]).toMatch(/Mark active doc as speech/);
  });
});

describe('waitForSpeechDoc', () => {
  it('waits for a designation other than the source, and times out', async () => {
    const r = getSpeechDocResolver();
    const src = mkView(doc(para()), 'src');
    r.setSpeech(src);
    expect(await waitForSpeechDoc('src', 20)).toBe(false);
    const other = mkView(doc(para()), 'other');
    const p = waitForSpeechDoc('src', 1000);
    r.setSpeech(other);
    expect(await p).toBe(true);
  });
});

describe('` inside the speech doc', () => {
  it('drops a red "Marked h:mm" at the cursor, and again on it removes it', () => {
    const speech = mkView(doc(card('T', 'body'), para()), 'speech');
    getSpeechDocResolver().setSpeech(speech);
    caretInBody(speech);
    sendToSpeech(speech, false);
    expect(speech.state.doc.textContent).toMatch(/Marked \d{1,2}:\d{2}/);
    let red = false;
    speech.state.doc.descendants((n) => {
      if (n.isText && /Marked/.test(n.text ?? '')) {
        red = n.marks.some((m) => m.type.name === 'font_color' && m.attrs['color'] === 'FF0000');
      }
      return true;
    });
    expect(red).toBe(true);
    // The caret sits just after the marker; ` again toggles it off.
    sendToSpeech(speech, true);
    expect(speech.state.doc.textContent).not.toMatch(/Marked/);
    expect(prompts.choices).toHaveLength(0);
  });
});
