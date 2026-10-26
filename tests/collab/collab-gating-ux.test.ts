// @vitest-environment jsdom
/**
 * Session-start gating UX (§5.4): a relay 401 on room creation is the
 * "you're not authorized to initiate" signal and must produce an
 * actionable subscription/connect message, not a raw "rooms request
 * failed: 401". Join/resume 401s get the credentials message. Non-401
 * failures keep their reason.
 */
import { describe, it, expect, vi } from 'vitest';
import { relayFailureMessage } from '../../src/editor/collab/collab-ui.js';
import { RoomsError } from '../../src/editor/collab/room-client.js';
import { settings } from '../../src/editor/settings.js';

describe('relay failure messaging (gating 401 UX)', () => {
  it('a 401 on INITIATING names the subscription + self-host token', () => {
    const msg = relayFailureMessage(new RoomsError(401, 'rooms request failed: 401'), {
      initiating: true,
      verb: 'start the session',
    });
    // Must NOT imply a membership is required — self-hosting is valid.
    expect(msg).toMatch(/requires a relay/i);
    expect(msg).not.toMatch(/subscription|membership/i);
    expect(msg).toMatch(/connect your Debate Decoded account or set up your own relay/i);
    expect(msg).not.toMatch(/401/); // not the raw error
  });

  it('a 401 on join/resume gives the credentials message', () => {
    const msg = relayFailureMessage(new RoomsError(401, 'x'), { initiating: false, verb: 'join' });
    expect(msg).toMatch(/rejected your credentials/i);
    expect(msg).toMatch(/connect your Debate Decoded account or set up your own relay/i);
    expect(msg).not.toMatch(/401/);
  });

  it('an unreachable relay gets one plain sentence; a relay’s own reason is kept', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const net = relayFailureMessage(new RoomsError(0, 'network error'), { initiating: true, verb: 'start the session' });
    expect(net).toBe('Couldn’t reach the relay. Try again in a minute.');
    const down = relayFailureMessage(new RoomsError(503, 'rooms request failed: 503'), { initiating: false, verb: 'join' });
    expect(down).toBe('Couldn’t reach the relay. Try again in a minute.');
    expect(down).not.toMatch(/503|rooms request/);
    const odd = relayFailureMessage(new RoomsError(418, 'rooms request failed: 418'), { initiating: false, verb: 'join' });
    expect(odd).not.toMatch(/418|rooms request/);
    const page = relayFailureMessage(new RoomsError(200, 'the relay returned a web page instead of session data (HTTP 200, text/html) from https://x'), { initiating: false, verb: 'join' });
    expect(page).toMatch(/school filter/);
    expect(page).not.toMatch(/HTTP/);
    const cap = relayFailureMessage(new RoomsError(409, 'room is full'), { initiating: false, verb: 'join' });
    expect(cap).toBe('Could not join: room is full');
    expect(warn).toHaveBeenCalled(); // the raw detail goes to the console
    warn.mockRestore();
  });

  it('on a team’s custom relay a 401 says to ask the coach, never Debate Decoded', () => {
    settings.set('pairingRelayUrl', 'https://team.example/relay');
    try {
      const msg = relayFailureMessage(new RoomsError(401, 'x'), { initiating: false, verb: 'join' });
      expect(msg).toBe('Your team’s relay didn’t accept this computer. Ask your coach for a new invite link.');
      expect(msg).not.toMatch(/Debate Decoded/);
    } finally {
      settings.set('pairingRelayUrl', '');
    }
  });
});
