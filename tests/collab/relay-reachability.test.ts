import { describe, expect, it } from 'vitest';
import {
  ALERT_AFTER_MS,
  LONG_OUTAGE_MS,
  MIN_OUTAGE_MS,
  REARM_MS,
  inMaintenanceWindow,
  initialReachability,
  maintenanceWindowFor,
  outageText,
  outcomeForStatus,
  record,
  statusLinkFor,
  tick,
} from '../../src/editor/collab/relay-reachability';
import { parseRelayInfo } from '../../src/editor/collab/relay-info';

const B = 'https://relay.extinction.gg/r/collegiate';
const T0 = Date.UTC(2026, 9, 23, 15, 0, 0);

describe('outcomeForStatus', () => {
  it('only no-answer and 5xx count as down', () => {
    expect(outcomeForStatus(0)).toBe('down');
    expect(outcomeForStatus(502)).toBe('down');
    expect(outcomeForStatus(503)).toBe('down');
    for (const s of [200, 204, 304, 401, 403, 404, 409, 410, 429]) expect(outcomeForStatus(s)).toBe('ok');
  });
});

describe('record / tick', () => {
  it('two failures in the same instant are a blip, not an outage', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + 10);
    expect(s.alerted).toBe(false);
  });

  it('two failures spanning MIN_OUTAGE_MS alert', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + MIN_OUTAGE_MS);
    expect(s.alerted).toBe(true);
  });

  it('one long unbroken failure alerts on a tick after ALERT_AFTER_MS', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    expect(tick(s, T0 + ALERT_AFTER_MS - 1).alerted).toBe(false);
    s = tick(s, T0 + ALERT_AFTER_MS);
    expect(s.alerted).toBe(true);
  });

  it('the first answer clears it', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + MIN_OUTAGE_MS);
    s = record(s, B, 'ok', T0 + 30_000);
    expect(s.alerted).toBe(false);
    expect(s.failures).toBe(0);
    expect(s.since).toBeNull();
    expect(s.clearedAt).toBe(T0 + 30_000);
  });

  it('flapping: a new outage soon after a bar needs LONG_OUTAGE_MS', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + MIN_OUTAGE_MS);
    const back = T0 + 20_000;
    s = record(s, B, 'ok', back);
    s = record(s, B, 'down', back + 1_000);
    s = record(s, B, 'down', back + 1_000 + ALERT_AFTER_MS);
    expect(s.alerted).toBe(false);
    s = tick(s, back + 1_000 + LONG_OUTAGE_MS);
    expect(s.alerted).toBe(true);
  });

  it('after REARM_MS the normal rule applies again', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + MIN_OUTAGE_MS);
    s = record(s, B, 'ok', T0 + 10_000);
    const later = T0 + 10_000 + REARM_MS;
    s = record(s, B, 'down', later);
    s = record(s, B, 'down', later + MIN_OUTAGE_MS);
    expect(s.alerted).toBe(true);
  });

  it('a relay switch starts over and never carries the bar', () => {
    let s = record(initialReachability(B), B, 'down', T0);
    s = record(s, B, 'down', T0 + MIN_OUTAGE_MS);
    expect(s.alerted).toBe(true);
    s = record(s, 'https://other.example', 'down', T0 + 6_000);
    expect(s.alerted).toBe(false);
    expect(s.failures).toBe(1);
    expect(s.base).toBe('https://other.example');
  });

  it('answers that are refusals (401) never start a streak', () => {
    const s = record(initialReachability(B), B, outcomeForStatus(401), T0);
    expect(s.since).toBeNull();
  });
});

describe('maintenance window and wording', () => {
  it('uses the relay’s published window, else the known xtgg window, else none', () => {
    expect(maintenanceWindowFor(B, { dailyUtc: '03:00', minutes: 10 })).toEqual({ dailyUtc: '03:00', minutes: 10 });
    expect(maintenanceWindowFor(B, null)).toEqual({ dailyUtc: '09:00', minutes: 30 });
    expect(maintenanceWindowFor('https://relay.example.org', null)).toBeNull();
  });

  it('checks the window in UTC, wrapping past midnight', () => {
    const w = { dailyUtc: '09:00', minutes: 30 };
    expect(inMaintenanceWindow(w, Date.UTC(2026, 9, 23, 9, 0))).toBe(true);
    expect(inMaintenanceWindow(w, Date.UTC(2026, 9, 23, 9, 29))).toBe(true);
    expect(inMaintenanceWindow(w, Date.UTC(2026, 9, 23, 9, 30))).toBe(false);
    expect(inMaintenanceWindow(w, Date.UTC(2026, 9, 23, 8, 59))).toBe(false);
    const wrap = { dailyUtc: '23:50', minutes: 20 };
    expect(inMaintenanceWindow(wrap, Date.UTC(2026, 9, 23, 0, 5))).toBe(true);
    expect(inMaintenanceWindow(wrap, Date.UTC(2026, 9, 23, 0, 15))).toBe(false);
    expect(inMaintenanceWindow(null, T0)).toBe(false);
  });

  it('links the relay’s status page, else xtgg’s for its hosts, else nothing', () => {
    expect(statusLinkFor(B, 'https://status.relay.example/')).toBe('https://status.relay.example/');
    expect(statusLinkFor(B, '')).toBe('https://relaystatus.extinction.gg');
    expect(statusLinkFor('https://relay.example.org', '')).toBe('');
  });

  it('says restarting in the window, and mentions local edits in a session', () => {
    expect(outageText({ maintenance: false, inSession: false })).toBe('The relay isn’t answering. Retrying…');
    expect(outageText({ maintenance: true, inSession: false })).toMatch(/may be restarting for updates/);
    expect(outageText({ maintenance: false, inSession: true })).toMatch(/edits are kept on this computer/);
  });
});

describe('relay info maintenance field', () => {
  it('parses a valid window and ignores malformed ones', () => {
    expect(parseRelayInfo({ v: 1, maintenance: { dailyUtc: '09:00', minutes: 30 } })?.maintenance).toEqual({
      dailyUtc: '09:00',
      minutes: 30,
    });
    for (const bad of [{ dailyUtc: '9:00', minutes: 30 }, { dailyUtc: '25:00', minutes: 30 }, { dailyUtc: '09:00', minutes: 0 }, 'x']) {
      expect(parseRelayInfo({ v: 1, maintenance: bad })?.maintenance).toBeUndefined();
    }
  });
});
