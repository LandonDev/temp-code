import { z } from 'zod'

/**
 * The computer-use wire: newline JSON-RPC 2.0 on stdio between the host and
 * `tc-computer`, the Swift service on the Mac (docs/computer-protocol.md).
 * This file is the one source: every method's params and result, the
 * observation, the step results, the errors and the notifications are zod
 * here, and scripts/gen-swift-computer.ts writes the Swift Codable types the
 * service decodes (native/tc-computer/Sources/ComputerProtocol/Generated/).
 *
 * Shapes stay ones the generator emits as written: fixed-length arrays for
 * points and regions (`[Int]` in Swift), objects of optional fields with a
 * refinement where a field is one of two, discriminated unions only on a
 * string literal, never `z.unknown()`.
 */

/** Adding a method, an optional field, an error kind or an enum value keeps it; anything else bumps it. */
export const COMPUTER_PROTOCOL = 1

// ── numbers: one home for each ──────────────────────────────────────────

/** The service process and its frames (§1). */
export const SERVICE = {
  /** one frame is one line, at most this many bytes */
  lineMaxBytes: 16 * 1024 * 1024,
  /** `shutdown` is answered, then the process is gone within this */
  shutdownExitMs: 2_000,
  /** how often the service checks that its parent is still there */
  parentPollMs: 5_000,
  /** how often a grant that is off is read again */
  permissionPollMs: 2_000,
  /** how long an action waits for its app's slot before `app_busy` */
  appSlotWaitMs: 5_000,
  /** a held button or key is let go this long after its down with no up */
  heldInputReleaseMs: 30_000,
  /** `input.restoreSession { afterInterrupt }` acts despite the person's touch only this long after it stopped a step */
  restoreAfterInterruptMs: 2_000,
  /** actions in one `action.batch` */
  batchMaxActions: 32,
  /** requests running at once; a slot frees only once its response is written */
  maxInFlight: 32,
  /** requests waiting for a slot before a new one answers `overloaded` */
  maxQueued: 256,
  /** unsent output past this means the host stopped reading: the service exits 70 */
  outboxBudgetBytes: 64 * 1024 * 1024,
  /** how long `initialize` waits for a service still exiting to let go of `<dataDir>/service.lock` */
  serviceLockWaitMs: 3_000,
  /** how long a launch waits for the app's first window */
  launchWindowMs: 10_000,
  /** how often a grant that is on is read again, so a revoked one is noticed */
  permissionPollGrantedMs: 30_000,
  /** how often the pasteboard's change count is read (`clipboard.state`) */
  clipboardPollMs: 250
} as const

/** The AX walk (§4.3). */
export const AX_WALK = {
  maxNodes: 5_000,
  maxMs: 2_000,
  /** AXUIElementSetMessagingTimeout per app: a hung app answers `timeout` */
  messagingTimeoutMs: 2_000
} as const

/** Observation text (§4.1, §4.5). */
export const OBSERVATION_TEXT = {
  indentSpaces: 2,
  maxDepth: 10,
  /** Unicode scalars of a name before `…` */
  nameMaxChars: 100,
  /** Unicode scalars of a value before `…(+<n> chars)` */
  valueMaxChars: 160,
  /** a run of this many unnamed, stateless siblings of one role folds into a range line */
  rangeFoldRun: 6,
  /** thin: fewer elements with a role-default action than this… */
  thinActionable: 3,
  /** …and fewer bytes of names and values than this */
  thinTextBytes: 200
} as const

/** The observation's size budget (§4.5). */
export const OBSERVATION_BUDGET = {
  defaultBytes: 24_000,
  minBytes: 2_000,
  maxBytes: 96_000,
  /** a diff over this many bytes is answered as a full observation */
  diffMaxBytes: 12_000,
  /** a diff over this share of the full text's bytes is answered as a full observation */
  diffMaxShare: 0.6
} as const

/** Window screenshots (§6). */
export const SHOT = {
  defaultMaxEdge: 1_280,
  minMaxEdge: 512,
  maxMaxEdge: 2_576,
  maxPixels: 3_750_000,
  jpegQuality: 0.85
} as const

/** The preview stream (§6). */
export const PREVIEW_STREAM = {
  defaultFps: 4,
  minFps: 1,
  maxFps: 15,
  defaultMaxEdge: 960,
  /** the stream's long edge may go below a screenshot's: the preview is a thumbnail */
  minMaxEdge: 256,
  frameMaxBytes: 512 * 1024,
  maxUnacked: 2,
  /** a click on a window whose stream starts this long after the click's call answered is sent on it once (P2) */
  clickCarryMs: 2_000
} as const

/** The person's Escape while the session is held (§8, P1): the host renews the watch, and it ends on its own when the host stops. */
export const ESCAPE_WATCH = {
  leaseMs: 30_000,
  renewMs: 10_000,
  minLeaseMs: 1_000,
  maxLeaseMs: 120_000,
  /** kVK_Escape */
  keycode: 53
} as const

/** `type` (§5.3). */
export const TYPING = {
  /** UTF-16 units per Unicode key event */
  keyChunkUnits: 20,
  /** text this long goes through the pasteboard */
  pasteMinUnits: 2_000,
  /** how long a paste waits for the element's value to change */
  pasteSettleMs: 500,
  /** the `paste` verb's text, in UTF-16 units */
  pasteMaxUnits: 200_000
} as const

/**
 * The two Mac-wide locks every service shares (§1, §5.3): `flock` on `<dir>/<file>` under the user's
 * temporary directory as `confstr(_CS_DARWIN_USER_TEMP_DIR)` gives it, never `$TMPDIR`, so a process
 * whose TMPDIR was overridden cannot split a lock.
 */
export const LOCKS = {
  dir: 'tc-computer',
  clipboard: 'clipboard.lock',
  session: 'session.lock',
  clipboardWaitMs: 2_000,
  clipboardHoldMaxMs: 2_500
} as const

/** A lock's path under the given temporary directory. */
export function lockPath(tmpdir: string, which: 'clipboard' | 'session'): string {
  return `${tmpdir.replace(/\/+$/, '')}/${LOCKS.dir}/${LOCKS[which]}`
}

/** Bounds of the action parameters (§5.1). */
export const ACTION_LIMITS = {
  scrollAmountMax: 50,
  repeatMax: 100,
  /** `hold_key` and `wait`, in seconds, as the native members */
  durationMaxSeconds: 300,
  /** a click's `duration`: how long the button stays down */
  clickDurationMaxSeconds: 10
} as const

/** The fixture recorder cuts a raw value past this many characters (§10). */
export const RAW_VALUE_MAX_CHARS = 2_000

// ── shared types (§2) ───────────────────────────────────────────────────

const int = (): z.ZodNumber => z.number().int()

/** Points; screen space unless named otherwise. */
export const RectSchema = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
export type Rect = z.infer<typeof RectSchema>

/** `[x, y]` in the session's coordinate space (§6), integer pixels. */
export const PointSchema = z.array(int()).length(2)
export type Point = z.infer<typeof PointSchema>

/** `[x0, y0, x1, y1]`: top-left and bottom-right, in the session's space. */
export const RegionSchema = z
  .array(int())
  .length(4)
  .refine((r) => r[2] > r[0] && r[3] > r[1], 'a region is [x0, y0, x1, y1] with x1 > x0 and y1 > y0')
export type Region = z.infer<typeof RegionSchema>

export const TierSchema = z.enum(['ax', 'process', 'session'])
export type Tier = z.infer<typeof TierSchema>

/** What the tier verdict learns per app (§5.2), and what `input.probe` tries. */
export const ActionClassSchema = z.enum(['click', 'drag', 'hover', 'scroll', 'key', 'type'])
export type ActionClass = z.infer<typeof ActionClassSchema>

export const PermissionNameSchema = z.enum(['accessibility', 'screenRecording'])
export type PermissionName = z.infer<typeof PermissionNameSchema>

export const PermissionsSchema = z.object({ accessibility: z.boolean(), screenRecording: z.boolean() })
export type Permissions = z.infer<typeof PermissionsSchema>

/** Exactly one: `app` is a bundle id, a display name or an absolute path to an `.app` (§2.1). */
export const AppRefSchema = z
  .object({ app: z.string().min(1).optional(), pid: int().positive().optional() })
  .refine((r) => (r.app === undefined) !== (r.pid === undefined), 'name the app by exactly one of app, pid')
export type AppRef = z.infer<typeof AppRefSchema>

/** Neither field: the app's main window (§2.1). */
export const WindowRefSchema = z
  .object({ id: int().optional(), title: z.string().optional() })
  .refine((r) => r.id === undefined || r.title === undefined, 'name the window by at most one of id, title')
export type WindowRef = z.infer<typeof WindowRefSchema>

/** One positive index from an observation (§4.2). */
export const ElementIndexSchema = int().positive()

export const TargetSchema = z.object({
  session: z.string().min(1),
  app: AppRefSchema,
  window: WindowRefSchema.optional(),
  /** an installed app that is not running is launched in the background */
  launch: z.boolean().optional(),
  /** the epoch of the observation the call's element indices came from; required when a call names an element */
  epoch: z.string().min(1).optional()
})
export type Target = z.infer<typeof TargetSchema>

/** What coordinates mean: the window's screenshot, `scale` pixels per window point (§6). */
export const CoordinateSpaceSchema = z.object({
  width: int().positive(),
  height: int().positive(),
  scale: z.number().positive()
})
export type CoordinateSpace = z.infer<typeof CoordinateSpaceSchema>

export const WindowSpaceSchema = z.enum(['current', 'other', 'unknown'])

export const WindowInfoSchema = z.object({
  id: int(),
  title: z.string(),
  frame: RectSchema,
  main: z.boolean(),
  focused: z.boolean(),
  minimized: z.boolean(),
  onScreen: z.boolean(),
  space: WindowSpaceSchema
})
export type WindowInfo = z.infer<typeof WindowInfoSchema>

export const AppInfoSchema = z.object({
  pid: int(),
  bundleId: z.string().nullable(),
  name: z.string(),
  active: z.boolean(),
  hidden: z.boolean(),
  windows: z.array(WindowInfoSchema).optional()
})
export type AppInfo = z.infer<typeof AppInfoSchema>

/** The smart wait (§7); every time counts from the action's last input. */
export const WaitOptionsSchema = z
  .object({
    minMs: int().nonnegative(),
    quietMs: int().nonnegative(),
    maxMs: int().nonnegative(),
    busyMaxMs: int().nonnegative()
  })
  .refine((w) => w.minMs <= w.maxMs && w.maxMs <= w.busyMaxMs, 'a wait needs minMs ≤ maxMs ≤ busyMaxMs')
export type WaitOptions = z.infer<typeof WaitOptionsSchema>

export const WaitReasonSchema = z.enum(['quiet', 'max', 'busy-max', 'cancelled', 'skipped'])

export const WaitReportSchema = z.object({
  waitedMs: int().nonnegative(),
  settled: z.boolean(),
  busy: z.boolean(),
  reason: WaitReasonSchema
})
export type WaitReport = z.infer<typeof WaitReportSchema>

/** The four waits the host sends with every call (§7). The Task benchmark tunes these rows and nothing else. */
export const COMPUTER_WAIT = {
  /** after the last action */
  action: { minMs: 300, quietMs: 450, maxMs: 1_500, busyMaxMs: 5_000 },
  /** between batch steps */
  step: { minMs: 0, quietMs: 150, maxMs: 1_000, busyMaxMs: 2_000 },
  /** a plain `state.get` */
  observe: { minMs: 0, quietMs: 300, maxMs: 1_000, busyMaxMs: 5_000 }
} as const satisfies Record<string, WaitOptions>

/** The wheel's distance a `scroll-bar` step moves its bar by, per click (§24.5); the Task benchmark tunes it. */
export const SCROLL_POINTS_PER_CLICK = 40

/** The `wait` action's row: the smart wait capped at `duration` seconds. */
export function waitActionWait(durationSeconds: number): WaitOptions {
  const capMs = Math.round(durationSeconds * 1000)
  return { minMs: 0, quietMs: 450, maxMs: capMs, busyMaxMs: capMs }
}

export const ShotFormatSchema = z.enum(['jpeg', 'png'])
export type ShotFormat = z.infer<typeof ShotFormatSchema>

export const ShotSchema = z.object({
  path: z.string(),
  format: ShotFormatSchema,
  width: int().positive(),
  height: int().positive(),
  bytes: int().nonnegative(),
  scale: z.number().positive(),
  window: z.object({ id: int(), frame: RectSchema }),
  region: RegionSchema.optional(),
  /** every pixel one colour: a window on another Space the compositor has not drawn */
  blank: z.boolean(),
  /** epoch ms */
  capturedAt: int()
})
export type Shot = z.infer<typeof ShotSchema>

/** `line`: the element's observation line after its indent and `[<index>] ` (`button "Save"`). */
export const ElementBriefSchema = z.object({ index: ElementIndexSchema, line: z.string() })
export type ElementBrief = z.infer<typeof ElementBriefSchema>

// ── actions (§5.1) ──────────────────────────────────────────────────────

/** The first 17 are Anthropic's `computer_toolset_20260801` member names; the last four are ours. */
export const COMPUTER_ACTION_NAMES = [
  'screenshot',
  'zoom',
  'left_click',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'left_click_drag',
  'mouse_move',
  'left_mouse_down',
  'left_mouse_up',
  'cursor_position',
  'scroll',
  'type',
  'key',
  'hold_key',
  'wait',
  'set_value',
  'perform',
  'select_text',
  'paste'
] as const
export const ComputerActionNameSchema = z.enum(COMPUTER_ACTION_NAMES)
export type ComputerActionName = z.infer<typeof ComputerActionNameSchema>

export const ScrollDirectionSchema = z.enum(['up', 'down', 'left', 'right'])

/** `select_text`: select the match, or put the caret before or after it with nothing selected. */
export const PlacementSchema = z.enum(['select', 'before', 'after'])
export type Placement = z.infer<typeof PlacementSchema>

/** What a `paste` puts on the pasteboard: plain text, markdown rendered to HTML and RTF, or HTML as given. */
export const PasteFormatSchema = z.enum(['text', 'markdown', 'html'])
export type PasteFormat = z.infer<typeof PasteFormatSchema>

/** Every parameter any action takes, each optional: one flat object, one Swift struct. */
export const COMPUTER_ACTION_SHAPE = {
  action: ComputerActionNameSchema,
  coordinate: PointSchema.optional(),
  element: ElementIndexSchema.optional(),
  start_coordinate: PointSchema.optional(),
  start_element: ElementIndexSchema.optional(),
  /** modifiers on a click, drag or scroll; the string for `type` and `paste`; the key or combo for `key` and `hold_key`; the text to select */
  text: z.string().optional(),
  /** `select_text`: the match must sit right after this */
  prefix: z.string().min(1).optional(),
  /** `select_text`: the match must sit right before this */
  suffix: z.string().min(1).optional(),
  /** `select_text`: select the match (the default), or put the caret before or after it */
  place: PlacementSchema.optional(),
  /** `paste`: what the text is (default `text`) */
  format: PasteFormatSchema.optional(),
  region: RegionSchema.optional(),
  scroll_direction: ScrollDirectionSchema.optional(),
  /** wheel clicks */
  scroll_amount: int().min(1).max(ACTION_LIMITS.scrollAmountMax).optional(),
  repeat: int().min(1).max(ACTION_LIMITS.repeatMax).optional(),
  /** seconds; on a click, how long the button stays down (at most ACTION_LIMITS.clickDurationMaxSeconds) */
  duration: z.number().positive().max(ACTION_LIMITS.durationMaxSeconds).optional(),
  value: z.string().optional(),
  /** an action word the element lists, or a role default */
  name: z.string().min(1).optional(),
  /** `[a, b]` in UTF-16 units */
  range: z.array(int().nonnegative()).length(2).optional()
}
export type ActionParam = Exclude<keyof typeof COMPUTER_ACTION_SHAPE, 'action'>

const POINTER = ['element', 'coordinate', 'text'] as const satisfies ActionParam[]
/** A click may hold its button down for `duration` seconds. */
const CLICK = [...POINTER, 'duration'] as const satisfies ActionParam[]

/** The five click verbs, which take a `duration` of at most ACTION_LIMITS.clickDurationMaxSeconds. */
export const CLICK_ACTIONS: readonly ComputerActionName[] = ['left_click', 'right_click', 'middle_click', 'double_click', 'triple_click']

/** What each action takes (§5.1). `oneOf` lists groups of which exactly one must be given. */
export const ACTION_PARAMS: Record<
  ComputerActionName,
  { required: ActionParam[]; optional: ActionParam[]; oneOf?: ActionParam[][] }
> = {
  screenshot: { required: [], optional: [] },
  zoom: { required: ['region'], optional: [] },
  left_click: { required: [], optional: [...CLICK] },
  right_click: { required: [], optional: [...CLICK] },
  middle_click: { required: [], optional: [...CLICK] },
  double_click: { required: [], optional: [...CLICK] },
  triple_click: { required: [], optional: [...CLICK] },
  left_click_drag: {
    required: [],
    optional: ['start_element', 'start_coordinate', 'element', 'coordinate', 'text'],
    oneOf: [
      ['start_element', 'start_coordinate'],
      ['element', 'coordinate']
    ]
  },
  mouse_move: { required: [], optional: ['element', 'coordinate'], oneOf: [['element', 'coordinate']] },
  left_mouse_down: { required: [], optional: [] },
  left_mouse_up: { required: [], optional: [] },
  cursor_position: { required: [], optional: [] },
  scroll: { required: ['scroll_direction', 'scroll_amount'], optional: [...POINTER] },
  type: { required: ['text'], optional: ['element'] },
  key: { required: ['text'], optional: ['repeat'] },
  hold_key: { required: ['text', 'duration'], optional: [] },
  wait: { required: ['duration'], optional: [] },
  set_value: { required: ['element', 'value'], optional: [] },
  perform: { required: ['element', 'name'], optional: [] },
  select_text: { required: ['element'], optional: ['text', 'range', 'prefix', 'suffix', 'place'], oneOf: [['text', 'range']] },
  paste: { required: ['text'], optional: ['format', 'element'] }
}

/** Pairs that never go together on any action. */
const EXCLUSIVE: [ActionParam, ActionParam][] = [
  ['element', 'coordinate'],
  ['start_element', 'start_coordinate'],
  ['text', 'range'],
  ['range', 'prefix'],
  ['range', 'suffix']
]

/** The per-action rules of §5.1, for any object that carries the action shape. */
export function refineAction(value: { action: ComputerActionName } & Partial<Record<ActionParam, unknown>>, ctx: z.RefinementCtx): void {
  const spec = ACTION_PARAMS[value.action]
  const given = (p: ActionParam): boolean => value[p] !== undefined
  const allowed = new Set<ActionParam>([...spec.required, ...spec.optional])
  for (const p of Object.keys(COMPUTER_ACTION_SHAPE) as (ActionParam | 'action')[]) {
    if (p === 'action' || !given(p) || allowed.has(p)) continue
    ctx.addIssue({ code: 'custom', path: [p], message: `${value.action} takes no ${p}` })
  }
  for (const p of spec.required)
    if (!given(p)) ctx.addIssue({ code: 'custom', path: [p], message: `${value.action} needs ${p}` })
  for (const [a, b] of EXCLUSIVE)
    if (given(a) && given(b)) ctx.addIssue({ code: 'custom', path: [b], message: `give ${a} or ${b}, not both` })
  for (const group of spec.oneOf ?? [])
    if (!group.some(given))
      ctx.addIssue({ code: 'custom', path: [group[0]], message: `${value.action} needs one of ${group.join(', ')}` })
  if ((value.action === 'type' || value.action === 'key' || value.action === 'hold_key' || value.action === 'paste') && value.text === '')
    ctx.addIssue({ code: 'custom', path: ['text'], message: `${value.action} needs a non-empty text` })
  if (value.action === 'paste' && typeof value.text === 'string' && value.text.length > TYPING.pasteMaxUnits)
    ctx.addIssue({ code: 'custom', path: ['text'], message: `paste takes at most ${TYPING.pasteMaxUnits} UTF-16 units` })
  if (CLICK_ACTIONS.includes(value.action) && typeof value.duration === 'number' && value.duration > ACTION_LIMITS.clickDurationMaxSeconds)
    ctx.addIssue({ code: 'custom', path: ['duration'], message: `a click holds its button at most ${ACTION_LIMITS.clickDurationMaxSeconds} s` })
  const range = value.range as number[] | undefined
  if (range && range[0] > range[1])
    ctx.addIssue({ code: 'custom', path: ['range'], message: 'a range is [a, b] with a ≤ b' })
}

/** One flat object: `action` plus that action's parameters (§5.1). */
export const ComputerActionSchema = z.object(COMPUTER_ACTION_SHAPE).superRefine(refineAction)
export type ComputerAction = z.infer<typeof ComputerActionSchema>

/** The element indices an action names. */
export function actionElements(action: Pick<ComputerAction, 'element' | 'start_element'>): number[] {
  return [action.element, action.start_element].filter((i): i is number => i !== undefined)
}

/** Actions that send no input: their step's `tier` is null. */
export const NO_INPUT_ACTIONS: readonly ComputerActionName[] = ['screenshot', 'zoom', 'cursor_position', 'wait']

/** Actions after which a batch takes no `stepWait`: they cannot change the screen. */
export const STILL_ACTIONS: readonly ComputerActionName[] = NO_INPUT_ACTIONS

// ── observation (§4) ────────────────────────────────────────────────────

export const ObservationModeSchema = z.enum(['auto', 'full'])
export const ObserveModeSchema = z.enum(['auto', 'full', 'none'])
export const ScreenshotPolicySchema = z.enum(['auto', 'always', 'never'])
export const ObservationKindSchema = z.enum(['full', 'diff', 'unchanged', 'subtree'])
export type ObservationKind = z.infer<typeof ObservationKindSchema>

export const BudgetSchema = z.object({
  bytes: int().min(OBSERVATION_BUDGET.minBytes).max(OBSERVATION_BUDGET.maxBytes)
})

const MaxEdgeSchema = int().min(SHOT.minMaxEdge).max(SHOT.maxMaxEdge)

/** The knobs of the observation that closes an action; `mode: 'none'` asks for none. */
export const ObserveOptionsSchema = z.object({
  mode: ObserveModeSchema.optional(),
  screenshot: ScreenshotPolicySchema.optional(),
  maxEdge: MaxEdgeSchema.optional(),
  geometry: z.boolean().optional(),
  menus: z.boolean().optional(),
  budget: BudgetSchema.optional()
})
export type ObserveOptions = z.infer<typeof ObserveOptionsSchema>

export const ObservationStatsSchema = z.object({
  elements: int().nonnegative(),
  lines: int().nonnegative(),
  bytes: int().nonnegative(),
  /** elements the budget left out */
  omitted: int().nonnegative(),
  /** too poor to act from (§4.5) */
  thin: z.boolean(),
  /** the walk stopped at its node or time cap */
  partial: z.boolean(),
  readMs: int().nonnegative()
})
export type ObservationStats = z.infer<typeof ObservationStatsSchema>

// ── errors (§8) ─────────────────────────────────────────────────────────

export const COMPUTER_ERROR_KINDS = [
  'not_initialized',
  'protocol_mismatch',
  'permission_missing',
  'unknown_session',
  'app_not_found',
  'window_not_found',
  'window_minimized',
  'stale_element',
  'no_such_element',
  'action_unsupported',
  'needs_tier',
  'out_of_bounds',
  'invalid_key',
  'interrupted',
  'app_busy',
  'cancelled',
  'clipboard_busy',
  'capture_failed',
  'timeout',
  'text_not_found',
  'key_window_unavailable',
  'session_unavailable',
  'already_running'
] as const
export const ComputerErrorKindSchema = z.enum(COMPUTER_ERROR_KINDS)
export type ComputerErrorKind = z.infer<typeof ComputerErrorKindSchema>

/** Kinds only a step can carry: no read and no start check ever answers them as a JSON-RPC error. */
export const STEP_ONLY_ERROR_KINDS: readonly ComputerErrorKind[] = [
  'action_unsupported',
  'needs_tier',
  'invalid_key',
  'interrupted',
  'app_busy',
  'clipboard_busy',
  'text_not_found',
  'key_window_unavailable'
]

export const InterruptedBySchema = z.enum(['person'])
/** `stale_element`: gone, service-restarted. `session_unavailable`: locked, secure-input, activation-refused, in-use. `clipboard_busy`: recent-copy. */
export const ErrorReasonSchema = z.enum(['gone', 'service-restarted', 'locked', 'secure-input', 'activation-refused', 'in-use', 'recent-copy'])
export type ErrorReason = z.infer<typeof ErrorReasonSchema>

/** An app as a session step or a restore names it. */
export const AppBriefSchema = z.object({ pid: int(), bundleId: z.string().nullable(), name: z.string() })
export type AppBrief = z.infer<typeof AppBriefSchema>

/** `[x, y]` in global screen points, top-left origin; fractional. */
const ScreenPointSchema = z.array(z.number()).length(2)

/**
 * What a session-tier step changed on the Mac: the app in front and the pointer, before the step and after it.
 * A step that posted input also says its span, so the host can tell the step's own input from the person's
 * (src/main/personIdle.ts); all three are epoch ms and absent when the step posted nothing.
 */
export const SessionChangeSchema = z.object({
  frontmost: z.object({ before: AppBriefSchema.optional(), after: AppBriefSchema.optional() }),
  pointer: z.object({ before: ScreenPointSchema, after: ScreenPointSchema }),
  /** the service holds a state `input.restoreSession` can put back */
  restorable: z.boolean(),
  /** when the step armed its person watch */
  armedAt: z.number().optional(),
  /** the system's idle time when the watch armed: the person's last input before the step is armedAt − idleAtArmMs */
  idleAtArmMs: z.number().nonnegative().optional(),
  /** the step's last posted event */
  lastInputAt: z.number().optional()
})
export type SessionChange = z.infer<typeof SessionChangeSchema>

export const ComputerErrorSchema = z.object({
  kind: ComputerErrorKindSchema,
  /** one plain sentence a model can act on */
  message: z.string(),
  which: PermissionNameSchema.optional(),
  candidates: z.array(z.string()).optional(),
  element: ElementIndexSchema.optional(),
  reason: ErrorReasonSchema.optional(),
  available: z.array(z.string()).optional(),
  needed: TierSchema.optional(),
  coordinate: PointSchema.optional(),
  space: CoordinateSpaceSchema.optional(),
  by: InterruptedBySchema.optional(),
  /** `key_window_unavailable`: the window that is key in the app, when there is one */
  keyWindow: z.object({ id: int(), title: z.string() }).optional(),
  /** a session-tier step that failed after it began to change the Mac says what it changed */
  session: SessionChangeSchema.optional(),
  /** a shortcut whose menu item is disabled (§24.2): the item's title path, `["File", "Close"]` */
  menu: z.array(z.string()).max(8).optional()
})
export type ComputerError = z.infer<typeof ComputerErrorSchema>

/** The observation (§4); here, after the errors, since a shot that could not be taken says why. */
export const ObservationSchema = z.object({
  epoch: z.string(),
  session: z.string(),
  app: z.object({ pid: int(), bundleId: z.string().nullable(), name: z.string() }),
  window: z.object({ id: int(), title: z.string(), frame: RectSchema }),
  kind: ObservationKindSchema,
  /** per session × app: +1 per full, diff or unchanged observation returned; a subtree carries the current one */
  seq: int().nonnegative(),
  /** the seq a diff is against */
  base: int().nonnegative().optional(),
  /** what the model reads (§4.1) */
  text: z.string(),
  space: CoordinateSpaceSchema,
  stats: ObservationStatsSchema,
  shot: ShotSchema.optional(),
  /** the screenshot this observation would carry could not be taken (Screen Recording off, minimized, capture failed) */
  shotError: ComputerErrorSchema.optional(),
  waited: WaitReportSchema.optional()
})
export type Observation = z.infer<typeof ObservationSchema>

// ── step results (§3) ───────────────────────────────────────────────────

/**
 * How a step's input went in: the four typing routes, then the background fallbacks of §24 (appended, so the
 * Swift enum keeps its old cases' order): a shortcut's menu item, the element under a click, the caret, the
 * scroll bar, the page scroll a wheel became.
 */
export const InputViaSchema = z.enum(['ax-insert', 'ax-value', 'keys', 'paste', 'menu', 'hit', 'caret', 'scroll-bar', 'scroll-page'])
export type InputVia = z.infer<typeof InputViaSchema>
/** The fallback routes whose misses the host learns (§24.1, §17.3); `menu`, `scroll-bar` and the typing routes are not learned. */
export const LEARNED_VIAS = ['hit', 'caret', 'scroll-page'] as const satisfies readonly InputVia[]
export type LearnedVia = (typeof LEARNED_VIAS)[number]
export const ClipboardOutcomeSchema = z.enum(['restored', 'kept-person-copy'])
export type ClipboardOutcome = z.infer<typeof ClipboardOutcomeSchema>
export const StepEffectSchema = z.enum(['changed', 'none', 'unknown'])
export type StepEffect = z.infer<typeof StepEffectSchema>

export const StepOkSchema = z.object({
  index: int().nonnegative(),
  action: ComputerActionNameSchema,
  status: z.literal('ok'),
  /** null for actions that send no input */
  tier: TierSchema.nullable(),
  effect: StepEffectSchema,
  element: ElementBriefSchema.optional(),
  /** present on every step a typing or fallback route ran (§24.8): the route, the clipboard's outcome, what it acted on (`File › Close`, `button "Save"`) */
  input: z.object({ via: InputViaSchema, clipboard: ClipboardOutcomeSchema.optional(), on: z.string().max(200).optional() }).optional(),
  cursor: PointSchema.optional(),
  /** `cursor_position`'s answer: `X=512, Y=384` */
  text: z.string().optional(),
  /** the image of `screenshot` and `zoom` */
  shot: ShotSchema.optional(),
  waited: WaitReportSchema.optional(),
  /** present on every step that ran at the `session` tier */
  session: SessionChangeSchema.optional()
})
export const StepFailedSchema = z.object({
  index: int().nonnegative(),
  action: ComputerActionNameSchema,
  status: z.literal('failed'),
  error: ComputerErrorSchema
})
export const StepNotRunSchema = z.object({
  index: int().nonnegative(),
  action: ComputerActionNameSchema,
  status: z.literal('not-run')
})
export const StepResultSchema = z.discriminatedUnion('status', [StepOkSchema, StepFailedSchema, StepNotRunSchema])
export type StepResult = z.infer<typeof StepResultSchema>

export const ActionResultSchema = z.object({
  step: StepResultSchema,
  /** absent with observe.mode 'none', or when observationError says why */
  observation: ObservationSchema.optional(),
  /** the closing observation failed; the step stands */
  observationError: ComputerErrorSchema.optional()
})
export type ActionResult = z.infer<typeof ActionResultSchema>

export const BatchResultSchema = z.object({
  steps: z.array(StepResultSchema),
  observation: ObservationSchema.optional(),
  observationError: ComputerErrorSchema.optional(),
  waited: WaitReportSchema
})
export type BatchResult = z.infer<typeof BatchResultSchema>

// ── methods (§3) ────────────────────────────────────────────────────────

/** `{}`: the params of a method that takes nothing, the result of one that answers nothing. */
export const EmptySchema = z.object({})

export const DisplayInfoSchema = z.object({ id: int(), frame: RectSchema, scale: z.number().positive() })

export const SessionRefSchema = z.object({ session: z.string().min(1) })

/** A call that names an element carries the epoch of the observation it came from (§4.2). */
function needsEpoch(names: number[], epoch: string | undefined, ctx: z.RefinementCtx): void {
  if (names.length && epoch === undefined)
    ctx.addIssue({ code: 'custom', path: ['epoch'], message: 'a call that names an element carries the epoch of its observation' })
}

export const StateGetParamsSchema = TargetSchema.extend({
  mode: ObservationModeSchema.optional(),
  /** that element's subtree, whole */
  element: ElementIndexSchema.optional(),
  screenshot: ScreenshotPolicySchema.optional(),
  maxEdge: MaxEdgeSchema.optional(),
  geometry: z.boolean().optional(),
  menus: z.boolean().optional(),
  budget: BudgetSchema.optional(),
  wait: WaitOptionsSchema.optional()
}).superRefine((p, ctx) => needsEpoch(p.element === undefined ? [] : [p.element], p.epoch, ctx))

/** A paste waits out the person's copy: one within this many ms fails the step `clipboard_busy { reason: 'recent-copy' }` with the pasteboard untouched. */
const PasteQuietSchema = int().nonnegative()

/**
 * The routes and process classes this app was seen to ignore (§24.1): the service runs them last, or with
 * `skip` not at all, answering `needs_tier` as if they did not exist.
 */
export const IgnoredRoutesSchema = z.object({
  via: z.array(InputViaSchema).optional(),
  process: z.array(ActionClassSchema).optional(),
  skip: z.boolean().optional()
})
export type IgnoredRoutes = z.infer<typeof IgnoredRoutesSchema>

export const ActionRunParamsSchema = TargetSchema.extend({
  action: ComputerActionSchema,
  /** the tiers the host allows, in order */
  tiers: z.array(TierSchema).min(1),
  wait: WaitOptionsSchema.optional(),
  observe: ObserveOptionsSchema.optional(),
  pasteQuietMs: PasteQuietSchema.optional(),
  ignored: IgnoredRoutesSchema.optional()
}).superRefine((p, ctx) => needsEpoch(actionElements(p.action), p.epoch, ctx))

export const ActionBatchParamsSchema = TargetSchema.extend({
  actions: z.array(ComputerActionSchema).min(1).max(SERVICE.batchMaxActions),
  tiers: z.array(TierSchema).min(1),
  stepWait: WaitOptionsSchema.optional(),
  wait: WaitOptionsSchema.optional(),
  observe: ObserveOptionsSchema.optional(),
  pasteQuietMs: PasteQuietSchema.optional(),
  ignored: IgnoredRoutesSchema.optional()
}).superRefine((p, ctx) => needsEpoch(p.actions.flatMap(actionElements), p.epoch, ctx))

export const CaptureScreenshotParamsSchema = TargetSchema.extend({
  maxEdge: MaxEdgeSchema.optional(),
  region: RegionSchema.optional(),
  format: ShotFormatSchema.optional()
})

export const CaptureStreamStartParamsSchema = TargetSchema.extend({
  stream: z.string().min(1),
  fps: int().min(PREVIEW_STREAM.minFps).max(PREVIEW_STREAM.maxFps).optional(),
  maxEdge: int().min(PREVIEW_STREAM.minMaxEdge).max(SHOT.maxMaxEdge).optional()
})

/** `input.probe`: the classes to try at the process tier; `scroll`, `key` and `click` when left out. */
export const InputProbeParamsSchema = TargetSchema.extend({
  classes: z.array(ActionClassSchema).min(1).optional()
})

export const ProbeOutcomeSchema = z.enum(['honoured', 'ignored', 'untested'])
export type ProbeOutcome = z.infer<typeof ProbeOutcomeSchema>
/** What the app's AXFocusedWindow was when the probe began. */
export const KeyWindowStateSchema = z.enum(['target', 'other', 'none'])

export const ProbeReportSchema = z.object({
  pid: int(),
  bundleId: z.string().nullable(),
  keyWindow: KeyWindowStateSchema,
  results: z.array(
    z.object({
      class: ActionClassSchema,
      outcome: ProbeOutcomeSchema,
      reason: z.string().optional(),
      /** everything the class changed was put back */
      restored: z.boolean(),
      ms: int().nonnegative()
    })
  )
})
export type ProbeReport = z.infer<typeof ProbeReportSchema>

/**
 * `input.restoreSession`: `{}` refuses to act once the person touched the Mac since the last session step;
 * `afterInterrupt` acts within SERVICE.restoreAfterInterruptMs of the touch that stopped a step, each half
 * still checking its own part (the front app is still the one the step left there, the pointer within 2 pt).
 */
export const InputRestoreParamsSchema = z.object({ afterInterrupt: z.boolean().optional() })

export const RestoreOutcomeSchema = z.enum(['restored', 'person-moved', 'app-gone', 'nothing'])
export type RestoreOutcome = z.infer<typeof RestoreOutcomeSchema>

/** What `input.restoreSession` put back of what the session tier changed since the last restore. */
export const SessionRestoreSchema = z.object({
  frontmost: RestoreOutcomeSchema,
  pointer: RestoreOutcomeSchema,
  /** the app it put back in front */
  held: AppBriefSchema.nullable()
})
export type SessionRestore = z.infer<typeof SessionRestoreSchema>

/**
 * `clipboard.state`: when the pasteboard last changed by anyone but this service. It reads the change
 * count only, never the contents. "Quiet for N ms" is `now − max(foreignChangeAt ?? 0, watchingSince) ≥ N`.
 */
export const ClipboardActivitySchema = z.object({
  changeCount: int(),
  /** epoch ms, to the poll's 250 ms; null when no foreign change was seen since the watch began */
  foreignChangeAt: z.number().nullable(),
  /** epoch ms: a copy made before this is invisible to the watch */
  watchingSince: z.number()
})
export type ClipboardActivity = z.infer<typeof ClipboardActivitySchema>

export const InitializeParamsSchema = z.object({
  protocol: int(),
  client: z.object({ name: z.string(), version: z.string() }),
  /** shots go under `<dataDir>/shots/<session>/` */
  dataDir: z.string()
})

export const InitializeResultSchema = z.object({
  protocol: int(),
  service: z.object({ version: z.string(), build: z.string() }),
  /** a new one per process: every element index from another epoch is stale */
  epoch: z.string(),
  os: z.object({ version: z.string(), arch: z.string() }),
  permissions: PermissionsSchema,
  displays: z.array(DisplayInfoSchema)
})

/** Every method: its params and result. The service answers each request with exactly one of them or an error. */
export const COMPUTER_METHODS = {
  initialize: { params: InitializeParamsSchema, result: InitializeResultSchema },
  shutdown: { params: EmptySchema, result: EmptySchema },
  'permissions.get': { params: EmptySchema, result: PermissionsSchema },
  'permissions.request': { params: z.object({ which: PermissionNameSchema }), result: PermissionsSchema },
  'apps.list': {
    params: z.object({ windows: z.boolean().optional() }),
    result: z.object({ apps: z.array(AppInfoSchema) })
  },
  'apps.launch': {
    params: z.object({ app: z.string().min(1), open: z.array(z.string()).optional() }),
    result: z.object({ pid: int(), launched: z.boolean() })
  },
  'session.open': { params: SessionRefSchema, result: EmptySchema },
  'session.close': { params: SessionRefSchema, result: EmptySchema },
  'state.get': { params: StateGetParamsSchema, result: ObservationSchema },
  'action.run': { params: ActionRunParamsSchema, result: ActionResultSchema },
  'action.batch': { params: ActionBatchParamsSchema, result: BatchResultSchema },
  'capture.screenshot': { params: CaptureScreenshotParamsSchema, result: ShotSchema },
  'capture.stream.start': {
    params: CaptureStreamStartParamsSchema,
    result: z.object({ stream: z.string(), width: int().positive(), height: int().positive() })
  },
  'capture.stream.stop': { params: z.object({ stream: z.string().min(1) }), result: EmptySchema },
  'input.probe': { params: InputProbeParamsSchema, result: ProbeReportSchema },
  'input.restoreSession': { params: InputRestoreParamsSchema, result: SessionRestoreSchema },
  'clipboard.state': { params: EmptySchema, result: ClipboardActivitySchema },
  /** P1: while on, the person's unmarked Escape is taken and sent as `escape/pressed`; every other event passes */
  'escape.watch': {
    params: z.object({ on: z.boolean(), leaseMs: int().min(ESCAPE_WATCH.minLeaseMs).max(ESCAPE_WATCH.maxLeaseMs).optional() }),
    result: EmptySchema
  }
} as const satisfies Record<string, { params: z.ZodType; result: z.ZodType }>
export type ComputerMethod = keyof typeof COMPUTER_METHODS
export type ComputerParams<M extends ComputerMethod> = z.infer<(typeof COMPUTER_METHODS)[M]['params']>
export type ComputerResult<M extends ComputerMethod> = z.infer<(typeof COMPUTER_METHODS)[M]['result']>

// ── notifications (§8) ──────────────────────────────────────────────────

const notify = <M extends string, P extends z.ZodType>(method: M, params: P) =>
  z.object({ method: z.literal(method), params })

export const AppChangeSchema = z.enum(['launched', 'terminated', 'activated', 'hidden', 'unhidden'])
export const WindowChangeSchema = z.enum(['created', 'closed', 'minimized', 'restored', 'moved', 'resized', 'titled', 'focused'])
export const StreamEndReasonSchema = z.enum(['stopped', 'window-closed', 'permission', 'error'])
export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error'])

/** What the service sends unasked. A frame also carries `"jsonrpc":"2.0"`, which the framing checks. */
export const ComputerNotificationSchema = z.discriminatedUnion('method', [
  notify('permissions/changed', PermissionsSchema),
  notify(
    'apps/changed',
    z.object({ pid: int(), bundleId: z.string().nullable(), name: z.string(), change: AppChangeSchema })
  ),
  notify('window/changed', z.object({ pid: int(), windowId: int(), change: WindowChangeSchema })),
  notify('session/interrupted', z.object({ session: z.string(), by: InterruptedBySchema, at: int() })),
  notify(
    'capture/frame',
    z.object({
      stream: z.string(),
      seq: int().nonnegative(),
      ts: z.number(),
      width: int().positive(),
      height: int().positive(),
      format: z.enum(['jpeg']),
      /** base64 */
      data: z.string(),
      /** the agent cursor in this frame's pixels */
      cursor: PointSchema.optional()
    })
  ),
  notify('capture/streamEnded', z.object({ stream: z.string(), reason: StreamEndReasonSchema })),
  /** P2: the agent clicked in a streamed window; `at` in the pixels of a `width` × `height` frame, sent whether or not a pixel changed */
  notify('capture/click', z.object({ stream: z.string(), at: PointSchema, width: int().positive(), height: int().positive() })),
  /** P1: the person pressed Escape while the watch was on; epoch ms */
  notify('escape/pressed', z.object({ at: z.number() })),
  notify('log', z.object({ level: LogLevelSchema, message: z.string() }))
])
export type ComputerNotification = z.infer<typeof ComputerNotificationSchema>

/** What the host sends unasked. */
export const HostNotificationSchema = z.discriminatedUnion('method', [
  notify('$/cancel', z.object({ id: int() })),
  notify('capture.stream.ack', z.object({ stream: z.string(), seq: int().nonnegative() }))
])
export type HostNotification = z.infer<typeof HostNotificationSchema>

// ── the JSON-RPC envelope (§1, §8) ──────────────────────────────────────

/** The error codes: the standard five carry no data; `computer` carries a ComputerError. */
export const RPC_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  computer: -32000
} as const

export const JsonRpcVersionSchema = z.literal('2.0')

export const RpcRequestSchema = z.object({
  jsonrpc: JsonRpcVersionSchema,
  id: int().nonnegative(),
  method: z.string(),
  params: z.record(z.string(), z.json())
})

export const RpcErrorSchema = z.object({
  code: int(),
  message: z.string(),
  data: ComputerErrorSchema.optional()
})
export type RpcError = z.infer<typeof RpcErrorSchema>

export const RpcErrorResponseSchema = z.object({
  jsonrpc: JsonRpcVersionSchema,
  id: int().nullable(),
  error: RpcErrorSchema
})

/** A request frame for `method`, its params checked. */
export function requestFrameSchema<M extends ComputerMethod>(method: M) {
  const params = COMPUTER_METHODS[method].params as (typeof COMPUTER_METHODS)[M]['params']
  return z.object({ jsonrpc: JsonRpcVersionSchema, id: int().nonnegative(), method: z.literal(method), params })
}

/** A success frame answering `method`, its result checked. */
export function resultFrameSchema<M extends ComputerMethod>(method: M) {
  const result = COMPUTER_METHODS[method].result as (typeof COMPUTER_METHODS)[M]['result']
  return z.object({ jsonrpc: JsonRpcVersionSchema, id: int().nonnegative(), result })
}

/** A notification frame of either direction. */
export const NotificationFrameSchema = z.object({ jsonrpc: JsonRpcVersionSchema })

// ── fixtures, never the wire (§10) ──────────────────────────────────────

export const RawAXValueTypeSchema = z.enum(['string', 'number', 'bool', 'other'])
export const RawAXValueSchema = z.object({ type: RawAXValueTypeSchema, text: z.string() })

/** One AX element as the recorder read it; every child is kept, visible or not. */
export interface RawAXNode {
  role: string
  subrole?: string
  roleDescription?: string
  title?: string
  value?: z.infer<typeof RawAXValueSchema>
  description?: string
  help?: string
  placeholder?: string
  identifier?: string
  domIdentifier?: string
  titleElementValue?: string
  enabled?: boolean
  focused?: boolean
  selected?: boolean
  expanded?: boolean
  required?: boolean
  invalid?: boolean
  modal?: boolean
  minimized?: boolean
  /** AXElementBusy */
  busy?: boolean
  /** AXLoaded */
  loaded?: boolean
  /** listed in the parent's AXVisibleRows or AXVisibleChildren */
  visible?: boolean
  frame?: Rect
  /** raw CopyActionNames, custom ones included */
  actions?: string[]
  /** which of AXValue, AXSelectedText, AXSelectedTextRange, AXFocused, AXSelected are settable */
  settable?: string[]
  /** `[location, length]`, as AXSelectedTextRange gives it */
  selectedTextRange?: number[]
  /** equal across one app's recorded states when the recorder saw one element (CFEqual); absent in older recordings */
  id?: string
  children: RawAXNode[]
}

export const RawAXNodeSchema: z.ZodType<RawAXNode> = z.lazy(() =>
  z.object({
    role: z.string(),
    subrole: z.string().optional(),
    roleDescription: z.string().optional(),
    title: z.string().optional(),
    value: RawAXValueSchema.optional(),
    description: z.string().optional(),
    help: z.string().optional(),
    placeholder: z.string().optional(),
    identifier: z.string().optional(),
    domIdentifier: z.string().optional(),
    titleElementValue: z.string().optional(),
    enabled: z.boolean().optional(),
    focused: z.boolean().optional(),
    selected: z.boolean().optional(),
    expanded: z.boolean().optional(),
    required: z.boolean().optional(),
    invalid: z.boolean().optional(),
    modal: z.boolean().optional(),
    minimized: z.boolean().optional(),
    busy: z.boolean().optional(),
    loaded: z.boolean().optional(),
    visible: z.boolean().optional(),
    frame: RectSchema.optional(),
    actions: z.array(z.string()).optional(),
    settable: z.array(z.string()).optional(),
    selectedTextRange: z.array(int()).length(2).optional(),
    id: z.string().optional(),
    children: z.array(RawAXNodeSchema)
  })
)

export const WalkStatsSchema = z.object({
  nodes: int().nonnegative(),
  depth: int().nonnegative(),
  ms: int().nonnegative(),
  capped: z.boolean()
})

/** The recorder's dump of one window (`apps/<app>/<state>/tree.json`). */
export const RawAXTreeSchema = z.object({
  recordedAt: z.string(),
  recorder: z.string(),
  /** `bundleId` is left out for a process without one */
  app: z.object({ name: z.string(), bundleId: z.string().optional(), version: z.string() }),
  os: z.string(),
  window: z.object({ title: z.string(), frame: RectSchema }),
  /** pixels per point of the display the window is on */
  scale: z.number().positive(),
  manualAccessibility: z.enum(['set', 'refused']),
  walk: WalkStatsSchema,
  root: RawAXNodeSchema,
  /** open menus and popovers the app shows outside the window's own children */
  attached: z.array(RawAXNodeSchema).optional()
})
export type RawAXTree = z.infer<typeof RawAXTreeSchema>

/** What one recorded state is (`apps/<app>/<state>/meta.json`). */
export const FixtureMetaSchema = z.object({
  app: z.string(),
  state: z.string(),
  /** ISO 8601 */
  recordedAt: z.string(),
  /** the recorder's version */
  recorder: z.string(),
  macos: z.string(),
  backingScale: z.number().positive(),
  /** points */
  window: z.object({ title: z.string(), frame: RectSchema }),
  shot: z.object({
    file: z.literal('window.jpg'),
    /** pixels */
    width: int().positive(),
    height: int().positive(),
    bytes: int().positive(),
    maxEdge: int().positive(),
    /** pixels per point */
    scale: z.number().positive(),
    /** open popup menus of the app drawn into the shot with the window (a select's menu) */
    popups: int().positive().optional()
  }),
  walk: WalkStatsSchema,
  /** the scratch steps, in words */
  setup: z.array(z.string()),
  /** the state and action this one followed */
  after: z.object({ state: z.string(), action: z.string() }).optional(),
  appshot: z.boolean()
})
export type FixtureMeta = z.infer<typeof FixtureMetaSchema>
