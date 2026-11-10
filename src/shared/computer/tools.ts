/**
 * What the models see of computer use (docs/computer-protocol.md §9): four
 * tools on the app MCP server, the same on every harness. The verbs and
 * their parameter names inside `computer_act` and `computer_batch` are
 * Anthropic's native computer-use set, with `element` beside `coordinate`.
 * TypeScript only; never generated. The words are descriptions.ts's, in
 * two shapes; the schemas here carry them.
 */
import { z } from 'zod'
import { PermissionPolicySchema } from '../events'
import { fieldWords, perVerbDescription, toolDescription, type FieldKey, type ToolShape, type WordsShape } from './descriptions'
import { parseElementLine, parseKeyCombo } from './observation'
import { ConfirmSchema } from './policy'
import {
  ACTION_PARAMS,
  ActionClassSchema,
  COMPUTER_ACTION_NAMES,
  COMPUTER_ACTION_SHAPE,
  ElementIndexSchema,
  NO_INPUT_ACTIONS,
  SERVICE,
  TierSchema,
  refineAction,
  type ActionClass,
  type ActionParam,
  type ComputerAction,
  type ComputerActionName,
  type ElementBrief,
  type InputVia,
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

/**
 * Whether a step may have a route at `ax` (docs/computer-protocol.md §24.1): a `key` holding
 * Command or Control (its menu item), a plain `left_click`, `right_click` or `double_click`
 * (the element or the hit under it), a plain `scroll` (the bar or the page), a `paste` and a
 * `type` (the AX insert). Under a `session` verdict the host tries these at `ax` before the gate.
 */
export function mayRunAtAx(a: ComputerAction): boolean {
  switch (a.action) {
    case 'key':
      try {
        const { modifiers } = parseKeyCombo(a.text ?? '')
        return modifiers.includes('super') || modifiers.includes('ctrl')
      } catch {
        return false
      }
    case 'left_click':
    case 'right_click':
    case 'double_click':
      return !a.text && a.duration === undefined
    case 'scroll':
      return !a.text
    case 'paste':
    case 'type':
      return true
    default:
      return false
  }
}

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

export const COMPUTER_TOOL_NAMES = ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'] as const
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number]

/** Actions in one `computer_batch` call. */
export const TOOL_BATCH_MAX_ACTIONS = 20

type FieldText = Readonly<Record<FieldKey, string>>

/** The wire's action fields, each described in one word shape; optional as the wire has them. */
function describedActionShape(w: FieldText): typeof COMPUTER_ACTION_SHAPE {
  return Object.fromEntries(
    Object.entries(COMPUTER_ACTION_SHAPE).map(([k, s]) => [k, (s as z.ZodType).describe(w[k as FieldKey])])
  ) as typeof COMPUTER_ACTION_SHAPE
}

/** `open` goes into the app `launch` names; `confirm` flags an open, never a bare launch. */
function refineApps(v: { launch?: string; open?: string[]; confirm?: unknown }, ctx: z.RefinementCtx): void {
  if (v.open && !v.launch) ctx.addIssue({ code: 'custom', path: ['open'], message: 'open needs launch, the app to open it in' })
  if (v.confirm && !v.open) ctx.addIssue({ code: 'custom', path: ['confirm'], message: 'confirm goes with open' })
}

/** The four tools' inputs with one word shape's field descriptions; the rules are the same in every shape. */
function toolInputs(w: FieldText) {
  const target = {
    app: z.string().min(1).describe(w.app),
    window: z.string().min(1).optional().describe(w.window),
    screenshot: z.boolean().optional().describe(w.screenshot)
  }
  const actionShape = describedActionShape(w)
  const confirm = (text: string) =>
    z
      .object({ kind: ConfirmSchema.shape.kind.describe(w['confirm.kind']), what: ConfirmSchema.shape.what.describe(w['confirm.what']) })
      .optional()
      .describe(text)
  return {
    apps: z
      .object({
        launch: z.string().min(1).optional().describe(w.launch),
        open: z.array(z.string().min(1)).min(1).max(SERVICE.openItemsMax).optional().describe(w.open),
        // the kinds are explained on computer_act's confirm; the list pays for each copy on every turn
        confirm: z
          .object({ kind: ConfirmSchema.shape.kind.describe(w['apps.confirm.kind']), what: ConfirmSchema.shape.what.describe(w['confirm.what']) })
          .optional()
          .describe(w['apps.confirm'])
      })
      .superRefine(refineApps),
    observe: z.object({
      app: target.app,
      window: target.window,
      full: z.boolean().optional().describe(w.full),
      element: ElementIndexSchema.optional().describe(w['observe.element']),
      screenshot: target.screenshot,
      menus: z.boolean().optional().describe(w.menus)
    }),
    /** The action's own fields beside the target's: one flat object, no `oneOf`. */
    act: z.object({ ...target, ...actionShape, confirm: confirm(w.confirm) }).superRefine(refineAction),
    batch: z.object({
      ...target,
      actions: z.array(z.object(actionShape).superRefine(refineAction)).min(1).max(TOOL_BATCH_MAX_ACTIONS).describe(w.actions),
      confirm: confirm(w['batch.confirm'])
    }),
    target,
    confirm: confirm(w.confirm)
  }
}

const INPUTS = { anthropic: toolInputs(fieldWords('anthropic')), cua: toolInputs(fieldWords('cua')) } as const

export const ComputerAppsInputSchema = INPUTS.anthropic.apps
export const ComputerObserveInputSchema = INPUTS.anthropic.observe
export const ComputerActInputSchema = INPUTS.anthropic.act
export const ComputerBatchInputSchema = INPUTS.anthropic.batch

export type ComputerAppsInput = z.infer<typeof ComputerAppsInputSchema>
export type ComputerObserveInput = z.infer<typeof ComputerObserveInputSchema>
export type ComputerActInput = z.infer<typeof ComputerActInputSchema>
export type ComputerBatchInput = z.infer<typeof ComputerBatchInputSchema>

/** After each tool's description on a thread whose calls cross the Mac bridge (computer/bridge.ts). */
export const COMPUTER_BRIDGE_NOTE = " These act on the user's Mac, where the apps run; this thread runs on another host."

export { COMPUTER_SEARCH_HINT, type ToolShape, type WordsShape } from './descriptions'

/** The anthropic shape's four descriptions. */
export const COMPUTER_TOOL_DESCRIPTIONS: Readonly<Record<ComputerToolName, string>> = Object.fromEntries(
  COMPUTER_TOOL_NAMES.map((n) => [n, toolDescription('anthropic', 'act', n)])
) as Record<ComputerToolName, string>

export interface ComputerToolSpec {
  name: string
  description: string
  input: z.ZodType
}

const specs = new Map<string, readonly ComputerToolSpec[]>()

/**
 * The tools a thread gets, in its word shape: the four, or with `per-verb`
 * computer_apps, computer_observe, computer_batch and one tool per action in
 * computer_act's place.
 */
export function computerToolSpecs(shape: WordsShape = 'anthropic', tools: ToolShape = 'act'): readonly ComputerToolSpec[] {
  const key = `${shape}/${tools}`
  const kept = specs.get(key)
  if (kept) return kept
  const i = INPUTS[shape]
  const d = (n: ComputerToolName): string => toolDescription(shape, tools, n)
  const apps = { name: 'computer_apps', description: d('computer_apps'), input: i.apps }
  const observe = { name: 'computer_observe', description: d('computer_observe'), input: i.observe }
  const batch = { name: 'computer_batch', description: d('computer_batch'), input: i.batch }
  const made = Object.freeze(
    tools === 'act'
      ? [apps, observe, { name: 'computer_act', description: d('computer_act'), input: i.act }, batch]
      : [apps, observe, batch, ...perVerbTools(shape)]
  )
  specs.set(key, made)
  return made
}

export const COMPUTER_TOOLS: readonly ComputerToolSpec[] = computerToolSpecs('anthropic', 'act')

/** zod writes these bounds on every integer; they say nothing to a model and cost every Mac thread its tokens. */
function dropSafeBounds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(dropSafeBounds)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) {
    if ((k === 'minimum' && v === Number.MIN_SAFE_INTEGER) || (k === 'maximum' && v === Number.MAX_SAFE_INTEGER)) continue
    out[k] = dropSafeBounds(v)
  }
  return out
}

/** A tool's input as the JSON Schema an MCP `tools/list` carries (the bridge's `inputSchema`). */
export function computerToolJsonSchema(input: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(input, { io: 'input' }) as Record<string, unknown>
  return dropSafeBounds(schema) as Record<string, unknown>
}

/**
 * The one-tool-per-verb variant (§9): `computer_left_click`, `computer_type`, …,
 * each with `app`, `window`, `screenshot` and that verb's own parameters,
 * required ones required, and `confirm` on every action that sends input.
 * The host runs each as computer_act with its action.
 */
export function perVerbTools(shape: WordsShape = 'anthropic'): ComputerToolSpec[] {
  const w = fieldWords(shape)
  const { target, confirm } = INPUTS[shape]
  return COMPUTER_ACTION_NAMES.map((action) => {
    const { required, optional } = ACTION_PARAMS[action]
    const fields: Record<string, z.ZodType> = { ...target }
    for (const p of optional) fields[p] = COMPUTER_ACTION_SHAPE[p].describe(w[p])
    for (const p of required) fields[p] = (COMPUTER_ACTION_SHAPE[p] as z.ZodOptional<z.ZodType>).unwrap().describe(w[p])
    if (!NO_INPUT_ACTIONS.includes(action)) fields.confirm = confirm
    const input = z
      .object(fields)
      .superRefine((v, ctx) => refineAction({ ...(v as Partial<Record<ActionParam, unknown>>), action }, ctx))
    return { name: `computer_${action}`, description: perVerbDescription(shape, action), input }
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
  /**
   * Steps in a row with effect 'none' on a learned fallback route (LEARNED_VIAS, §24.1); at
   * VERDICT_MISSES_TO_RAISE the host names the route in `ignored`, so the service runs it last.
   */
  viaMisses: z
    .object({
      hit: z.number().int().nonnegative().optional(),
      caret: z.number().int().nonnegative().optional(),
      'scroll-page': z.number().int().nonnegative().optional()
    })
    .optional(),
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
    parts.push(howWords(action, step))
    parts.push(EFFECT_WORDS[step.effect])
  }
  return parts.join(STEP_SEPARATOR)
}

/** The background routes (§24.8): the line names them with what they acted on, `menu File › Close`. */
export const FALLBACK_VIAS: readonly InputVia[] = ['menu', 'hit', 'caret', 'scroll-bar', 'scroll-page']

/** How a step went in: a fallback route and what it acted on, `type`'s way, else the tier. A paste that went by the clipboard names its tier. */
function howWords(action: ComputerAction, step: Extract<StepResult, { status: 'ok' }>): string {
  const via = step.input?.via
  if (via && FALLBACK_VIAS.includes(via)) {
    // the separator never appears inside the part, so the line reads back
    const on = step.input?.on?.split(STEP_SEPARATOR).join(' ')
    return on ? `${via} ${on}` : via
  }
  if (action.action === 'paste') return via === 'ax-insert' ? via : (step.tier ?? 'no tier')
  return via ?? step.tier ?? 'no tier'
}

/** `screenshot 1 (step 2): <path> (1280×800)`, or `(observation)`; ` (not attached)` past MAX_IMAGE_PARTS. */
export function formatShotLine(n: number, where: number | 'observation', shot: { path: string; width: number; height: number }, attached: boolean): string {
  const source = where === 'observation' ? 'observation' : `step ${where}`
  return `screenshot ${n} (${source}): ${shot.path} (${shot.width}×${shot.height})${attached ? '' : NOT_ATTACHED}`
}

export interface ShotLine {
  n: number
  from: { step: number } | 'observation'
  path: string
  width: number
  height: number
  attached: boolean
}

const SHOT_LINE = /^screenshot ([1-9]\d*) \((observation|step ([1-9]\d*))\): (.+) \(([1-9]\d*)×([1-9]\d*)\)( \(not attached\))?$/

/** One `formatShotLine` line back to its parts; null for any other line. */
export function parseShotLine(line: string): ShotLine | null {
  const m = SHOT_LINE.exec(line)
  if (!m) return null
  return {
    n: Number(m[1]),
    from: m[3] === undefined ? 'observation' : { step: Number(m[3]) },
    path: m[4],
    width: Number(m[5]),
    height: Number(m[6]),
    attached: m[7] === undefined
  }
}

export interface StepLine {
  action: ComputerActionName
  /** what the step acted on, as its line wrote it (`[14] button "Save"`, `down 3 on [5]`); empty for a step with none */
  target: string
  /** the element the line names with its role (a bare `[14]` the service had no line for is left out) */
  element?: { index: number; role: string; name: string | null }
  /** the tier, or for a `type` the way it went in: `ax`, `ax-insert`, `no tier` */
  tier?: string
  effect?: StepEffect
  /** a failed step's reason */
  failed?: string
}

const ROLE_STOP = /^(?:with|to|into|on|in)\b/
const NO_TARGET: readonly ComputerActionName[] = ['screenshot', 'cursor_position', 'left_mouse_down', 'left_mouse_up']

/** Where the head of a step line ends: the first separator outside a quoted name or value. */
function headEnd(line: string): number {
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (line.startsWith(STEP_SEPARATOR, i)) return i
  }
  return line.length
}

/** The first `[n] role "name"` in a target, outside quotes. */
function targetElement(target: string): StepLine['element'] {
  let quoted = false
  for (let i = 0; i < target.length; i++) {
    const c = target[i]
    if (quoted) {
      if (c === '\\') i++
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') {
      quoted = true
      continue
    }
    const m = c === '[' ? /^\[([1-9]\d*)\]/.exec(target.slice(i)) : null
    if (!m) continue
    const rest = target.slice(i + m[0].length)
    const role = /^ ([a-z][a-z0-9:-]*(?: [a-z][a-z0-9:-]*)*?)(?= "| with | to |$)/.exec(rest)
    if (!role || ROLE_STOP.test(role[1])) return undefined
    const after = rest.slice(role[0].length)
    const name = /^ ("(?:[^"\\]|\\.)*")/.exec(after)
    return { index: Number(m[1]), role: role[1], name: name ? (JSON.parse(name[1]) as string) : null }
  }
  return undefined
}

const EFFECT_OF: Readonly<Record<string, StepEffect>> = Object.fromEntries(Object.entries(EFFECT_WORDS).map(([k, v]) => [v, k as StepEffect]))

/** One `formatStepLine` line back to its parts; null for any other line (a `Not executed` line, a shot line, the body). */
export function parseStepLine(line: string): StepLine | null {
  const end = headEnd(line)
  const head = line.slice(0, end)
  const space = head.indexOf(' ')
  const action = space < 0 ? head : head.slice(0, space)
  if (!(COMPUTER_ACTION_NAMES as readonly string[]).includes(action)) return null
  const name = action as ComputerActionName
  const target = space < 0 ? '' : head.slice(space + 1)
  // these name nothing (stepTarget), so a `screenshot 1 (observation): …` line is a shot line
  if (target && NO_TARGET.includes(name)) return null
  const out: StepLine = { action: name, target }
  const element = targetElement(target)
  if (element) out.element = element
  if (end === line.length) return out
  const rest = line.slice(end + STEP_SEPARATOR.length)
  if (rest.startsWith('failed: ')) return { ...out, failed: rest.slice('failed: '.length) }
  if (NO_INPUT_ACTIONS.includes(name)) return out
  const [tier, effect, ...extra] = rest.split(STEP_SEPARATOR)
  if (!tier || extra.length || (effect !== undefined && !EFFECT_OF[effect])) return null
  return { ...out, tier, ...(effect !== undefined ? { effect: EFFECT_OF[effect] } : {}) }
}

/**
 * The text that leads a computer call's pictures when codex gets them as a
 * steer into its running turn (drivers/codex.ts). Worded here first; the
 * Computer model instructions thread owns it from now on.
 */
export const COMPUTER_PICTURES_TEXT = 'The screenshots your last computer call took, in the order its screenshot lines name them.'
