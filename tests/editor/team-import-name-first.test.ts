// @vitest-environment jsdom
/** Import team asks for your display name before the file picker. */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls = vi.hoisted(() => ({ order: [] as string[], name: null as string | null }));

vi.mock('../../src/editor/text-prompt.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/text-prompt.js')>();
  return {
    ...mod,
    promptForText: async (opts: { message: string }) => {
      calls.order.push(`prompt:${opts.message}`);
      return calls.name;
    },
  };
});

vi.mock('../../src/editor/toast.js', () => ({ showToast: vi.fn() }));
// benchmark-ui pulls in editor/index.ts, which wires the real app DOM on import.
vi.mock('../../src/editor/benchmark-ui.js', () => ({ launchBenchmarkOverlay: vi.fn() }));
vi.mock('../../src/editor/host/index.js', () => {
  const host = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'kind') return 'electron';
        if (prop === 'openFile') {
          return async () => {
            calls.order.push('openFile');
            return null; // user cancels the picker
          };
        }
        return () => Promise.resolve(undefined);
      },
    },
  );
  return { getElectronHost: () => host, getHost: () => host, isWindowsHost: () => false };
});

import { importTeamFile } from '../../src/editor/settings-ui.js';
import { settings } from '../../src/editor/settings.js';

beforeEach(() => {
  calls.order.length = 0;
  settings.set('pairingDisplayName', '');
});

describe('Import team: display name first', () => {
  it('asks for the name, saves it, then opens the picker', async () => {
    calls.name = 'Ana Lopez';
    expect(await importTeamFile()).toBe(false);
    expect(calls.order).toEqual(['prompt:Your display name', 'openFile']);
    expect(settings.get('pairingDisplayName')).toBe('Ana Lopez');
  });

  it('cancelling the name prompt cancels the import', async () => {
    calls.name = null;
    expect(await importTeamFile()).toBe(false);
    expect(calls.order).toEqual(['prompt:Your display name']);
  });
});
