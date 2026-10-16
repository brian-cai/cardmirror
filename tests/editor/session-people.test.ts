// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

const prompt = vi.hoisted(() => ({ answer: null as string | null }));
vi.mock('../../src/editor/text-prompt.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/editor/text-prompt.js')>();
  return { ...mod, promptForText: async () => prompt.answer };
});

import { orderPeople, toggleSessionPeople } from '../../src/editor/collab/session-people.js';
import { settings } from '../../src/editor/settings.js';

const people = [
  { name: 'Zed', color: '#111', self: false },
  { name: 'Brian', color: '#222', self: true },
  { name: 'Ana', color: '#333', self: false },
];

describe('session people popover', () => {
  it('lists you first, then everyone else by name', () => {
    expect(orderPeople(people).map((p) => p.name)).toEqual(['Brian', 'Ana', 'Zed']);
  });

  it('opens with the roster and toggles closed on a second click', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    toggleSessionPeople(anchor, () => people);
    const pop = document.querySelector('.pmd-session-people')!;
    expect(pop.querySelector('.pmd-session-people-title')!.textContent).toBe('3 people in this session');
    expect([...pop.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['Brian (you)', 'Ana', 'Zed']);
    toggleSessionPeople(anchor, () => people);
    expect(document.querySelector('.pmd-session-people')).toBeNull();
  });

  it('says so when you are alone', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    toggleSessionPeople(anchor, () => [people[1]!]);
    expect(document.querySelector('.pmd-session-people-title')!.textContent).toBe('Just you in this session');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.pmd-session-people')).toBeNull();
  });

  it('offers Add contact for people who publish a code and are not contacts yet', async () => {
    const ME = 'cmk1.MEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEMEM';
    const ANA = 'cmk1.ANAANAANAANAANAANAANAANAANAANAANAANAANAANA';
    const ZED = 'cmk1.ZEDZEDZEDZEDZEDZEDZEDZEDZEDZEDZEDZEDZEDZED';
    settings.set('pairingOwnCode', ME);
    settings.set('pairingPartners', [{ code: ANA, name: 'Ana' }]);
    const roster = [
      { name: 'Brian', color: '#222', self: true, code: ME },
      { name: 'Ana', color: '#333', self: false, code: ANA },
      { name: 'Zed', color: '#111', self: false, code: ZED },
      { name: 'Old build', color: '#444', self: false },
    ];
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    toggleSessionPeople(anchor, () => roster);
    const rows = () => [...document.querySelectorAll('.pmd-session-people-list li')];
    const withButton = () =>
      rows().filter((li) => li.querySelector('.pmd-session-people-add')).map((li) => li.firstElementChild!.nextSibling!.textContent);
    expect(withButton()).toEqual(['Zed']);
    prompt.answer = 'Zed Q';
    (document.querySelector('.pmd-session-people-add') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(withButton()).toEqual([]));
    expect(settings.get('pairingPartners')).toEqual([
      { code: ANA, name: 'Ana' },
      { code: ZED, name: 'Zed Q' },
    ]);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    settings.set('pairingPartners', []);
  });
});
