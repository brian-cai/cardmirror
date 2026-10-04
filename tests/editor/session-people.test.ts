// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { orderPeople, toggleSessionPeople } from '../../src/editor/collab/session-people.js';

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
});
