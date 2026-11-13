/**
 * Which dialogs the layout check covers (dev/layout-harness, run in CI by
 * scripts/layout-check.cjs). tests/editor/layout-coverage.test.ts fails when
 * style.css has a `.pmd-*-dialog` class in neither list, so a new dialog
 * gets a scenario (or a reason it can wait) before it ships.
 */

/** Dialog class → the harness scenarios that open it. */
export const COVERED: Record<string, string[]> = {
  'pmd-route-dialog': ['alert-long', 'confirm-long', 'choice-many', 'route-choice-many', 'text-prompt', 'join-full'],
  'pmd-text-prompt-dialog': ['alert-long', 'confirm-long', 'choice-many', 'text-prompt'],
  'pmd-rejoin-dialog': ['join-empty', 'join-full'],
  'pmd-settings-dialog': ['settings-general', 'settings-shortcuts', 'settings-pairing'],
  'pmd-list-pick-dialog': ['send-to-many'],
  'pmd-add-relay-dialog': ['add-relay'],
};

/** Not covered yet, each with why. Fixed-size dialogs whose content doesn't
 *  grow with the user's data are the least likely to break. */
export const PENDING: Record<string, string> = {
  'pmd-bench-dialog': 'developer benchmark tool, not shipped to users',
  'pmd-bulk-dialog': 'needs a folder of files picked first',
  'pmd-card-preview-dialog': 'needs a card from a live document',
  'pmd-cardcutter-dialog': 'card cutter engine plugin; needs the engine loaded',
  'pmd-clean-overwrite-dialog': 'fixed text, opened mid clean-styles flow',
  'pmd-clean-prot-dialog': 'opened mid clean-styles flow',
  'pmd-clod-dialog': 'AI configurator; needs an AI provider set up',
  'pmd-learn-create-dialog': 'needs a selection in a live document',
  'pmd-morph-dialog': 'needs a live document',
  'pmd-plugin-browse-dialog': 'lists plugins from GitHub (network)',
  'pmd-plugin-settings-dialog': 'needs an installed plugin',
  'pmd-prompt-dialog': 'AI edit prompt; needs a live document',
  'pmd-qc-add-dialog': 'needs a selection in a live document',
  'pmd-recover-dialog': 'grows with crash-recovery drafts: next to add (needs the drafts store seeded)',
  'pmd-reference-dialog': 'needs a live document',
  'pmd-save-as-dialog': 'needs a live document and the host file system',
  'pmd-select-speech-dialog': 'grows with open documents: next to add (needs open docs)',
};
