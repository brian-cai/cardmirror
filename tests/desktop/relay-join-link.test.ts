// @vitest-environment jsdom
// Relay setup links (xtgg-relay://join?url=…&token=…): the strict parse
// main runs before anything reaches the renderer's confirm dialog.
import { describe, expect, it } from 'vitest';
import {
  isRelayJoinArg,
  parseRelayJoinLink,
  pickRelayJoinFromArgv,
} from '../../apps/desktop/src/relay-join-link.js';
import { maskRelayToken } from '../../src/editor/pairing/relay-join.js';

const RELAY = 'https://relay.extinction.gg/r/polyprep';
const TOKEN = 'xr1_abcDEF123-_.~';

function link(params: Record<string, string>, base = 'xtgg-relay://join'): string {
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `${base}?${q}`;
}

function reason(raw: string): string {
  const r = parseRelayJoinLink(raw);
  if (r.ok) throw new Error(`expected rejection, got ${JSON.stringify(r.link)}`);
  return r.reason;
}

describe('parseRelayJoinLink', () => {
  it('accepts the documented shape and decodes both params', () => {
    const r = parseRelayJoinLink(link({ url: RELAY, token: TOKEN }));
    expect(r).toEqual({ ok: true, link: { relayUrl: RELAY, token: TOKEN } });
  });

  it('accepts the example from the spec', () => {
    const r = parseRelayJoinLink(
      'xtgg-relay://join?url=https%3A%2F%2Frelay.extinction.gg%2Fr%2Fpolyprep&token=xr1_abc',
    );
    expect(r).toEqual({ ok: true, link: { relayUrl: RELAY, token: 'xr1_abc' } });
  });

  it('accepts a trailing slash after join and trims trailing slashes off the relay', () => {
    const r = parseRelayJoinLink(link({ url: `${RELAY}//`, token: TOKEN }, 'xtgg-relay://join/'));
    expect(r).toEqual({ ok: true, link: { relayUrl: RELAY, token: TOKEN } });
  });

  it('keeps a non-default port and normalizes a bare origin', () => {
    const r = parseRelayJoinLink(link({ url: 'https://relay.example.com:8443/', token: TOKEN }));
    expect(r).toEqual({ ok: true, link: { relayUrl: 'https://relay.example.com:8443', token: TOKEN } });
  });

  it('rejects other schemes and hosts', () => {
    expect(reason(link({ url: RELAY, token: TOKEN }, 'https://join'))).toMatch(/scheme/);
    expect(reason(link({ url: RELAY, token: TOKEN }, 'xtgg-relay://open'))).toMatch(/host/);
    expect(reason(link({ url: RELAY, token: TOKEN }, 'xtgg-relay://join/extra'))).toMatch(/path/);
    expect(reason(link({ url: RELAY, token: TOKEN }, 'xtgg-relay://u:p@join'))).toMatch(/credentials/);
    expect(reason('not a url')).toMatch(/unparseable/);
    expect(reason('')).toMatch(/empty/);
  });

  it('rejects a missing or repeated url / token', () => {
    expect(reason(link({ token: TOKEN }))).toMatch(/url/);
    expect(reason(link({ url: RELAY }))).toMatch(/token/);
    expect(reason(`${link({ url: RELAY, token: TOKEN })}&url=${encodeURIComponent(RELAY)}`)).toMatch(/url/);
    expect(reason(`${link({ url: RELAY, token: TOKEN })}&token=x`)).toMatch(/token/);
  });

  it('rejects any relay URL that is not plain https', () => {
    for (const url of [
      'http://relay.extinction.gg/r/polyprep',
      'wss://relay.extinction.gg/r/polyprep',
      'javascript:alert(1)',
      'file:///etc/passwd',
      'relay.extinction.gg/r/polyprep',
      '',
    ]) {
      expect(parseRelayJoinLink(link({ url, token: TOKEN })).ok, url).toBe(false);
    }
    expect(reason(link({ url: 'https://a:b@relay.example.com', token: TOKEN }))).toMatch(/credentials/);
    expect(reason(link({ url: `${RELAY}?x=1`, token: TOKEN }))).toMatch(/query/);
    expect(reason(link({ url: `${RELAY}#x`, token: TOKEN }))).toMatch(/fragment/);
    expect(reason(link({ url: `https://relay.example.com/${'a'.repeat(2100)}`, token: TOKEN }))).toMatch(
      /too long/,
    );
  });

  it('rejects empty, whitespace, control-character and oversized tokens', () => {
    for (const token of ['', ' ', 'xr1 abc', 'xr1_abc\n', '\tabc', 'abc\u0000', 'tök', 'a'.repeat(513)]) {
      expect(parseRelayJoinLink(link({ url: RELAY, token })).ok, JSON.stringify(token)).toBe(false);
    }
    // An unencoded '+' decodes to a space, so it is rejected too.
    expect(parseRelayJoinLink(`xtgg-relay://join?url=${encodeURIComponent(RELAY)}&token=a+b`).ok).toBe(false);
    expect(parseRelayJoinLink(link({ url: RELAY, token: 'a'.repeat(512) })).ok).toBe(true);
  });

  it('rejects an oversized link outright', () => {
    expect(reason(`xtgg-relay://join?url=x&pad=${'a'.repeat(5000)}`)).toMatch(/too long/);
  });
});

describe('argv helpers', () => {
  it('finds the link among Chromium switches and file paths', () => {
    const raw = link({ url: RELAY, token: TOKEN });
    const argv = ['C:\\CardMirror\\cardmirror.exe', '--allow-file-access-from-files', raw];
    expect(pickRelayJoinFromArgv(argv)).toBe(raw);
    expect(pickRelayJoinFromArgv(['cardmirror', '/tmp/a.docx'])).toBeNull();
  });

  it('recognizes the scheme case-insensitively and nothing else', () => {
    expect(isRelayJoinArg('XTGG-RELAY://join?url=x')).toBe(true);
    expect(isRelayJoinArg('/Users/me/xtgg-relay.docx')).toBe(false);
    expect(isRelayJoinArg(undefined)).toBe(false);
  });
});

describe('maskRelayToken', () => {
  it('shows the first 8 characters of a normal token', () => {
    expect(maskRelayToken('xr1_abcdefghijkl')).toBe('xr1_abcd…');
  });

  it('shows at most half of a short token', () => {
    expect(maskRelayToken('abcdef')).toBe('abc…');
    expect(maskRelayToken('a')).toBe('…');
  });
});
