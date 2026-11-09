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
  COMPUTER_METHODS,
  COMPUTER_PROTOCOL,
  COMPUTER_WAIT,
  ComputerActionNameSchema,
  ComputerActionSchema,
  ComputerErrorKindSchema,
  ComputerErrorSchema,
  ComputerNotificationSchema,
  CoordinateSpaceSchema,
  DisplayInfoSchema,
  ElementBriefSchema,
  EmptySchema,
  HostNotificationSchema,
  InputViaSchema,
  InterruptedBySchema,
  KeyWindowStateSchema,
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
import { ACTION_WORDS, DROPPED_ACTIONS, KEY_NAMES, MODIFIER_NAMES, MODIFIERS, ROLE_DEFAULTS, ROLE_TAGS, TYPING_ROLES } from '../src/shared/computer/observation'
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
  type('Empty', EmptySchema),
  type('Rect', RectSchema),
  type('Point', PointSchema),
  type('Region', RegionSchema),
  type('Permissions', PermissionsSchema),
  type('AppRef', AppRefSchema),
  type('WindowRef', WindowRefSchema),
  type('Target', TargetSchema),
  type('CoordinateSpace', CoordinateSpaceSchema),
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
  type('Budget', BudgetSchema),
  type('ObserveOptions', ObserveOptionsSchema),
  type('ObservationStats', ObservationStatsSchema),
  type('Observation', ObservationSchema),
  type('ComputerError', ComputerErrorSchema),
  type('ActionResult', ActionResultSchema),
  type('BatchResult', BatchResultSchema),
  type('SessionRef', SessionRefSchema),
  type('ProbeReport', ProbeReportSchema),
  type('SessionRestore', SessionRestoreSchema),
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
    '}',
    ''
  ]
  return { 'InputTables.swift': lines.join('\n') }
}

const here = dirname(fileURLToPath(import.meta.url))
export const COMPUTER_GENERATED_DIR = resolve(here, '..', 'native', 'tc-computer', 'Sources', 'ComputerProtocol', 'Generated')
export const INPUT_GENERATED_DIR = resolve(here, '..', 'native', 'tc-computer', 'Sources', 'Input', 'Generated')

/** The notification file a method's fixture is named after: `$/` dropped, `/` → `-`. */
export const notificationFixtureName = (m: string): string => `notify-${m.replace(/^\$\//, '').replace(/\//g, '-')}`


if (import.meta.main) {
  const names = { check: 'check:swift-computer', gen: 'gen:swift-computer' }
  writeOrCheck(COMPUTER_GENERATED_DIR, generateComputer(), names)
  writeOrCheck(INPUT_GENERATED_DIR, emitInputTables(), names)
}
