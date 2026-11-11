/**
 * The computer-use wire in Swift: src/shared/computer/protocol.ts → the
 * Codable types tc-computer decodes (docs/computer-protocol.md §12).
 *
 *   bun run gen:swift-computer    writes native/tc-computer/Sources/ComputerProtocol/Generated/
 *   bun run check:swift-computer  regenerates into a temp dir and diffs; exit 1 on any difference
 *
 * The emitter is gen-swift-contract.ts's, with COMPUTER_METHODS as the method
 * source; Contract.swift carries the protocol number and every default the
 * service applies when the host leaves a field out, so the numbers have one
 * home on both sides.
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTION_LIMITS,
  ActionResultSchema,
  ActionClassSchema,
  AppBriefSchema,
  AppInfoSchema,
  AppRefSchema,
  AX_WALK,
  BatchResultSchema,
  BudgetSchema,
  ClipboardOutcomeSchema,
  ClipboardActivitySchema,
  COMPUTER_METHODS,
  COMPUTER_PROTOCOL,
  COMPUTER_WAIT,
  SCROLL_POINTS_PER_CLICK,
  ComputerActionNameSchema,
  ComputerActionSchema,
  ComputerErrorKindSchema,
  ComputerErrorSchema,
  ComputerNotificationSchema,
  CoordinateSpaceSchema,
  DisplayInfoSchema,
  ElementBriefSchema,
  EmptySchema,
  FrontReportSchema,
  FrontRestoreSchema,
  PageSchema,
  PageStateSchema,
  TabInfoSchema,
  TabsModeSchema,
  ESCAPE_WATCH,
  HostNotificationSchema,
  IgnoredRoutesSchema,
  InputViaSchema,
  InterruptedBySchema,
  KeyWindowStateSchema,
  LaunchedWindowSchema,
  LOCKS,
  ObservationKindSchema,
  ObservationModeSchema,
  ObservationSchema,
  ObservationStatsSchema,
  ObserveModeSchema,
  ObserveOptionsSchema,
  OBSERVATION_BUDGET,
  OBSERVATION_TEXT,
  PermissionNameSchema,
  PasteFormatSchema,
  PermissionsSchema,
  PlacementSchema,
  PointSchema,
  PREVIEW_STREAM,
  PriorSchema,
  ProbeOutcomeSchema,
  ProbeReportSchema,
  RawAXNodeSchema,
  RawAXTreeSchema,
  RawAXValueSchema,
  RawAXValueTypeSchema,
  RectSchema,
  RegionSchema,
  RestoreOutcomeSchema,
  RPC_ERROR,
  ScreenshotPolicySchema,
  ScrollDirectionSchema,
  SERVICE,
  SessionChangeSchema,
  SessionRefSchema,
  SessionRestoreSchema,
  SHOT,
  ShotFormatSchema,
  ShotSchema,
  ErrorReasonSchema,
  StepEffectSchema,
  StepResultSchema,
  TargetSchema,
  TierSchema,
  TYPING,
  WaitOptionsSchema,
  WaitReasonSchema,
  WaitReportSchema,
  WindowInfoSchema,
  WindowRefSchema,
  WindowSpaceSchema,
  waitActionWait,
  type ComputerMethod,
  type WaitOptions
} from '../src/shared/computer/protocol'
import {
  ACTION_WORDS,
  AMBIENT_ACTIONS,
  DROPPED_ACTIONS,
  HEADER_SEPARATOR,
  HEADER_WORDS,
  KEY_NAMES,
  MODIFIER_NAMES,
  MODIFIERS,
  OTHER_WINDOWS_PREFIX,
  ROLE_DEFAULTS,
  ROLE_TAGS,
  STATE_WORDS,
  STRUCTURAL_ROLES,
  STUB_SUFFIX,
  SUBROLE_NAMES,
  TITLE_BAR_CORNER,
  TITLE_BAR_SUBROLES,
  TOGGLE_ROLES,
  TYPING_ROLES
} from '../src/shared/computer/observation'
import { generate, method, type, union, writeOrCheck, type MethodSource, type SubsetEntry } from './gen-swift-contract'

/** Every named type once, in the order Types.swift and Enums.swift list them; then the methods. */
export const COMPUTER_SUBSET: SubsetEntry[] = [
  type('Tier', TierSchema),
  type('ActionClass', ActionClassSchema),
  type('PermissionName', PermissionNameSchema),
  type('WindowSpace', WindowSpaceSchema),
  type('WaitReason', WaitReasonSchema),
  type('ShotFormat', ShotFormatSchema),
  type('ComputerActionName', ComputerActionNameSchema),
  type('ScrollDirection', ScrollDirectionSchema),
  type('Placement', PlacementSchema),
  type('PasteFormat', PasteFormatSchema),
  type('ObservationMode', ObservationModeSchema),
  type('ObserveMode', ObserveModeSchema),
  type('ScreenshotPolicy', ScreenshotPolicySchema),
  type('ObservationKind', ObservationKindSchema),
  type('InputVia', InputViaSchema),
  type('ClipboardOutcome', ClipboardOutcomeSchema),
  type('StepEffect', StepEffectSchema),
  type('ComputerErrorKind', ComputerErrorKindSchema),
  type('InterruptedBy', InterruptedBySchema),
  type('ErrorReason', ErrorReasonSchema),
  type('ProbeOutcome', ProbeOutcomeSchema),
  type('KeyWindowState', KeyWindowStateSchema),
  type('RestoreOutcome', RestoreOutcomeSchema),
  type('FrontRestore', FrontRestoreSchema),
  type('PageState', PageStateSchema),
  type('TabsMode', TabsModeSchema),
  type('Empty', EmptySchema),
  type('Rect', RectSchema),
  type('Point', PointSchema),
  type('Region', RegionSchema),
  type('Permissions', PermissionsSchema),
  type('AppRef', AppRefSchema),
  type('WindowRef', WindowRefSchema),
  type('Target', TargetSchema),
  type('CoordinateSpace', CoordinateSpaceSchema),
  type('TabInfo', TabInfoSchema),
  type('Page', PageSchema),
  type('WindowInfo', WindowInfoSchema),
  type('AppInfo', AppInfoSchema),
  type('DisplayInfo', DisplayInfoSchema),
  type('WaitOptions', WaitOptionsSchema),
  type('WaitReport', WaitReportSchema),
  type('Shot', ShotSchema),
  type('ElementBrief', ElementBriefSchema),
  type('AppBrief', AppBriefSchema),
  type('SessionChange', SessionChangeSchema),
  type('ComputerAction', ComputerActionSchema),
  type('IgnoredRoutes', IgnoredRoutesSchema),
  type('Prior', PriorSchema),
  type('Budget', BudgetSchema),
  type('ObserveOptions', ObserveOptionsSchema),
  type('ObservationStats', ObservationStatsSchema),
  type('Observation', ObservationSchema),
  type('ComputerError', ComputerErrorSchema),
  type('FrontReport', FrontReportSchema),
  type('LaunchedWindow', LaunchedWindowSchema),
  type('ActionResult', ActionResultSchema),
  type('BatchResult', BatchResultSchema),
  type('SessionRef', SessionRefSchema),
  type('ProbeReport', ProbeReportSchema),
  type('SessionRestore', SessionRestoreSchema),
  type('ClipboardActivity', ClipboardActivitySchema),
  type('RawAXValueType', RawAXValueTypeSchema),
  type('RawAXValue', RawAXValueSchema),
  type('RawAXNode', RawAXNodeSchema),
  type('RawAXTree', RawAXTreeSchema),
  union('StepResult', StepResultSchema, 'status', 'Step'),
  union('ComputerNotification', ComputerNotificationSchema, 'method', 'Notification'),
  union('HostNotification', HostNotificationSchema, 'method', 'HostNotification'),
  ...(Object.keys(COMPUTER_METHODS) as ComputerMethod[]).map((m) => method(m, COMPUTER_METHODS[m].result))
]

export const COMPUTER_METHOD_SOURCE: MethodSource = {
  params(m) {
    const entry = COMPUTER_METHODS[m as ComputerMethod]
    if (!entry) throw new Error(`${m} is not in COMPUTER_METHODS`)
    return entry.params
  }
}

const HEADER = [
  '// Generated by scripts/gen-swift-computer.ts from src/shared/computer/protocol.ts — do not edit.',
  '// Regenerate with `bun run gen:swift-computer`; `bun run check:swift-computer` fails the gate when this is stale.',
  ''
]

const literal = (v: number | string): string => (typeof v === 'string' ? JSON.stringify(v) : String(v))

const camel = (s: string): string => s[0].toLowerCase() + s.slice(1)

/** One group of constants as a namespace of `static let`s. */
function namespace(name: string, values: Readonly<Record<string, number | string>>): string[] {
  return [
    `    public enum ${name} {`,
    ...Object.entries(values).map(([k, v]) => `        public static let ${camel(k)} = ${literal(v)}`),
    '    }'
  ]
}

const wait = (w: WaitOptions): string =>
  `WaitOptions(minMs: ${w.minMs}, quietMs: ${w.quietMs}, maxMs: ${w.maxMs}, busyMaxMs: ${w.busyMaxMs})`

export const COMPUTER_CONTRACT: string[] = [
  '/// The protocol number `initialize` checks (src/shared/computer/protocol.ts COMPUTER_PROTOCOL).',
  `public let computerProtocol: Int = ${COMPUTER_PROTOCOL}`,
  '',
  '/// Every number the service applies when the host leaves a field out, and its own limits.',
  'public enum ComputerDefaults {',
  ...namespace('Service', SERVICE),
  ...namespace('AXWalk', AX_WALK),
  ...namespace('ObservationText', OBSERVATION_TEXT),
  ...namespace('ObservationBudget', OBSERVATION_BUDGET),
  ...namespace('Shot', SHOT),
  ...namespace('PreviewStream', PREVIEW_STREAM),
  ...namespace('EscapeWatch', ESCAPE_WATCH),
  ...namespace('Typing', TYPING),
  ...namespace('Locks', LOCKS),
  ...namespace('ActionLimits', ACTION_LIMITS),
  ...namespace('RPCErrorCode', RPC_ERROR),
  '    /// The waits of src/shared/computer/protocol.ts COMPUTER_WAIT; the host sends them with every call.',
  '    public enum Wait {',
  ...Object.entries(COMPUTER_WAIT).map(([k, w]) => `        public static let ${k} = ${wait(w)}`),
  '        /// The `wait` action: the smart wait capped at `duration` seconds.',
  '        public static func waitAction(seconds: Double) -> WaitOptions {',
  '            let cap = Int((seconds * 1000).rounded())',
  `            return WaitOptions(minMs: 0, quietMs: ${waitActionWait(1).quietMs}, maxMs: cap, busyMaxMs: cap)`,
  '        }',
  '    }',
  '}'
]

export function generateComputer(): Record<string, string> {
  return generate(COMPUTER_SUBSET, { methods: COMPUTER_METHOD_SOURCE, header: HEADER, contract: COMPUTER_CONTRACT })
}

/** A Swift string literal: JSON's escapes, but `\u{…}` for the ones Swift spells otherwise. */
const swiftString = (s: string): string =>
  JSON.stringify(s).replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => `\\u{${hex.replace(/^0+(?=.)/, '')}}`)

const sortedKeys = <T>(record: Readonly<Record<string, T>>): string[] => Object.keys(record).sort()

function dictionary(name: string, doc: string, record: Readonly<Record<string, string>>): string[] {
  return [
    `    /// ${doc}`,
    `    public static let ${name}: [String: String] = [`,
    ...sortedKeys(record).map((k) => `        ${swiftString(k)}: ${swiftString(record[k])},`),
    '    ]'
  ]
}

const swiftList = (values: Iterable<string>): string => `[${[...values].map(swiftString).join(', ')}]`

/** A dictionary literal, one entry a line, in the table's own order. */
function swiftMap(name: string, doc: string, values: Readonly<Record<string, string | readonly string[]>>): string[] {
  const type = Object.values(values).some((v) => typeof v !== 'string') ? '[String: [String]]' : '[String: String]'
  return [
    `    /// ${doc}`,
    `    public static let ${name}: ${type} = [`,
    ...Object.entries(values).map(([k, v], i, all) => `        ${swiftString(k)}: ${typeof v === 'string' ? swiftString(v) : swiftList(v)}${i < all.length - 1 ? ',' : ''}`),
    '    ]'
  ]
}

const array = (items: readonly string[]): string => `[${items.map(swiftString).join(', ')}]`

/**
 * The words Input reads, from src/shared/computer/observation.ts: the key
 * names, the modifiers and their aliases, the action words and the role
 * defaults `perform` accepts. Input keeps no hand-written table of names.
 */
export function emitInputTables(): Record<string, string> {
  const lines = [
    ...HEADER.map((l) => l.replace('protocol.ts', 'observation.ts')),
    '/// The observation grammar\'s words Input acts on (docs/computer-protocol.md §4.1, §5.1).',
    'public enum InputTables {',
    ...dictionary('keyNames', 'Lower-cased X11 keysym name or alias → the canonical name; a modifier is a key too.', KEY_NAMES),
    `    /// The modifiers in the order a combo prints them; on the Mac \`super\` is Command and \`alt\` is Option.`,
    `    public static let modifiers: [String] = ${array(MODIFIERS)}`,
    ...dictionary('modifierNames', 'Lower-cased name → modifier.', MODIFIER_NAMES),
    ...dictionary('actionWords', 'Raw AX action name → the word an observation lists.', ACTION_WORDS),
    `    /// Raw actions never listed.`,
    `    public static let droppedActions: Set<String> = ${array([...DROPPED_ACTIONS].sort())}`,
    ...dictionary('roleTags', 'AX role, or `role:subrole`, → the word an element line prints.', ROLE_TAGS),
    '    /// What every element of a role takes without listing it.',
    '    public static let roleDefaults: [String: [String]] = [',
    ...sortedKeys(ROLE_DEFAULTS).map((k) => `        ${swiftString(k)}: ${array(ROLE_DEFAULTS[k])},`),
    '    ]',
    '    /// Roles that take typing and `set_value` by default (unless read-only).',
    `    public static let typingRoles: Set<String> = ${array([...TYPING_ROLES].sort())}`,
    '    /// The wheel distance a `scroll-bar` step moves its bar by, per click, in points (protocol.ts SCROLL_POINTS_PER_CLICK, §24.5).',
    `    public static let scrollPointsPerClick = ${SCROLL_POINTS_PER_CLICK}`,
    '}',
    ''
  ]
  return { 'InputTables.swift': lines.join('\n') }
}

const swiftSet = (name: string, doc: string, values: Iterable<string>): string[] => [`    /// ${doc}`, `    public static let ${name}: Set<String> = ${swiftList(values)}`]

/**
 * The observation grammar's tables for the AX reader (plan §8):
 * src/shared/computer/observation.ts → native/tc-computer/Sources/AXText/Generated/ObservationTables.swift,
 * so the words the reader prints and the ones the parser reads have one home.
 * The numbers are ComputerDefaults' (Contract.swift).
 */
export function emitObservationTables(): string {
  return [
    '// Generated by scripts/gen-swift-computer.ts from src/shared/computer/observation.ts — do not edit.',
    '// Regenerate with `bun run gen:swift-computer`; `bun run check:swift-computer` fails the gate when this is stale.',
    '',
    '/// The observation grammar\'s words (docs/computer-protocol.md §4.1); the numbers are `ComputerDefaults.ObservationText`.',
    'public enum ObservationTables {',
    ...swiftMap('roleTags', 'AX role, or `role:subrole`, → the word an element line prints. A subrole entry wins.', ROLE_TAGS),
    ...swiftMap('subroleNames', 'The window buttons carry no title or description; their subrole names them.', SUBROLE_NAMES),
    '    /// A window\'s title-bar buttons, in the order they close its children (§22.1).',
    `    public static let titleBarSubroles: [String] = ${swiftList(TITLE_BAR_SUBROLES)}`,
    '    /// Points from a window\'s top-left: the sharing badge\'s place on a window with no buttons, and where the pixel watch looks away (§22.2, §22.8).',
    `    public static let titleBarCornerWidth: Double = ${TITLE_BAR_CORNER.w}`,
    `    public static let titleBarCornerHeight: Double = ${TITLE_BAR_CORNER.h}`,
    ...swiftSet('structuralRoles', 'Kept with no name, value, action or state: they give the tree its shape.', STRUCTURAL_ROLES),
    '    /// In the order a line prints them.',
    `    public static let stateWords: [String] = ${swiftList(STATE_WORDS)}`,
    ...swiftSet('toggleRoles', 'Checkbox, switch and radio always print one of checked, unchecked, mixed.', TOGGLE_ROLES),
    ...swiftMap('actionWords', 'Raw AX action → its word.', ACTION_WORDS),
    ...swiftSet('droppedActions', 'Never listed.', DROPPED_ACTIONS),
    ...swiftSet('ambientActions', 'Actions every web-content node carries: defaults of every role inside a web area (A5).', AMBIENT_ACTIONS),
    ...swiftMap('roleDefaults', 'What every element of a role takes without listing it.', ROLE_DEFAULTS),
    ...swiftSet('typingRoles', 'Roles that take typing and `set_value` by default (unless `read-only`).', TYPING_ROLES),
    `    public static let headerSeparator = ${swiftString(HEADER_SEPARATOR)}`,
    `    public static let headerLoading = ${swiftString(HEADER_WORDS.loading)}`,
    `    public static let headerNotDrawn = ${swiftString(HEADER_WORDS.notDrawn)}`,
    `    public static let headerDiff = ${swiftString(HEADER_WORDS.diff)}`,
    `    public static let headerUnchanged = ${swiftString(HEADER_WORDS.unchanged)}`,
    `    public static let headerThin = ${swiftString(HEADER_WORDS.thin)}`,
    `    public static let otherWindowsPrefix = ${swiftString(OTHER_WINDOWS_PREFIX)}`,
    `    public static let stubSuffix = ${swiftString(STUB_SUFFIX)}`,
    '}',
    ''
  ].join('\n')
}

const here = dirname(fileURLToPath(import.meta.url))
export const COMPUTER_GENERATED_DIR = resolve(here, '..', 'native', 'tc-computer', 'Sources', 'ComputerProtocol', 'Generated')
export const INPUT_GENERATED_DIR = resolve(here, '..', 'native', 'tc-computer', 'Sources', 'Input', 'Generated')
export const OBSERVATION_TABLES_DIR = resolve(here, '..', 'native', 'tc-computer', 'Sources', 'AXText', 'Generated')

/** The notification file a method's fixture is named after: `$/` dropped, `/` → `-`. */
export const notificationFixtureName = (m: string): string => `notify-${m.replace(/^\$\//, '').replace(/\//g, '-')}`


if (import.meta.main) {
  const names = { check: 'check:swift-computer', gen: 'gen:swift-computer' }
  writeOrCheck(COMPUTER_GENERATED_DIR, generateComputer(), names)
  writeOrCheck(INPUT_GENERATED_DIR, emitInputTables(), names)
  writeOrCheck(OBSERVATION_TABLES_DIR, { 'ObservationTables.swift': emitObservationTables() }, names)
}
