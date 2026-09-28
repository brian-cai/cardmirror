/**
 * Ribbon command metadata: the static command ids, their labels, palette
 * aliases and default keys, and the key-string helpers (display, capture,
 * folding). Everything here is data or pure functions over it, with no
 * dependency on the command implementations in ribbon-commands.ts.
 *
 * Split out so the UI modules that only need labels and keys (settings,
 * the keybindings editor, the command palette, the tour, ribbon groups)
 * don't import ribbon-commands.ts, which imports several of them back:
 * that loop made up most of the editor's circular imports.
 * ribbon-commands.ts re-exports all of it, so existing imports still work.
 */

import { getHost } from './host/index.js';
import {
  pluginCommandKeywords,
  pluginCommandLabel,
  pluginDefaultKey,
} from './plugin-registry.js';

/**
 * Stable identifiers for editor command bindings. The settings UI
 * stores user overrides keyed by these IDs — not by the current
 * key string — so renaming a default key doesn't strand user
 * customizations.
 *
 * `StructuralRibbonCommandId` is the subset rendered as buttons in
 * the formatting panel.
 */
export type StructuralRibbonCommandId =
  | 'setPocket'
  | 'setHat'
  | 'setBlock'
  | 'setTag'
  | 'setAnalytic'
  | 'setUndertag';

export type RibbonCommandId =
  | StructuralRibbonCommandId
  | 'undo'
  | 'redo'
  | 'moveContainerUp'
  | 'moveContainerDown'
  | 'toggleBold'
  | 'toggleItalic'
  | 'toggleStrikethrough'
  | 'toggleSuperscript'
  | 'toggleSubscript'
  | 'applyCite'
  | 'applyUnderline'
  | 'toggleUnderlineTyping'
  | 'toggleReadingMarker'
  | 'applyEmphasis'
  | 'applyEmphasisAndShading'
  | 'emphasizeAcronym'
  | 'applyHighlight'
  | 'highlightAcronym'
  | 'underlineAcronym'
  | 'applyShading'
  | 'condenseDefault'
  | 'condenseNoIntegrity'
  | 'condenseNoIntegrityWithPilcrows'
  | 'condenseWithWarning'
  | 'condenseAndShrink'
  | 'uncondense'
  | 'toggleCase'
  | 'copyPreviousCite'
  | 'pasteAsText'
  | 'pasteCondensed'
  | 'clearToNormal'
  | 'shrink'
  | 'smartShrink'
  | 'regrow'
  | 'createReference'
  | 'lockHighlighting'
  | 'extractUndertag'
  | 'highlightToShading'
  | 'shadingToHighlight'
  | 'standardizeHighlight'
  | 'standardizeShading'
  | 'standardizeHighlightExcept'
  | 'standardizeShadingExcept'
  | 'convertCardsToReadMode'
  | 'toggleReadMode'
  | 'toggleReaderView'
  | 'openContainingFolder'
  | 'saveWorkspace'
  | 'reopenWorkspace'
  | 'arrangeWindows'
  | 'toggleCommentsVisible'
  | 'addCommentToSelection'
  | 'addNoteToSelection'
  | 'aiAskAboutSelection'
  | 'aiCreateCite'
  | 'reformatAllCites'
  | 'translate'
  | 'repairText'
  | 'repairFormatting'
  | 'repairParagraphIntegrity'
  | 'sendToFlowColumn'
  | 'sendToFlowCell'
  | 'sendHeadingsToFlowColumn'
  | 'sendHeadingsToFlowCell'
  | 'pullFromFlow'
  | 'createFlow'
  | 'startFlowHost'
  | 'toggleVoice'
  | 'calibrateVoice'
  | 'openCardCutter'
  | 'addCutterContext'
  | 'openCutterGuidance'
  | 'createFlashcard'
  | 'manageFlashcards'
  | 'wordCountSelection'
  | 'openShortcutsReference'
  | 'startUiTour'
  | 'selectSimilar'
  | 'removeHyperlinks'
  | 'linkUrls'
  | 'convertAnalyticsToTags'
  | 'convertCitedAnalyticsToTags'
  | 'fixFormattingGaps'
  | 'insertTable'
  | 'addRowAfter'
  | 'addRowBefore'
  | 'deleteTableRow'
  | 'addColumnAfter'
  | 'addColumnBefore'
  | 'deleteTableColumn'
  | 'mergeTableCells'
  | 'splitTableCell'
  | 'deleteTable'
  | 'newDocument'
  | 'openFile'
  | 'save'
  | 'saveAs'
  | 'saveSendDoc'
  | 'saveReadDoc'
  | 'saveMarkedCards'
  | 'toggleAutosave'
  | 'newSpeechDocument'
  | 'markActiveAsSpeech'
  | 'sendToSpeechAtCursor'
  | 'sendToSpeechAtEnd'
  | 'sendToDropzone'
  | 'insertLiveZone'
  | 'insertSelfLiveZone'
  | 'insertInDocCopy'
  | 'refreshLiveZone'
  | 'refreshAllLiveZones'
  | 'checkLiveZoneSources'
  | 'detachLiveZone'
  | 'sendToStarred'
  | 'sendToRecipient'
  | 'insertReceivedAtCursor'
  | 'insertReceivedAtEnd'
  | 'previewReceived'
  // Select / copy the cursor's enclosing structure (the current card /
  // analytic_unit / heading + its subtree), reusing the send-to-*
  // bounds logic but keyed off the cursor — any active selection is
  // ignored. No default bindings — wire up via Settings → Keyboard shortcuts.
  | 'selectCurrentHeading'
  | 'deleteCurrentHeading'
  // Jump the caret to the next / previous heading of ONE level —
  // PageUp / PageDown stop at every heading. No default bindings.
  | 'nextPocket'
  | 'prevPocket'
  | 'nextHat'
  | 'prevHat'
  | 'nextBlock'
  | 'prevBlock'
  | 'nextTag'
  | 'prevTag'
  // Auto-numbering skeleton authoring (NUMBERING_PLAN.md §4).
  | 'toggleNumberRole'
  | 'toggleSubRole'
  | 'toggleNumRestart'
  | 'copyCurrentHeading'
  | 'copyCardsWithMatchingCite'
  // Quick Cards (see reference-docs/SPEC-quick-cards.md). Add saves the
  // current selection as a named, tagged snippet (no default binding);
  // the search palette opens on Mod-Shift-Space.
  | 'addQuickCard'
  | 'manageQuickCards'
  | 'openQuickCardSearch'
  | 'collabStartSession'
  | 'collabJoinSession'
  | 'collabCopyShareCode'
  | 'collabCopyInviteLink'
  | 'collabInviteStarred'
  | 'collabEndSession'
  | 'insertImage'
  | 'openDevConsole'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'chromeScaleUp'
  | 'chromeScaleDown'
  | 'chromeScaleReset'
  | 'togglePaintbrushHighlight'
  | 'togglePaintbrushShading'
  | 'openFind'
  | 'openFindReplace'
  | 'openFindByProximity'
  | 'toggleNavPane'
  // Set the navigation pane's depth, same as its 1 · 2 · 3 · 4 buttons.
  // No default bindings.
  | 'setNavDepth1'
  | 'setNavDepth2'
  | 'setNavDepth3'
  | 'setNavDepth4'
  // Commands that ship without a default binding — bindable via
  // Settings → Keyboard shortcuts. Each maps to a ribbon button or
  // menu item.
  | 'adjustFontSizeUp'
  | 'adjustFontSizeDown'
  | 'applyFontColor'
  | 'openSettings'
  // Minimize the OS window. Desktop-only; the macOS Window menu's
  // Minimize item routes through this same command so its accelerator
  // follows user rebinds (Mod-m default restores the stock Cmd+M).
  | 'minimizeWindow'
  // Jump to another CardMirror window by typing its name (the `w `
  // palette source). In the three-pane workspace, the focused slot's
  // doc switcher instead — there the "windows" are the slot's docs.
  | 'switchWindow'
  | 'openJournalsFolder'
  // Arm/disarm Morph mode (the Sensel control-surface interpreter).
  // No default key — bind via Settings, or run from the command bar.
  | 'toggleMorphMode'
  // Open an earlier state of a co-edited document as its own unsaved
  // copy, from the session-history file. No default key.
  | 'recoverPreviousVersion'
  // Cycle the theme setting light → dark → system → light. No default
  // binding; bind via Settings → Keyboard shortcuts.
  | 'cycleTheme'
  // Cycle the timer profile College → High School → Pomodoro (wraps),
  // applying its durations. No default binding.
  | 'cycleTimerPreset'
  // Flip every curly quote in the selection to the opposite direction. No
  // default binding.
  | 'flipQuoteDirection'
  | 'toggleParagraphIntegrity'
  | 'selectSpeechDoc'
  | 'goHome'
  | 'openHighlightPicker'
  | 'openShadingPicker'
  | 'openFontColorPicker'
  | 'openFontSizePicker'
  | 'resetDefaultColors'
  | 'openDocToolsMenu'
  | 'openCardToolsMenu'
  | 'openTableMenu'
  // Multi-pane workspace navigation, listed for user-rebindability
  // via Settings → Keyboard shortcuts; the shell owns the
  // implementations and the global keydown handler in
  // editor/index.ts dispatches when the key fires. No-ops in
  // single-doc mode.
  | 'focusSlot1'
  | 'focusSlot2'
  | 'focusSlot3'
  | 'sendDocToSlot1'
  | 'sendDocToSlot2'
  | 'sendDocToSlot3'
  | 'toggleSlotExpand'
  | 'hideSlot'
  | 'revealAllSlots'
  | 'cycleDocNext'
  | 'cycleDocPrev'
  // Smart close — closes the focused slot's visible doc in
  // multi-pane mode; falls through to the standard window-close
  // prompt otherwise. Menu accelerator (Ctrl+W) stays
  // hardcoded as a discoverability cue; this registry entry is
  // the user-rebindable layer.
  | 'closeDocOrWindow'
  // Timer transport. All gated on the timer panel being visible
  // (they return false when it's hidden so the key falls through);
  // none has a default binding — wire up via Settings → Keyboard
  // shortcuts.
  // Timer state is BroadcastChannel-synced, so a key press in one
  // window drives the clocks in every window, like the buttons.
  // Show/hide is the one timer command NOT gated on visibility —
  // its whole point is bringing the panel up. Mirrors the ribbon
  // timer button (aria-pressed toggle in index.ts).
  // Insert an empty footnote at the cursor and open its editor.
  // No default binding and no menu entry — a keyboard-only power
  // feature.
  | 'insertFootnote'
  | 'timerToggleVisible'
  | 'timerStartPause'
  | 'timerPreset1'
  | 'timerPreset2'
  | 'timerPreset3'
  | 'timerStartAffPrep'
  | 'timerStartNegPrep'
  | 'timerReset';

export const STRUCTURAL_RIBBON_COMMAND_IDS: StructuralRibbonCommandId[] = [
  'setPocket',
  'setHat',
  'setBlock',
  'setTag',
  'setAnalytic',
  'setUndertag',
];

export const RIBBON_COMMAND_IDS: RibbonCommandId[] = [
  ...STRUCTURAL_RIBBON_COMMAND_IDS,
  'undo',
  'redo',
  'moveContainerUp',
  'moveContainerDown',
  'toggleBold',
  'toggleItalic',
  'toggleStrikethrough',
  'toggleSuperscript',
  'toggleSubscript',
  'applyCite',
  'applyUnderline',
  'toggleUnderlineTyping',
  'toggleReadingMarker',
  'applyEmphasis',
  'applyEmphasisAndShading',
  'emphasizeAcronym',
  'applyHighlight',
  'highlightAcronym',
  'underlineAcronym',
  'applyShading',
  'condenseDefault',
  'condenseNoIntegrity',
  'condenseNoIntegrityWithPilcrows',
  'condenseWithWarning',
  'condenseAndShrink',
  'uncondense',
  'toggleCase',
  'copyPreviousCite',
  'pasteAsText',
  'pasteCondensed',
  'clearToNormal',
  'shrink',
  'smartShrink',
  'regrow',
  'createReference',
  'lockHighlighting',
  'extractUndertag',
  'highlightToShading',
  'shadingToHighlight',
  'standardizeHighlight',
  'standardizeShading',
  'standardizeHighlightExcept',
  'standardizeShadingExcept',
  'convertCardsToReadMode',
  'toggleReadMode',
  'toggleReaderView',
  'openContainingFolder',
  'saveWorkspace',
  'reopenWorkspace',
  'arrangeWindows',
  'toggleCommentsVisible',
  'addCommentToSelection',
  'addNoteToSelection',
  'aiAskAboutSelection',
  'aiCreateCite',
  'reformatAllCites',
  'translate',
  'repairText',
  'repairFormatting',
  'repairParagraphIntegrity',
  'sendToFlowColumn',
  'sendToFlowCell',
  'sendHeadingsToFlowColumn',
  'sendHeadingsToFlowCell',
  'pullFromFlow',
  'createFlow',
  'startFlowHost',
  'toggleVoice',
  'calibrateVoice',
  'openCardCutter',
  'addCutterContext',
  'openCutterGuidance',
  'createFlashcard',
  'manageFlashcards',
  'wordCountSelection',
  'openShortcutsReference',
  'startUiTour',
  'selectSimilar',
  'removeHyperlinks',
  'linkUrls',
  'convertAnalyticsToTags',
  'convertCitedAnalyticsToTags',
  'fixFormattingGaps',
  'insertTable',
  'addRowAfter',
  'addRowBefore',
  'deleteTableRow',
  'addColumnAfter',
  'addColumnBefore',
  'deleteTableColumn',
  'mergeTableCells',
  'splitTableCell',
  'deleteTable',
  'newDocument',
  'openFile',
  'save',
  'saveAs',
  'saveSendDoc',
  'saveReadDoc',
  'saveMarkedCards',
  'toggleAutosave',
  'newSpeechDocument',
  'markActiveAsSpeech',
  'sendToSpeechAtCursor',
  'sendToSpeechAtEnd',
  'sendToDropzone',
  'insertLiveZone',
  'insertSelfLiveZone',
  'insertInDocCopy',
  'refreshLiveZone',
  'refreshAllLiveZones',
  'checkLiveZoneSources',
  'detachLiveZone',
  'sendToStarred',
  'sendToRecipient',
  'insertReceivedAtCursor',
  'insertReceivedAtEnd',
  'previewReceived',
  'selectCurrentHeading',
  'deleteCurrentHeading',
  'nextPocket',
  'prevPocket',
  'nextHat',
  'prevHat',
  'nextBlock',
  'prevBlock',
  'nextTag',
  'prevTag',
  'toggleNumberRole',
  'toggleSubRole',
  'toggleNumRestart',
  'copyCurrentHeading',
  'copyCardsWithMatchingCite',
  'addQuickCard',
  'manageQuickCards',
  'openQuickCardSearch',
  'collabStartSession',
  'collabJoinSession',
  'collabCopyShareCode',
  'collabCopyInviteLink',
  'collabInviteStarred',
  'collabEndSession',
  'insertImage',
  'openDevConsole',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'chromeScaleUp',
  'chromeScaleDown',
  'chromeScaleReset',
  'togglePaintbrushHighlight',
  'togglePaintbrushShading',
  'openFind',
  'openFindReplace',
  'openFindByProximity',
  'toggleNavPane',
  'setNavDepth1',
  'setNavDepth2',
  'setNavDepth3',
  'setNavDepth4',
  // Bindable ribbon actions with no default keys.
  'adjustFontSizeUp',
  'adjustFontSizeDown',
  'applyFontColor',
  'openSettings',
  'minimizeWindow',
  'switchWindow',
  'openJournalsFolder',
  'toggleMorphMode',
  'recoverPreviousVersion',
  'cycleTheme',
  'cycleTimerPreset',
  'flipQuoteDirection',
  'toggleParagraphIntegrity',
  'selectSpeechDoc',
  'goHome',
  'openHighlightPicker',
  'openShadingPicker',
  'openFontColorPicker',
  'openFontSizePicker',
  'resetDefaultColors',
  'openDocToolsMenu',
  'openCardToolsMenu',
  'openTableMenu',
  'focusSlot1',
  'focusSlot2',
  'focusSlot3',
  'sendDocToSlot1',
  'sendDocToSlot2',
  'sendDocToSlot3',
  'toggleSlotExpand',
  'hideSlot',
  'revealAllSlots',
  'cycleDocNext',
  'cycleDocPrev',
  'closeDocOrWindow',
  'insertFootnote',
  'timerToggleVisible',
  'timerStartPause',
  'timerPreset1',
  'timerPreset2',
  'timerPreset3',
  'timerStartAffPrep',
  'timerStartNegPrep',
  'timerReset',
];

export const RIBBON_COMMAND_LABELS: Record<RibbonCommandId, string> = {
  undo: 'Undo',
  redo: 'Redo',
  setPocket: 'Apply Pocket Style',
  setHat: 'Apply Hat Style',
  setBlock: 'Apply Block Style',
  setTag: 'Apply Tag Style',
  setAnalytic: 'Apply Analytic Style',
  setUndertag: 'Apply Undertag Style',
  moveContainerUp: 'Move Container Up',
  moveContainerDown: 'Move Container Down',
  toggleBold: 'Bold',
  toggleItalic: 'Italic',
  toggleStrikethrough: 'Strikethrough',
  toggleSuperscript: 'Superscript',
  toggleSubscript: 'Subscript',
  applyCite: 'Apply Cite Style',
  applyUnderline: 'Toggle Underline',
  toggleUnderlineTyping: 'Underline (toggle while typing)',
  toggleReadingMarker: 'Reading-position marker (toggle)',
  applyEmphasis: 'Apply Emphasis Style',
  applyEmphasisAndShading: 'Emphasis + Background Color',
  emphasizeAcronym: 'Emphasize Acronym',
  applyHighlight: 'Toggle Highlight',
  highlightAcronym: 'Highlight Acronym',
  underlineAcronym: 'Underline Acronym',
  applyShading: 'Toggle Background Color',
  condenseDefault: 'Condense',
  condenseNoIntegrity: 'Condense Without Paragraph Integrity',
  condenseNoIntegrityWithPilcrows: 'Condense Without Paragraph Integrity (With Pilcrows)',
  condenseWithWarning: 'Condense With Warning',
  condenseAndShrink: 'Condense With Warning and Shrink',
  uncondense: 'Uncondense',
  toggleCase: 'Toggle Case',
  copyPreviousCite: 'Copy Previous Cite',
  pasteAsText: 'Paste Plain Text',
  pasteCondensed: 'Paste and Destructively Condense',
  clearToNormal: 'Clear',
  shrink: 'Shrink Card Text',
  smartShrink: 'Smart Shrink (Deeper for Unmarked Paragraphs)',
  regrow: 'Restore Card Text Size',
  createReference: 'Create Reference',
  lockHighlighting: 'Lock Highlighting',
  extractUndertag: 'Extract Undertag',
  highlightToShading: 'Highlight to Background',
  shadingToHighlight: 'Background to Highlight',
  standardizeHighlight: 'Standardize Highlighting',
  standardizeShading: 'Standardize Background Color',
  standardizeHighlightExcept: 'Standardize Highlighting (with Exception)',
  standardizeShadingExcept: 'Standardize Background Color (with Exception)',
  convertCardsToReadMode: 'Convert Cards to Read Mode',
  toggleReadMode: 'Toggle Read Mode',
  toggleReaderView: 'Toggle Reading View',
  openContainingFolder: 'Open Containing Folder',
  saveWorkspace: 'Save Workspace',
  reopenWorkspace: 'Reopen Last Workspace',
  arrangeWindows: 'Arrange Windows',
  toggleCommentsVisible: 'Show / Hide Comments',
  addCommentToSelection: 'Add Comment to Selection',
  addNoteToSelection: 'Add Note to Selection',
  aiAskAboutSelection: 'Ask AI About Selection',
  aiCreateCite: 'Format Cite From Selection (AI)',
  reformatAllCites: 'Reformat Every Cite in Document (AI)',
  translate: 'Translate Selection to Clipboard (AI)',
  repairText: 'Repair OCR/PDF Text (AI)',
  repairFormatting: 'Repair Formatting (AI)',
  repairParagraphIntegrity: 'Repair Paragraph Integrity',
  sendToFlowColumn: 'Send to Flow (one cell per line)',
  sendToFlowCell: 'Send to Flow (single cell)',
  sendHeadingsToFlowColumn: 'Send Headings to Flow (one cell per line)',
  sendHeadingsToFlowCell: 'Send Headings to Flow (single cell)',
  pullFromFlow: 'Pull Selection from Flow',
  createFlow: 'Create New Flow',
  startFlowHost: 'Start Flow Connection',
  toggleVoice: 'Toggle voice control',
  calibrateVoice: 'Calibrate voice control…',
  openCardCutter: 'Cut card with AI…',
  addCutterContext: 'Use Selection as Cutter Context',
  openCutterGuidance: 'Edit File Cutting Guidance',
  createFlashcard: 'Create Flashcard From Selection',
  manageFlashcards: 'Manage Flashcards',
  wordCountSelection: 'Word Count Selection',
  openShortcutsReference: 'Open Keyboard Shortcuts',
  startUiTour: 'Take the UI Tour',
  selectSimilar: 'Select Similar Formatting',
  removeHyperlinks: 'Remove Hyperlinks',
  linkUrls: 'Link URLs',
  convertAnalyticsToTags: 'Convert Analytics to Tags',
  convertCitedAnalyticsToTags: 'Convert Cited Analytics to Tags',
  fixFormattingGaps: 'Fix Formatting Gaps',
  insertTable: 'Insert Table',
  addRowAfter: 'Insert Row Below',
  addRowBefore: 'Insert Row Above',
  deleteTableRow: 'Delete Row',
  addColumnAfter: 'Insert Column Right',
  addColumnBefore: 'Insert Column Left',
  deleteTableColumn: 'Delete Column',
  mergeTableCells: 'Merge Cells',
  splitTableCell: 'Split Cell',
  deleteTable: 'Delete Table',
  newDocument: 'New Document',
  openFile: 'Open File',
  save: 'Save',
  saveAs: 'Save As…',
  saveSendDoc: 'Save Send Doc',
  saveReadDoc: 'Save Read Doc',
  saveMarkedCards: 'Save Marked Cards',
  toggleAutosave: 'Toggle Autosave',
  newSpeechDocument: 'New Speech Document',
  markActiveAsSpeech: 'Mark / Unmark Active Doc as the Speech Doc',
  sendToSpeechAtCursor: 'Send to Speech (At Cursor)',
  sendToSpeechAtEnd: 'Send to Speech (At End)',
  sendToDropzone: 'Send to Dropzone',
  insertLiveZone: 'Insert Linked Copy from a File',
  insertSelfLiveZone: 'Insert Live View',
  insertInDocCopy: 'Insert Linked Copy from This Document',
  refreshLiveZone: 'Refresh Linked Copy',
  refreshAllLiveZones: 'Refresh All Linked Copies',
  checkLiveZoneSources: 'Check Linked Copy Sources for Updates',
  detachLiveZone: 'Unlink Copy',
  sendToStarred: 'Send to Starred Recipient',
  sendToRecipient: 'Send to Recipient…',
  insertReceivedAtCursor: 'Insert Received Card (At Cursor)',
  insertReceivedAtEnd: 'Insert Received Card (At End)',
  previewReceived: 'Preview Received Card',
  selectCurrentHeading: 'Select Current Heading',
  deleteCurrentHeading: 'Delete Current Heading',
  nextPocket: 'Go to Next Pocket',
  prevPocket: 'Go to Previous Pocket',
  nextHat: 'Go to Next Hat',
  prevHat: 'Go to Previous Hat',
  nextBlock: 'Go to Next Block',
  prevBlock: 'Go to Previous Block',
  nextTag: 'Go to Next Tag',
  prevTag: 'Go to Previous Tag',
  toggleNumberRole: 'Number: Toggle Number Role',
  toggleSubRole: 'Number: Toggle Substructure Role',
  toggleNumRestart: 'Number: Toggle Start-Over-Here',
  copyCurrentHeading: 'Copy Current Heading',
  copyCardsWithMatchingCite: 'Copy All Cards With Matching Cite',
  addQuickCard: 'Add Quick Card',
  manageQuickCards: 'Manage Quick Cards',
  openQuickCardSearch: 'Search Everything',
  collabStartSession: 'Start Collaboration Session',
  collabJoinSession: 'Join Collaboration Session',
  collabCopyShareCode: 'Copy Session Share Code',
  collabCopyInviteLink: 'Copy Session Invite Link',
  collabInviteStarred: 'Invite Starred Partner to Session',
  collabEndSession: 'End or Leave Collaboration Session',
  insertImage: 'Insert Image at Cursor',
  openDevConsole: 'Open Developer Console',
  zoomIn: 'Zoom In',
  zoomOut: 'Zoom Out',
  zoomReset: 'Reset Zoom to 100%',
  chromeScaleUp: 'Chrome Scale Up',
  chromeScaleDown: 'Chrome Scale Down',
  chromeScaleReset: 'Reset Chrome Scale to 100%',
  togglePaintbrushHighlight: 'Toggle Highlight Paint Mode',
  togglePaintbrushShading: 'Toggle Background-Color Paint Mode',
  openFind: 'Find',
  openFindReplace: 'Find and Replace',
  openFindByProximity: 'Find Without Category Grouping',
  toggleNavPane: 'Show / Hide Navigation Pane',
  setNavDepth1: 'Navigation Pane: Show Level 1 (Pockets)',
  setNavDepth2: 'Navigation Pane: Show Levels 1–2 (Hats)',
  setNavDepth3: 'Navigation Pane: Show Levels 1–3 (Blocks)',
  setNavDepth4: 'Navigation Pane: Show Levels 1–4 (Tags)',
  adjustFontSizeUp: 'Increase Font Size by 1pt',
  adjustFontSizeDown: 'Decrease Font Size by 1pt',
  applyFontColor: 'Apply Font Color',
  openSettings: 'Open Settings',
  minimizeWindow: 'Minimize Window',
  switchWindow: 'Switch Window',
  openJournalsFolder: 'Open Crash-Recovery Journals Folder',
  toggleMorphMode: 'Toggle Morph Mode',
  recoverPreviousVersion: 'Recover Previous Version',
  cycleTheme: 'Cycle Theme (Light → Dark → System)',
  cycleTimerPreset: 'Cycle Timer Preset (College → High School → Pomodoro)',
  flipQuoteDirection: 'Flip Quote Direction',
  toggleParagraphIntegrity: 'Toggle Paragraph Integrity',
  selectSpeechDoc: 'Select Speech Document',
  goHome: 'Go to Home Screen',
  openHighlightPicker: 'Open Highlight Color Picker',
  openShadingPicker: 'Open Background Color Picker',
  openFontColorPicker: 'Open Font Color Picker',
  openFontSizePicker: 'Open Font Size Picker',
  resetDefaultColors: 'Reset to Default Colors',
  openDocToolsMenu: 'Open Doc Tools Menu',
  openCardToolsMenu: 'Open Card Tools Menu',
  openTableMenu: 'Open Table Menu',
  focusSlot1: 'Focus Slot 1',
  focusSlot2: 'Focus Slot 2',
  focusSlot3: 'Focus Slot 3',
  sendDocToSlot1: 'Send Doc to Slot 1',
  sendDocToSlot2: 'Send Doc to Slot 2',
  sendDocToSlot3: 'Send Doc to Slot 3',
  toggleSlotExpand: 'Toggle Slot Expand / Restore',
  hideSlot: 'Hide Slot',
  revealAllSlots: 'Reveal All Slots',
  cycleDocNext: 'Next Document in Slot',
  cycleDocPrev: 'Previous Document in Slot',
  closeDocOrWindow: 'Close Doc or Window',
  insertFootnote: 'Insert Footnote',
  timerToggleVisible: 'Timer: Show / Hide Panel',
  timerStartPause: 'Timer: Start / Pause',
  timerPreset1: 'Timer: Start Speech Preset 1',
  timerPreset2: 'Timer: Start Speech Preset 2',
  timerPreset3: 'Timer: Start Speech Preset 3',
  timerStartAffPrep: 'Timer: Start Aff Prep',
  timerStartNegPrep: 'Timer: Start Neg Prep',
  timerReset: 'Timer: Reset',
};

/**
 * Extra search terms for the command palette, keyed by command id.
 * The display label stays `RIBBON_COMMAND_LABELS`; these are matched
 * (never shown) so a query phrased differently than the label still
 * surfaces the command. Two recurring cases drive most of these:
 *   - show/hide ⇄ toggle: a visibility command labeled one way should
 *     also answer to the other phrasing.
 *   - vague or Word-flavored labels: "Clear" is really "clear
 *     formatting"; "Paste Plain Text" is what Word calls "paste
 *     without formatting".
 * Keep entries lowercase. Only commands that need an alias appear here.
 */
export const RIBBON_COMMAND_ALIASES: Partial<Record<RibbonCommandId, readonly string[]>> = {
  undo: ['ctrl-z', 'cmd-z', 'take back', 'revert'],
  redo: ['ctrl-y', 'cmd-y', 'ctrl-shift-z', 'do again'],
  sendToRecipient: ['send to contact', 'send card to', 'pick recipient', 'send to group'],
  minimizeWindow: ['minimize', 'hide window', 'window menu'],
  switchWindow: ['alt tab', 'go to window', 'jump to window', 'other window', 'window switcher', 'next window'],
  openJournalsFolder: ['crash', 'recovery', 'journal', 'restore', 'lost work', 'autosave folder'],
  toggleMorphMode: ['morph', 'sensel', 'control surface', 'jog wheel', 'overlay'],
  recoverPreviousVersion: ['history', 'version', 'restore', 'rollback', 'vandalism', 'session history'],
  collabStartSession: ['collaborate', 'coedit', 'co-edit', 'share session', 'live edit'],
  collabJoinSession: ['join session', 'share code', 'coedit'],
  collabCopyShareCode: ['share code', 'invite code', 'session code'],
  collabCopyInviteLink: ['invite link', 'share link', 'join link', 'session link'],
  collabInviteStarred: ['invite partner', 'session invite', 'invite to session'],
  openDevConsole: ['devtools', 'dev console', 'debug console', 'inspect', 'developer tools'],
  collabEndSession: ['leave session', 'stop session', 'stop collaborating'],
  repairParagraphIntegrity: [
    'paragraph integrity',
    'split paragraphs',
    'add paragraph breaks',
    'paragraph starts',
  ],
  // show/hide ⇄ toggle visibility pairs
  toggleCommentsVisible: ['toggle comments', 'comments'],
  toggleNavPane: ['toggle navigation pane', 'toggle nav pane', 'sidebar', 'outline pane'],
  setNavDepth1: ['nav depth', 'navigation depth', 'outline level', 'level 1', 'pockets'],
  setNavDepth2: ['nav depth', 'navigation depth', 'outline level', 'level 2', 'hats'],
  setNavDepth3: ['nav depth', 'navigation depth', 'outline level', 'level 3', 'blocks'],
  setNavDepth4: ['nav depth', 'navigation depth', 'outline level', 'level 4', 'tags'],
  convertCardsToReadMode: ['zap card', 'zap cards'],
  toggleReadMode: ['show read mode', 'hide read mode', 'invisibility mode'],
  toggleReaderView: ['reading view', 'reader view', 'paginated view', 'read view', 'book view', 'columns'],
  openContainingFolder: ['reveal in finder', 'show in folder', 'show in explorer', 'reveal file', 'file location', 'containing folder'],
  saveWorkspace: ['save session', 'save open documents', 'remember open documents', 'save tabs'],
  reopenWorkspace: ['restore session', 'reopen session', 'open previous session', 'reopen last session', 'restore workspace', 'reopen documents', 'reopen tabs'],
  arrangeWindows: ['window arranger', 'arrange for speech', 'tile windows', 'speech doc side by side', 'split screen', 'organize windows'],
  toggleAutosave: ['enable autosave', 'disable autosave', 'turn on autosave', 'turn off autosave'],
  markActiveAsSpeech: ['toggle speech doc', 'set speech document'],
  // vague / Word-flavored labels
  clearToNormal: ['clear formatting', 'remove formatting', 'clear to normal'],
  lockHighlighting: ['lock highlights', 'grey highlights', 'gray highlights', 'rehighlight'],
  standardizeHighlightExcept: ['standardize except', 'standardize highlighting except', 'exception highlight'],
  standardizeShadingExcept: ['standardize background except', 'standardize shading except', 'exception shading'],
  regrow: ['unshrink', 'regrow', 'restore text size', 'unshrink card text'],
  smartShrink: ['smart shrink', 'deep shrink'],
  condenseAndShrink: ['fast condense', 'condense and shrink', 'condense shrink'],
  aiAskAboutSelection: ['question'],
  reformatAllCites: ['reformat all cites', 'reformat cites', 'all cites', 'every cite', 'bulk cite'],
  pasteAsText: ['paste without formatting', 'paste unformatted', 'paste text'],
  pasteCondensed: ['paste condense', 'paste merge', 'paste flatten', 'paste no paragraphs', 'destructive paste'],
  removeHyperlinks: ['remove links', 'unlink'], // "delete …" via the delete/remove synonym group
  linkUrls: ['hyperlink urls', 'autolink', 'make links', 'add links', 'linkify'],
  resetDefaultColors: ['default colors', 'reset colors', 'reset swatches', 'reset highlight color', 'reset background color'],
  applyShading: ['shading', 'text highlight color'],
  applyEmphasisAndShading: ['emphasize and background', 'emphasis and shading', 'emphasis background', 'emphasize shade'],
  insertImage: ['add image', 'insert picture', 'photo'],
  // "Insert …" element commands also answer to "add …" (genuine equivalence —
  // unlike Add Quick Card / Add Comment / Add Note, which CREATE, not insert).
  insertTable: ['add table'],
  addRowBefore: ['add row above'],
  addRowAfter: ['add row below'],
  addColumnBefore: ['add column left'],
  addColumnAfter: ['add column right'],
  insertReceivedAtCursor: ['add received card at cursor'],
  insertReceivedAtEnd: ['add received card at end'],
  previewReceived: ['preview last received', 'preview most recent received', 'look at received card', 'show received card'],
  moveContainerUp: ['move up', 'move card up', 'move section up', 'reorder up', 'shift up'],
  moveContainerDown: ['move down', 'move card down', 'move section down', 'reorder down', 'shift down'],
  goHome: ['start screen', 'welcome screen', 'dashboard'],
  openShortcutsReference: ['hotkeys', 'key bindings', 'shortcuts'],
  startUiTour: ['tour', 'onboarding', 'walkthrough', 'coach marks', 'tutorial'],
  zoomReset: ['actual size'],
  cycleTheme: ['dark mode', 'light mode', 'toggle theme', 'switch theme', 'appearance'],
  cycleTimerPreset: ['switch timer preset', 'toggle timer preset', 'next timer preset', 'change timer preset', 'timer profile', 'timer preset'],
  insertFootnote: ['footnote', 'endnote', 'add footnote', 'new footnote', 'note'],
  insertLiveZone: [
    'linked copy from a file',
    'transclude',
    'transclusion',
    'embed from file',
    'live zone',
    'pull card',
    'link section',
  ],
  insertSelfLiveZone: [
    // create ⇄ insert: genuine equivalence for live views (nothing exists
    // until the command runs either way) — both phrasings must find it.
    'create live view',
    'new live view',
    'live view',
    'live window',
    'embed section',
    'mirror section',
    'view a section',
    'transclude section',
    'ted nelson',
  ],
  insertInDocCopy: [
    'linked copy from this document',
    'copy a section',
    'embed copy',
    'linked copy this doc',
    'transclude copy',
    'duplicate section linked',
  ],
  refreshLiveZone: ['refresh transclusion', 'update copy', 'sync copy', 'pull source'],
  refreshAllLiveZones: [
    'refresh all transclusions',
    'update all copies',
    'refresh whole document',
    'refresh every copy',
  ],
  checkLiveZoneSources: [
    'check linked copies',
    'check for source updates',
    'check copy sources',
    'have copy sources changed',
    'linked copy updates',
  ],
  detachLiveZone: ['detach transclusion', 'unlink live zone', 'break live zone link'],
  timerToggleVisible: ['show timer', 'hide timer', 'toggle timer', 'timer panel'],
  timerStartPause: ['start timer', 'pause timer', 'speech timer', 'play timer'],
  timerPreset1: ['timer 9', 'first speech preset'],
  timerPreset2: ['timer 6', 'second speech preset'],
  timerPreset3: ['timer 3', 'third speech preset'],
  timerStartAffPrep: ['aff prep', 'affirmative prep', 'prep timer'],
  timerStartNegPrep: ['neg prep', 'negative prep', 'prep timer'],
  timerReset: ['reset timer', 'reset prep'],
  flipQuoteDirection: ['flip quotes', 'curly quotes', 'reverse quote direction', 'smart quote direction', 'fix apostrophe', 'quote direction'],
  deleteCurrentHeading: ['delete card', 'delete heading', 'delete current card'], // "remove …" via the delete/remove synonym group
  nextPocket: ['jump to next pocket', 'next heading', 'navigate'],
  prevPocket: ['jump to previous pocket', 'previous heading', 'navigate'],
  nextHat: ['jump to next hat', 'next heading', 'navigate'],
  prevHat: ['jump to previous hat', 'previous heading', 'navigate'],
  nextBlock: ['jump to next block', 'next heading', 'navigate'],
  prevBlock: ['jump to previous block', 'previous heading', 'navigate'],
  nextTag: ['jump to next tag', 'next heading', 'navigate'],
  prevTag: ['jump to previous tag', 'previous heading', 'navigate'],
  copyCardsWithMatchingCite: ['copy matching cite', 'copy same cite', 'copy cards by cite', 'copy all cards with this cite', 'cite cards'],
  toggleNumberRole: ['number', 'numbering', 'numbered card', 'auto number', 'list number'],
  toggleSubRole: ['substructure', 'sub number', 'sub letter', 'numbering', 'sublist', 'letter'],
  toggleNumRestart: ['restart numbering', 'start over', 'renumber', 'continue numbering', 'number restart'],
  saveSendDoc: ['send doc', 'export send doc', 'send version'],
  saveReadDoc: ['read doc', 'export read doc', 'read version', 'save read'],
  saveMarkedCards: ['marked cards', 'extract marked cards', 'export marked cards', 'save marked'],
  startFlowHost: ['warm flow', 'prewarm flow', 'flow connection', 'connect to flow', 'speed up flow'],
  toggleVoice: ['voice control', 'voice mode', 'dictation', 'speech', 'microphone', 'start voice', 'stop voice'],
  calibrateVoice: ['voice calibration', 'train voice', 'calibrate microphone', 'my voice'],
  // The cutter shortcut serves double duty for its highlighting verbs, so
  // those names resolve to it too.
  openCardCutter: [
    'cut card', 'card cutter', 'trim card', 'ai cut', 'auto highlight',
    'highlight', 'add highlight', 'dehighlight', 'remove highlight', 'unhighlight',
    'refine highlighting', 'refine highlight', 'rehighlight', 'fix highlighting',
  ],
  addCutterContext: ['cutter context', 'context section', 'designate context', 'cutting context'],
  openCutterGuidance: ['file guidance', 'cutting guidance', 'cutter guidance', 'how this file works'],
  // Spelled-out slot numbers, so "one" / "two" / "three" surface the
  // slot focus (switch) + send-to-slot commands in the command bar.
  focusSlot1: ['one'],
  focusSlot2: ['two'],
  focusSlot3: ['three'],
  sendDocToSlot1: ['one'],
  sendDocToSlot2: ['two'],
  sendDocToSlot3: ['three'],
};

/**
 * Default key bindings. The value is a single key or an array of
 * keys; all bindings invoke the same command. The first entry is the
 * "primary" binding used for ribbon-button tooltips; the rest are
 * aliases (visible in the keybindings editor). Verbatim's hotkeys
 * win where they exist; Word's Mod-B / Mod-I / Mod-U cover the
 * inline marks.
 */
export const DEFAULT_RIBBON_KEYS: Record<RibbonCommandId, string | string[]> = {
  undo: 'Mod-z',
  redo: ['Mod-y', 'Mod-Shift-z'],
  setPocket: 'F4',
  setHat: 'F5',
  setBlock: 'F6',
  setTag: 'F7',
  setAnalytic: 'Mod-F7',
  setUndertag: 'Mod-F8',
  moveContainerUp: 'Mod-Alt-ArrowUp',
  moveContainerDown: 'Mod-Alt-ArrowDown',
  toggleBold: 'Mod-b',
  toggleItalic: 'Mod-i',
  toggleStrikethrough: '',
  toggleSuperscript: 'Mod-Shift-=',
  toggleSubscript: 'Mod-=',
  applyCite: 'F8',
  applyUnderline: ['F9'],
  toggleUnderlineTyping: 'Mod-u',
  toggleReadingMarker: 'Mod-Shift-d',
  applyEmphasis: 'F10',
  applyEmphasisAndShading: '',
  emphasizeAcronym: 'Alt-F10',
  applyHighlight: 'F11',
  highlightAcronym: 'Alt-F11',
  underlineAcronym: '',
  applyShading: 'Mod-F11',
  condenseDefault: 'F3',
  condenseNoIntegrity: 'Alt-F3',
  condenseNoIntegrityWithPilcrows: 'Mod-Alt-F3',
  condenseWithWarning: '',
  condenseAndShrink: '',
  uncondense: 'Mod-Alt-Shift-F3',
  toggleCase: 'Shift-F3',
  copyPreviousCite: 'Alt-F8',
  pasteAsText: 'F2',
  pasteCondensed: '',
  clearToNormal: 'F12',
  shrink: 'Mod-8',
  smartShrink: 'Mod-Alt-8',
  regrow: 'Mod-Shift-8',
  // Menu / button commands — exposed for user-defined bindings via
  // the keybinding editor; no default key.
  createReference: '',
  lockHighlighting: '',
  extractUndertag: '',
  highlightToShading: '',
  shadingToHighlight: '',
  standardizeHighlight: '',
  standardizeShading: '',
  standardizeHighlightExcept: '',
  standardizeShadingExcept: '',
  convertCardsToReadMode: '',
  toggleReadMode: '',
  toggleReaderView: '',
  openContainingFolder: '',
  saveWorkspace: '',
  reopenWorkspace: '',
  arrangeWindows: '',
  toggleCommentsVisible: '',
  addCommentToSelection: '',
  addNoteToSelection: 'Mod-Shift-n',
  aiAskAboutSelection: 'Mod-Shift-q',
  aiCreateCite: 'Mod-Shift-x',
  // Deliberately unbound: one model request per cite in the document is
  // far too expensive to sit behind a stray chord. Bind it in Settings →
  // Keyboard shortcuts if you want one.
  reformatAllCites: '',
  translate: 'Mod-Shift-t',
  repairText: 'Mod-Shift-r',
  repairFormatting: 'Mod-Alt-r',
  // No default binding — rebindable in Settings → Keyboard shortcuts.
  repairParagraphIntegrity: '',
  sendToFlowColumn: '',
  sendToFlowCell: '',
  sendHeadingsToFlowColumn: '',
  sendHeadingsToFlowCell: '',
  pullFromFlow: '',
  createFlow: '',
  startFlowHost: '',
  toggleVoice: 'Alt-Shift-V',
  calibrateVoice: '',
  openCardCutter: 'Mod-Alt-c',
  addCutterContext: '',
  openCutterGuidance: '',
  createFlashcard: '',
  manageFlashcards: '',
  wordCountSelection: '',
  openShortcutsReference: '',
  startUiTour: '',
  selectSimilar: '',
  removeHyperlinks: '',
  linkUrls: '',
  convertAnalyticsToTags: '',
  convertCitedAnalyticsToTags: '',
  fixFormattingGaps: '',
  // Table commands — no default keys; bind via the keybinding editor.
  insertTable: '',
  addRowAfter: '',
  addRowBefore: '',
  deleteTableRow: '',
  addColumnAfter: '',
  addColumnBefore: '',
  deleteTableColumn: '',
  mergeTableCells: '',
  splitTableCell: '',
  deleteTable: '',
  // Chrome won't let JS suppress its `Ctrl-N` (new window) or
  // `Ctrl-Shift-N` (new incognito window) defaults — both keys
  // are un-preventable in the browser, so the web edition has to
  // use `Mod-Alt-N`. Electron has no such restriction, so its
  // default is the conventional `Mod-N`. Both can be rebound in
  // Settings → Keyboard shortcuts.
  newDocument: getHost().kind === 'electron' ? 'Mod-n' : 'Mod-Alt-n',
  openFile: 'Mod-o',
  save: 'Mod-s',
  saveAs: 'Mod-Shift-s',
  saveSendDoc: 'Mod-Alt-s',
  saveReadDoc: '',
  saveMarkedCards: 'Mod-Alt-m',
  toggleAutosave: '',
  insertLiveZone: '',
  insertSelfLiveZone: '',
  insertInDocCopy: '',
  refreshLiveZone: '',
  refreshAllLiveZones: '',
  checkLiveZoneSources: '',
  detachLiveZone: '',
  // Verbatim's "Send to speech" — bare backtick (next to 1 on US
  // layouts) for at-cursor, Alt-backtick for at-end-of-doc. Same
  // chord as the desktop app. Trade-off: a bare backtick keystroke
  // is consumed by the command; users who actually need to type a
  // literal "`" in evidence can rebind these via Settings →
  // Keybindings.
  sendToSpeechAtCursor: '`',
  sendToSpeechAtEnd: 'Alt-`',
  sendToDropzone: 'Mod-`',
  sendToStarred: '',
  sendToRecipient: '',
  insertReceivedAtCursor: 'Mod-p',
  insertReceivedAtEnd: 'Mod-Alt-p',
  previewReceived: '',
  selectCurrentHeading: 'Alt-a',
  deleteCurrentHeading: '',
  // No defaults: PageUp / PageDown already jump by any heading.
  nextPocket: '',
  prevPocket: '',
  nextHat: '',
  prevHat: '',
  nextBlock: '',
  prevBlock: '',
  nextTag: '',
  prevTag: '',
  toggleNumberRole: 'Mod-Alt-1',
  toggleSubRole: 'Mod-Alt-2',
  toggleNumRestart: 'Mod-Alt-3',
  copyCurrentHeading: '',
  copyCardsWithMatchingCite: '',
  addQuickCard: '',
  manageQuickCards: '',
  openQuickCardSearch: 'Mod-Shift-Space',
  collabStartSession: '',
  collabJoinSession: '',
  collabCopyShareCode: '',
  collabCopyInviteLink: '',
  collabInviteStarred: '',
  collabEndSession: '',
  newSpeechDocument: '',
  markActiveAsSpeech: '',
  insertImage: '',
  // Zoom. Mod-=/Mod-- mirror Word's editor-zoom convention (the `=`
  // key is the unshifted version of `+`). Mod-= overlaps with
  // toggleSubscript's default; the editor's keymap resolves the
  // overlap in the user's favor via Settings → Keyboard shortcuts, where
  // either command can be rebound. zoomReset stays unbound by
  // default — Mod-0 is a browser-level "reset zoom" chord that
  // Chromium won't always let the page intercept.
  openDevConsole: '',
  zoomIn: 'Mod-=',
  zoomOut: 'Mod--',
  zoomReset: '',
  // Chrome scale — Mod-Alt versions of the editor-zoom chord.
  // Same physical keys with Alt added: reads as "zoom the whole
  // page, not just the doc". Wired to Chromium's per-frame
  // setZoomFactor on Electron (identical mechanism to the
  // browser's built-in Ctrl-+); no-op on the web edition (use
  // the browser's own page-zoom there).
  chromeScaleUp: 'Mod-Alt-=',
  chromeScaleDown: 'Mod-Alt--',
  chromeScaleReset: 'Mod-Alt-0',
  // Paintbrush toggles — no obvious convention here, so register
  // them in the keybinding registry without a default. Users who
  // want a hotkey for sticky highlight / shading can bind one in
  // Settings → Keyboard shortcuts.
  togglePaintbrushHighlight: '',
  togglePaintbrushShading: '',
  // Browser-level Ctrl-F opens the page's find. Electron will let us
  // intercept (we drive our own bar); the web edition may see the
  // browser's UI also pop up. Documented + user-rebindable.
  openFind: 'Mod-f',
  openFindReplace: 'Mod-h',
  openFindByProximity: 'Alt-f',
  // No default — pickable in Settings → Keyboard shortcuts. Hiding the
  // nav pane is a personal-workflow toggle that's already on the
  // ribbon + nav-pane × + pull-tab; the keybinding is a power-
  // user convenience layer, not a discoverable default.
  toggleNavPane: '',
  // No defaults — the pane's own 1–4 buttons are the primary UI.
  setNavDepth1: '',
  setNavDepth2: '',
  setNavDepth3: '',
  setNavDepth4: '',
  // Ribbon actions with no default key — all already reachable via
  // the ribbon, so a default chord would be noise. Bindable in
  // Settings → Keyboard shortcuts.
  adjustFontSizeUp: '',
  adjustFontSizeDown: '',
  applyFontColor: '',
  openSettings: '',
  // Stock macOS chord; also works on Win/Linux. Rebindable like all.
  minimizeWindow: 'Mod-m',
  // Ctrl+Tab (Cmd+Tab is the OS app switcher on macOS, but Ctrl+Tab still
  // folds to Mod-Tab there). The three-pane workspace's own Ctrl+Tab doc
  // switcher is what the command does in that mode, so they don't clash.
  switchWindow: 'Mod-Tab',
  openJournalsFolder: '',
  toggleMorphMode: '',
  recoverPreviousVersion: '',
  cycleTheme: '',
  cycleTimerPreset: '',
  flipQuoteDirection: '',
  toggleParagraphIntegrity: '',
  selectSpeechDoc: '',
  goHome: '',
  openHighlightPicker: '',
  openShadingPicker: '',
  openFontColorPicker: '',
  openFontSizePicker: '',
  resetDefaultColors: '',
  openDocToolsMenu: '',
  openCardToolsMenu: '',
  openTableMenu: '',
  focusSlot1: 'Mod-1',
  focusSlot2: 'Mod-2',
  focusSlot3: 'Mod-3',
  sendDocToSlot1: 'Mod-Shift-1',
  sendDocToSlot2: 'Mod-Shift-2',
  sendDocToSlot3: 'Mod-Shift-3',
  toggleSlotExpand: 'Mod-Shift-f',
  // Unbound by default — rebindable via Settings → Keyboard shortcuts.
  hideSlot: '',
  revealAllSlots: '',
  // Unbound by default — rebindable via Settings → Keyboard shortcuts.
  cycleDocNext: '',
  cycleDocPrev: '',
  closeDocOrWindow: 'Mod-w',
  insertFootnote: '',
  timerToggleVisible: '',
  timerStartPause: '',
  timerPreset1: '',
  timerPreset2: '',
  timerPreset3: '',
  timerStartAffPrep: '',
  timerStartNegPrep: '',
  timerReset: '',
};

/** Normalize a default-key value (string | string[]) to an array. */
export function keysArray(spec: string | string[]): string[] {
  return Array.isArray(spec) ? spec : [spec];
}

/** A static ribbon id, or a runtime plugin command id. */
export type AnyCommandId = RibbonCommandId | (string & {});

/** Label for any command id - static table first, plugin registry
 *  second, the raw id as a last resort. */
export function commandLabelFor(id: AnyCommandId): string {
  return (
    (RIBBON_COMMAND_LABELS as Record<string, string>)[id] ??
    pluginCommandLabel(id) ??
    id
  );
}

/** Palette search aliases for any command id - static table first,
 *  plugin keywords second (empty when neither has any). */
export function commandAliasesFor(id: AnyCommandId): readonly string[] {
  return (
    (RIBBON_COMMAND_ALIASES as Record<string, readonly string[] | undefined>)[id] ??
    pluginCommandKeywords(id)
  );
}

/**
 * Build a ProseMirror-keymap-style key string from a KeyboardEvent —
 * `"F3"`, `"Alt-F3"`, `"Mod-Alt-F3"`, etc. Modifier order matches
 * the convention used in `DEFAULT_RIBBON_KEYS`.
 */
export function ribbonKeyStringFor(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  // Normalize digits via `e.code` so `Mod-Shift-1` matches even
  // though Shift+1 produces `e.key === '!'` on US layouts (and
  // layout-specific shifted chars elsewhere). PM-style keymap
  // matching already accounts for shifted symbol keys like `=`/`+`.
  if (/^Digit[0-9]$/.test(e.code)) {
    parts.push(e.code.slice(5));
  } else if (e.code === 'Space' || e.key === ' ') {
    // The space key's `e.key` is a literal " ", which would join into
    // "Mod-Shift- " and never match the canonical "Mod-Shift-Space"
    // binding. Normalize to PM's "Space" name so the global key
    // handler matches space bindings even when the editor is unfocused.
    parts.push('Space');
  } else if (e.altKey && /^Key[A-Z]$/.test(e.code)) {
    // With Option held, macOS reports the layout's dead/special
    // character as e.key ("◊" for Option-Shift-V, "å" for Option-A),
    // so an Alt chord on a letter would never match its binding
    // outside the editor. Name the letter from e.code instead — the
    // same keyCode fallback prosemirror-keymap uses inside it.
    parts.push(e.code.slice(3).toLowerCase());
  } else if (e.key.length === 1) {
    // Single characters are matched case-insensitively, like
    // prosemirror-keymap does inside the editor: bindings are
    // registered lowercase ('Mod-Shift-s'), but a real Shift (or
    // CapsLock) keydown produces e.key === 'S' — without folding,
    // every shifted/caps-locked letter chord missed whenever focus
    // was outside the editor. Identity for digits and symbols.
    parts.push(e.key.toLowerCase());
  } else {
    parts.push(e.key);
  }
  return parts.join('-');
}

/** Case-fold a key string's final segment when it's a single
 *  character — 'Mod-Shift-S' ≡ 'Mod-Shift-s'. Saved user overrides
 *  captured before ribbonKeyStringFor folded letters are stored
 *  uppercase, so lookups must fold both sides. */
export function foldKeyString(key: string): string {
  const i = key.lastIndexOf('-');
  const tail = i < 0 ? key : key.slice(i + 1);
  if (tail.length !== 1) return key;
  return i < 0 ? key.toLowerCase() : key.slice(0, i) + '-' + tail.toLowerCase();
}

/** Folded forms of every key the static (non-plugin) commands resolve
 *  to under `overrides`. The single source of truth for plugin-vs-static
 *  collisions, shared by `buildRibbonKeymap` and
 *  `effectivePluginDefaultKeys` so the two can't drift. */
export function foldedStaticKeys(
  overrides: Partial<Record<string, string | string[]>>,
): Set<string> {
  const set = new Set<string>();
  for (const id of RIBBON_COMMAND_IDS) {
    const spec = overrides[id] ?? DEFAULT_RIBBON_KEYS[id];
    for (const key of keysArray(spec)) {
      if (key) set.add(foldKeyString(key));
    }
  }
  return set;
}

/**
 * The default keys a plugin command actually binds to, after static
 * collisions are resolved — so display sites show what really
 * dispatches. An explicit override wins outright (returned verbatim,
 * empty entries dropped); otherwise each built-in default key is
 * suppressed when its folded form already belongs to a static command.
 */
export function effectivePluginDefaultKeys(
  id: AnyCommandId,
  overrides: Partial<Record<string, string | string[]>> = {},
): string[] {
  if (overrides[id] != null) return keysArray(overrides[id]!).filter((k) => !!k);
  const staticFolded = foldedStaticKeys(overrides);
  return keysArray(pluginDefaultKey(id) ?? []).filter(
    (k) => !!k && !staticFolded.has(foldKeyString(k)),
  );
}

/**
 * Format a ProseMirror-keymap key string for display in a tooltip.
 * Substitutes the platform's modifier for "Mod-" and pretty-prints
 * the separator.
 */
export function formatKeyForDisplay(key: string): string {
  if (!key) return '';
  const isMac =
    typeof navigator !== 'undefined' &&
    /mac/i.test(navigator.platform ?? '');
  // A Mod chord on Tab is Control on macOS, not Command: ⌘Tab is the OS
  // app switcher and never reaches the app, while Ctrl folds into Mod in
  // `ribbonKeyStringFor` — so Switch Window's Mod-Tab really is ⌃Tab there.
  const modGlyph = isMac ? (/(^|-)Tab$/.test(key) ? '⌃' : '⌘') : 'Ctrl+';
  return key
    .replace(/Mod-/g, modGlyph)
    .replace(/Shift-/g, isMac ? '⇧' : 'Shift+')
    .replace(/Alt-/g, isMac ? '⌥' : 'Alt+')
    .replace(/-/g, '+');
}
