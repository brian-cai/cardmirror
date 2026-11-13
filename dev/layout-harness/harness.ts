/**
 * Layout harness (dev/CI only): opens each dialog with large fixture data so
 * scripts/layout-check.cjs can check it fits the window. Scenarios call the
 * dialog functions directly (no clicking through the app), so they open the
 * same way every run.
 *
 * Adding a dialog: add a scenario here that opens it with the most content a
 * real user could have (long names, many rows), and list its class in
 * coverage.ts. tests/editor/layout-coverage.test.ts fails while a dialog
 * class in style.css is in neither list.
 */
import { checkDialog, openDialogs, type Violation } from './checks.js';
import { COVERED } from './coverage.js';
import { pickSessionToJoin, type PastSession, type RejoinCandidate, type TeamSessionRow } from '../../src/editor/collab/rejoin-picker.js';
import { alertDialog, confirmDialog, promptForChoice, promptForRouteChoice, promptForText } from '../../src/editor/text-prompt.js';
import { closeSettings, openSettings } from '../../src/editor/settings-ui.js';
import { visibleCategoryTabs } from '../../src/editor/settings-categories.js';
import { pickRecipient } from '../../src/editor/pairing/send-to-recipient.js';
import { openAddRelayDialog } from '../../src/editor/collab/relay-add-ui.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 12, 18);
const LONG_NAME = 'Neg vs Lincoln HS Quarterfinals — 1AC Space Militarization Aff (Golden Dome)';
const PEOPLE = ['Ana Lopez', 'Ben Wu', 'Sam Lee', 'Priya Natarajan', 'Jordan Okafor-Smith', 'Mia Chen'];

const details = (i: number) => ({
  startedBy: PEOPLE[i % PEOPLE.length],
  people: PEOPLE.slice(0, 2 + (i % 4)),
  usedFrom: NOW - (i + 3) * DAY,
  usedTo: NOW - i * DAY,
  fileName: `${LONG_NAME} ${i}.docx`,
  savedAt: i % 3 ? NOW - i * DAY : null,
});

function recent(n: number): RejoinCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    roomId: `room-${i}`,
    shareCode: `cmshare2.${'x'.repeat(40)}${i}`,
    guestPass: null,
    role: i % 2 ? 'participant' : 'host',
    title: `${LONG_NAME} ${i}`,
    kind: i % 2 ? 'left' : 'saved',
    at: NOW - i * DAY,
    details: details(i),
  }));
}

function teamRows(n: number): TeamSessionRow[] {
  return Array.from({ length: n }, (_, i) => ({
    roomId: `team-${i}`,
    name: `${LONG_NAME} (team ${i})`,
    startedBy: PEOPLE[i % PEOPLE.length]!,
    participants: 1 + (i % 7),
    lastActivity: NOW - i * 60_000,
    mode: i % 2 ? 'request' : 'open',
    shareCode: i % 2 ? null : `cmshare2.team${i}`,
    people: PEOPLE.slice(0, 1 + (i % 6)),
  }));
}

function past(n: number): PastSession[] {
  return Array.from({ length: n }, (_, i) => ({ roomId: `past-${i}`, title: `${LONG_NAME} (past ${i})`, role: 'host', details: details(i) }));
}

const team = (rows: TeamSessionRow[]) => ({
  load: async () => rows,
  request: async () => ({ ok: true, message: 'Request sent' }),
  alreadyRequested: () => false,
  refreshMs: 3_600_000,
});

const LONG_TEXT = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}: the card you sent to Ana Lopez could not be delivered because the relay at https://relay.example-team-with-a-long-name.org/v1/mailbox/cmk1.${'q'.repeat(43)} refused it.`).join('\n');

/** Scenario name → what it opens. Each must leave a dialog open. */
export const SCENARIOS: Record<string, () => void> = {
  'join-empty': () => void pickSessionToJoin([]),
  'join-full': () => void pickSessionToJoin(recent(30), team(teamRows(30)), past(30)),
  'alert-long': () => void alertDialog(LONG_TEXT, { title: 'Some cards were not delivered' }),
  'confirm-long': () => void confirmDialog(LONG_TEXT),
  'choice-many': () =>
    void promptForChoice({
      message: 'Which relay should this go to?',
      detail: LONG_TEXT.slice(0, 600),
      choices: Array.from({ length: 4 }, (_, i) => ({ value: `r${i}`, label: `Relay ${i}: ${LONG_NAME}` })),
    }),
  'route-choice-many': () =>
    void promptForRouteChoice({
      message: 'This document is in a co-editing session. What should happen to it?',
      detail: LONG_TEXT,
      choices: Array.from({ length: 4 }, (_, i) => ({ value: `c${i}`, label: `Choice ${i + 1}`, description: `Write to the existing file, then close. ${LONG_NAME}` })),
    }),
  'send-to-many': () =>
    void pickRecipient(
      Array.from({ length: 80 }, (_, i) => ({
        kind: i % 5 ? 'partner' : 'group',
        ref: `r${i}`,
        label: `${PEOPLE[i % PEOPLE.length]} ${i} — ${LONG_NAME}`,
        sub: i % 5 ? `cmk1.${'a'.repeat(43)}` : `${3 + (i % 9)} people`,
        hidden: i > 70,
      })),
    ),
  'add-relay': () => void openAddRelayDialog(),
  'text-prompt': () =>
    void promptForText({ message: `Rename “${LONG_NAME}”`, detail: LONG_TEXT.slice(0, 400), initial: `${LONG_NAME}.docx` }),
};
for (const tab of visibleCategoryTabs()) {
  SCENARIOS[`settings-${tab.id}`] = () => openSettings({ category: tab.id });
}

function closeAll(): number {
  closeSettings();
  for (let i = 0; i < 5; i++) {
    const open = openDialogs();
    if (!open.length) break;
    for (const el of open) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  // Anything still showing is removed outright so the next scenario starts
  // clean (hidden ones are reused, like Settings', so they stay).
  for (const el of document.querySelectorAll<HTMLElement>('[class*="-overlay"]')) {
    if (!el.hidden && getComputedStyle(el).display !== 'none') el.remove();
  }
  return openDialogs().length;
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Open a scenario, wait until a dialog is laid out, check it. */
async function run(name: string): Promise<{ dialogs: string[]; violations: Violation[] }> {
  const left = closeAll();
  if (left) throw new Error(`${left} dialog(s) still open before ${name}`);
  const open = SCENARIOS[name];
  if (!open) throw new Error(`no scenario ${name}`);
  open();
  const deadline = performance.now() + 5000;
  while (!openDialogs().length) {
    if (performance.now() > deadline) throw new Error(`${name}: no dialog opened`);
    await frame();
  }
  // Async sections (team sessions) and fonts settle, then two frames.
  await new Promise((r) => setTimeout(r, 300));
  await document.fonts.ready;
  await frame();
  await frame();
  const dialogs = openDialogs();
  return {
    dialogs: dialogs.map((d) => [...d.classList].join(' ')),
    violations: dialogs.flatMap(checkDialog),
  };
}

declare global {
  interface Window {
    __layout: { scenarios: string[]; covered: typeof COVERED; run: typeof run; closeAll: typeof closeAll };
  }
}
window.__layout = { scenarios: Object.keys(SCENARIOS), covered: COVERED, run, closeAll };
document.body.dataset['ready'] = '1';
