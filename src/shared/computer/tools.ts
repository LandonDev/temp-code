/**
 * What the models see of computer use (docs/computer-protocol.md §9): four
 * tools on the app MCP server, the same on every harness. The verbs and
 * their parameter names inside `computer_act` and `computer_batch` are
 * Anthropic's native computer-use set, with `element` beside `coordinate`.
 * TypeScript only; never generated. Every description here is a one-line
 * placeholder: the Computer model instructions thread owns the wording.
 */
import { z } from 'zod'
import { PermissionPolicySchema } from '../events'
import { parseElementLine } from './observation'
import {
  ACTION_PARAMS,
  ActionClassSchema,
  COMPUTER_ACTION_NAMES,
  COMPUTER_ACTION_SHAPE,
  ComputerActionSchema,
  ElementIndexSchema,
  NO_INPUT_ACTIONS,
  TierSchema,
  refineAction,
  type ActionClass,
  type ActionParam,
  type ComputerAction,
  type ComputerActionName,
  type ElementBrief,
  type StepEffect,
  type StepResult,
  type Tier,
  type WaitReport
} from './protocol'

// ── the action table ────────────────────────────────────────────────────

/** What the tier verdict learns per app (§5.2); the wire's ActionClassSchema. */
export const ACTION_CLASSES = ActionClassSchema.options
export { ActionClassSchema, type ActionClass }

export interface ComputerActionSpec {
  params: (typeof ACTION_PARAMS)[ComputerActionName]
  /** the verdict class, or null for an action that sends no input or runs on AX alone */
  class: ActionClass | null
  /** one of Anthropic's 17 native members */
  native: boolean
  /** sends no input: its step's tier is null, and a batch waits nothing after it */
  noInput: boolean
  /** runs on the `ax` tier only */
  axOnly: boolean
}

const CLASS_OF: Partial<Record<ComputerActionName, ActionClass>> = {
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  left_mouse_down: 'click',
  left_mouse_up: 'click',
  left_click_drag: 'drag',
  mouse_move: 'hover',
  scroll: 'scroll',
  key: 'key',
  hold_key: 'key',
  type: 'type',
  paste: 'type'
}
const AX_ONLY: readonly ComputerActionName[] = ['set_value', 'perform', 'select_text']

/** Every action with its parameters and its class; `computer_act` and the per-verb set are both built from it. */
export const COMPUTER_ACTIONS: Readonly<Record<ComputerActionName, ComputerActionSpec>> = Object.fromEntries(
  COMPUTER_ACTION_NAMES.map((name, i) => [
    name,
    {
      params: ACTION_PARAMS[name],
      class: CLASS_OF[name] ?? null,
      native: i < 17,
      noInput: NO_INPUT_ACTIONS.includes(name),
      axOnly: AX_ONLY.includes(name)
    }
  ])
) as Record<ComputerActionName, ComputerActionSpec>

// ── the four tools ──────────────────────────────────────────────────────

/** A name or bundle id; an installed app that is not running is launched in the background. */
const AppField = z.string().min(1).describe('The app: its name or bundle id.')
const WindowField = z.string().min(1).optional().describe("A window's title or part of it; the main window when left out.")
const ScreenshotField = z.boolean().optional().describe('Attach a screenshot to the observation.')

export const COMPUTER_TOOL_NAMES = ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/** Actions in one `computer_batch` call. */
export const TOOL_BATCH_MAX_ACTIONS = 20

export const ComputerAppsInputSchema = z.object({
  launch: z.string().min(1).optional().describe('Start this app in the background first.')
})

export const ComputerObserveInputSchema = z.object({
  app: AppField,
  window: WindowField,
  full: z.boolean().optional().describe('The whole tree, never a diff.'),
  element: ElementIndexSchema.optional().describe("One element's subtree, whole."),
  screenshot: ScreenshotField,
  menus: z.boolean().optional().describe('Include the menu bar.')
})

/** The action's own fields beside the target's: one flat object, no `oneOf`. */
export const ComputerActInputSchema = z
  .object({ app: AppField, window: WindowField, screenshot: ScreenshotField, ...COMPUTER_ACTION_SHAPE })
  .superRefine(refineAction)

export const ComputerBatchInputSchema = z.object({
  app: AppField,
  window: WindowField,
  screenshot: ScreenshotField,
  actions: z.array(ComputerActionSchema).min(1).max(TOOL_BATCH_MAX_ACTIONS).describe('The actions, run in order.')
})

export type ComputerAppsInput = z.infer<typeof ComputerAppsInputSchema>
export type ComputerObserveInput = z.infer<typeof ComputerObserveInputSchema>
export type ComputerActInput = z.infer<typeof ComputerActInputSchema>
export type ComputerBatchInput = z.infer<typeof ComputerBatchInputSchema>

/**
 * What tool search matches the four deferred tools by on Claude (the SDK's
 * `searchHint`); a placeholder Computer model instructions replaces.
 */
export const COMPUTER_SEARCH_HINT =
  'computer use: read, click, type into and scroll the windows of Mac apps (TextEdit, Mail, Finder, a browser) through their accessibility tree; screenshots'

/** One-line placeholders; Computer model instructions replaces them. */
export const COMPUTER_TOOL_DESCRIPTIONS: Readonly<Record<ComputerToolName, string>> = {
  computer_apps: 'List the running apps and their windows.',
  computer_observe: "Read a window's accessibility tree as indexed text.",
  computer_act: 'Do one action in an app window, then read the window again.',
  computer_batch: 'Do several actions in order in one app window, then read it once.'
}

export interface ComputerToolSpec {
  name: string
  description: string
  input: z.ZodType
}

export const COMPUTER_TOOLS: readonly ComputerToolSpec[] = [
  { name: 'computer_apps', description: COMPUTER_TOOL_DESCRIPTIONS.computer_apps, input: ComputerAppsInputSchema },
  { name: 'computer_observe', description: COMPUTER_TOOL_DESCRIPTIONS.computer_observe, input: ComputerObserveInputSchema },
  { name: 'computer_act', description: COMPUTER_TOOL_DESCRIPTIONS.computer_act, input: ComputerActInputSchema },
  { name: 'computer_batch', description: COMPUTER_TOOL_DESCRIPTIONS.computer_batch, input: ComputerBatchInputSchema }
]

/** A tool's input as the JSON Schema an MCP `tools/list` carries (the bridge's `inputSchema`). */
export function computerToolJsonSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
  return schema
}

/**
 * The one-tool-per-verb variant (§9): `computer_left_click`, `computer_type`, …,
 * each with `app`, `window`, `screenshot` and that verb's own parameters,
 * required ones required. Computer model instructions may measure it for
 * Claude against `computer_act` and `computer_batch` and keep the faster.
 */
export function perVerbTools(): ComputerToolSpec[] {
  return COMPUTER_ACTION_NAMES.map((action) => {
    const { required, optional } = ACTION_PARAMS[action]
    const shape: Record<string, z.ZodType> = { app: AppField, window: WindowField, screenshot: ScreenshotField }
    for (const p of optional) shape[p] = COMPUTER_ACTION_SHAPE[p]
    for (const p of required) shape[p] = (COMPUTER_ACTION_SHAPE[p] as z.ZodOptional<z.ZodType>).unwrap()
    const input = z
      .object(shape)
      .superRefine((v, ctx) => refineAction({ ...(v as Partial<Record<ActionParam, unknown>>), action }, ctx))
    return { name: `computer_${action}`, description: `The ${action} action.`, input }
  })
}

// ── the peer payloads (the Bridge path) ─────────────────────────────────

const toolCall = <T extends ComputerToolName, S extends z.ZodType>(tool: T, args: S) =>
  z.object({ tool: z.literal(tool), args, threadId: z.string().min(1), permission: PermissionPolicySchema })

/** A box thread's tool call crossing the Mac bridge. */
export const ComputerToolCallSchema = z.discriminatedUnion('tool', [
  toolCall('computer_apps', ComputerAppsInputSchema),
  toolCall('computer_observe', ComputerObserveInputSchema),
  toolCall('computer_act', ComputerActInputSchema),
  toolCall('computer_batch', ComputerBatchInputSchema)
])
export type ComputerToolCall = z.infer<typeof ComputerToolCallSchema>

/** What comes back: the text without its `screenshot` lines, and the pictures, which the box writes under the thread's attachment dir. */
export const ComputerToolResultSchema = z.object({
  text: z.string(),
  images: z.array(
    z.object({
      /** `step 2` or `observation` */
      label: z.string(),
      /** base64 */
      data: z.string(),
      mimeType: z.string(),
      width: z.number().int().positive(),
      height: z.number().int().positive()
    })
  )
})
export type ComputerToolResult = z.infer<typeof ComputerToolResultSchema>

// ── the tier verdict (§5.2) ─────────────────────────────────────────────

/** Per app: the lowest tier that worked for each class. */
export const TierVerdictSchema = z.object({
  bundleId: z.string().min(1),
  classes: z.object({
    click: TierSchema.optional(),
    drag: TierSchema.optional(),
    hover: TierSchema.optional(),
    scroll: TierSchema.optional(),
    key: TierSchema.optional(),
    type: TierSchema.optional()
  }),
  /** steps in a row with effect 'none' at the class's current tier */
  misses: z.object({
    click: z.number().int().nonnegative().optional(),
    drag: z.number().int().nonnegative().optional(),
    hover: z.number().int().nonnegative().optional(),
    scroll: z.number().int().nonnegative().optional(),
    key: z.number().int().nonnegative().optional(),
    type: z.number().int().nonnegative().optional()
  }),
  /**
   * This app's background windows have been seen not key: a process-tier keys
   * step answered `key_window_unavailable`, or a probe found the key window
   * elsewhere. A record, not a ban: the host keeps `process` and retries such
   * a step at the next tier.
   */
  needsKeyWindow: z.boolean().optional(),
  /** when the host last ran `input.probe` on this app, epoch ms: a probe runs once per app */
  probedAt: z.number().int().optional(),
  /** epoch ms */
  updatedAt: z.number().int()
})
export type TierVerdict = z.infer<typeof TierVerdictSchema>

/** The tier a class with no verdict starts at. */
export const DEFAULT_TIER: Tier = 'process'
/** `effect: 'none'` this many times in a row at a class's tier, then `changed` at `session`, raises the verdict. */
export const VERDICT_MISSES_TO_RAISE = 2
/** Where the host keeps an app's verdict. */
export const tierVerdictSetting = (bundleId: string): string => `computer.tiers.${bundleId}`

// ── the result text (§9) ────────────────────────────────────────────────

export const STEP_SEPARATOR = ' · '
export const EFFECT_WORDS: Readonly<Record<StepEffect, string>> = {
  changed: 'changed',
  none: 'no change seen',
  unknown: "can't tell"
}
/** Anthropic's own sentence, with "batch" for "turn". */
export const NOT_EXECUTED_LINE = 'Not executed: an earlier action in this batch failed.'
export const OBSERVATION_FAILED_PREFIX = 'observation failed: '
/** Image parts in one result; past it the lines still name the files. */
export const MAX_IMAGE_PARTS = 4
export const NOT_ATTACHED = ' (not attached)'

const quoteShort = (text: string, max = 60): string => {
  const s = [...text]
  return JSON.stringify(s.length > max ? s.slice(0, max).join('') + '…' : text)
}
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`

/** `[14] button "Save"`: an element as a step line names it, its role and name alone. */
export function briefTarget(brief: ElementBrief): string {
  try {
    const e = parseElementLine(`[${brief.index}] ${brief.line}`)
    return `[${e.index}] ${e.role}${e.name !== undefined ? ` ${JSON.stringify(e.name)}` : ''}`
  } catch {
    return `[${brief.index}]`
  }
}

/** What a step acted on, in the words of its step line. */
export function stepTarget(action: ComputerAction, brief?: ElementBrief): string {
  const el = (i: number | undefined): string | null =>
    i === undefined ? null : brief && brief.index === i ? briefTarget(brief) : `[${i}]`
  const point = (p: number[] | undefined): string | null => (p ? `${p[0]},${p[1]}` : null)
  const at = el(action.element) ?? point(action.coordinate)
  const textIsNotMods: readonly ComputerActionName[] = ['type', 'key', 'hold_key', 'select_text', 'paste']
  const mods = action.text && !textIsNotMods.includes(action.action)
  const withMods = (s: string): string => (mods ? `${s} with ${action.text}` : s)
  switch (action.action) {
    case 'screenshot':
    case 'cursor_position':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return ''
    case 'zoom': {
      const r = action.region!
      return `${r[0]},${r[1]} to ${r[2]},${r[3]}`
    }
    case 'left_click':
    case 'right_click':
    case 'middle_click':
    case 'double_click':
    case 'triple_click':
    case 'mouse_move':
      return withMods(at ?? 'at the cursor')
    case 'left_click_drag':
      return withMods(`${el(action.start_element) ?? point(action.start_coordinate)} to ${at}`)
    case 'scroll':
      return withMods(`${action.scroll_direction} ${action.scroll_amount}${at ? ` on ${at}` : ''}`)
    case 'type':
      return `${quoteShort(action.text!)}${at ? ` into ${at}` : ''}`
    case 'key':
      return `${action.text}${action.repeat && action.repeat > 1 ? ` ×${action.repeat}` : ''}`
    case 'hold_key':
      return `${action.text} for ${action.duration} s`
    case 'wait':
      return `up to ${action.duration} s`
    case 'set_value':
      return `${at} to ${quoteShort(action.value!)}`
    case 'perform':
      return `${action.name} on ${at}`
    case 'select_text':
      return `${action.text !== undefined ? quoteShort(action.text) : `${action.range![0]}..${action.range![1]}`} in ${at}`
    case 'paste':
      return `${action.format ?? 'text'}${at ? ` into ${at}` : ''}`
  }
}

function waitWords(w: WaitReport | undefined): string | null {
  if (!w) return null
  return w.settled ? `settled after ${seconds(w.waitedMs)}` : `still changing after ${seconds(w.waitedMs)}`
}

/**
 * One step line: the verb and its target, then the tier (for `type` the way
 * it went in), then what the service saw. A failed step says why; a step
 * after it says Anthropic's sentence.
 */
export function formatStepLine(step: StepResult, action: ComputerAction): string {
  if (step.status === 'not-run') return NOT_EXECUTED_LINE
  const head = [action.action, stepTarget(action, step.status === 'ok' ? step.element : undefined)].filter(Boolean).join(' ')
  if (step.status === 'failed') return `${head}${STEP_SEPARATOR}failed: ${step.error.message}`
  const parts = [head]
  if (action.action === 'cursor_position' && step.text) parts.push(step.text)
  else if (action.action === 'wait') {
    const w = waitWords(step.waited)
    if (w) parts.push(w)
  } else if (!NO_INPUT_ACTIONS.includes(action.action)) {
    // a paste always goes in by paste: its line names the tier instead
    parts.push((action.action === 'paste' ? null : step.input?.via) ?? step.tier ?? 'no tier')
    parts.push(EFFECT_WORDS[step.effect])
  }
  return parts.join(STEP_SEPARATOR)
}

/** `screenshot 1 (step 2): <path> (1280×800)`, or `(observation)`; ` (not attached)` past MAX_IMAGE_PARTS. */
export function formatShotLine(n: number, where: number | 'observation', shot: { path: string; width: number; height: number }, attached: boolean): string {
  const source = where === 'observation' ? 'observation' : `step ${where}`
  return `screenshot ${n} (${source}): ${shot.path} (${shot.width}×${shot.height})${attached ? '' : NOT_ATTACHED}`
}
