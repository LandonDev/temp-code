/**
 * What the person reads of a computer call (docs/computer-protocol.md
 * "Permission and Stop"): whether it asks in `safe` and `edits`, the card's
 * title and input, and the activity line the thread's row and Activity show.
 * Reads never ask; every action that sends input does, one card per call.
 */
import { parseElementLine } from './observation'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ComputerActionName, type ElementBrief } from './protocol'
import type { ComputerToolName } from './tools'

/** A tool's own name: `mcp__app__computer_act` and `computer_act` alike, a per-verb `computer_left_click` as its verb. */
export function computerToolOf(name: string): { tool: ComputerToolName; action?: ComputerActionName } | null {
  const bare = name.replace(/^mcp__app__/, '')
  if (bare === 'computer_apps' || bare === 'computer_observe' || bare === 'computer_act' || bare === 'computer_batch')
    return { tool: bare }
  const verb = bare.startsWith('computer_') ? bare.slice('computer_'.length) : null
  if (verb && (COMPUTER_ACTION_NAMES as readonly string[]).includes(verb))
    return { tool: 'computer_act', action: verb as ComputerActionName }
  return null
}

const sendsInput = (a: { action: ComputerActionName }): boolean => !NO_INPUT_ACTIONS.includes(a.action)

type ToolArgs = { action?: ComputerActionName; actions?: { action: ComputerActionName }[] }

/** Does this call need a card in safe or edits? apps and observe never; act or batch only with an action that sends input. */
export function needsApproval(tool: ComputerToolName, args: ToolArgs): boolean {
  if (tool === 'computer_act') return args.action !== undefined && sendsInput({ action: args.action })
  if (tool === 'computer_batch') return (args.actions ?? []).some(sendsInput)
  return false
}

export interface TitleContext {
  appName: string
  /** the model's `window`, else the bound window's title; null leaves it out */
  window: string | null
  /** the thread's book: an element's line, or null when it has none */
  element: (index: number) => ElementBrief | null
}

const quoteShort = (text: string, max = 60): string => {
  const s = [...text]
  return JSON.stringify(s.length > max ? s.slice(0, max).join('') + '…' : text)
}

/** `button "Save"`, or `[14]` when the book has no line for it. */
function named(index: number | undefined, ctx: TitleContext): string | null {
  if (index === undefined) return null
  const brief = ctx.element(index)
  if (!brief) return `[${index}]`
  try {
    const e = parseElementLine(`[${brief.index}] ${brief.line}`)
    return e.name !== undefined ? `${e.role} ${JSON.stringify(e.name)}` : e.role
  } catch {
    return `[${index}]`
  }
}

/** An element by its book line, a point as `x,y`, or null for the agent cursor. */
function target(action: ComputerAction, ctx: TitleContext, start = false): string | null {
  const element = start ? action.start_element : action.element
  const point = start ? action.start_coordinate : action.coordinate
  return named(element, ctx) ?? (point ? `${point[0]},${point[1]}` : null)
}

/** Where a click or a point lands: `button "Save"`, `at 500,300`, `at the cursor`. */
function landing(action: ComputerAction, ctx: TitleContext): string {
  return named(action.element, ctx) ?? (action.coordinate ? `at ${action.coordinate[0]},${action.coordinate[1]}` : 'at the cursor')
}

const CLICK_VERBS: Partial<Record<ComputerActionName, string>> = {
  left_click: 'click',
  right_click: 'right-click',
  middle_click: 'middle-click',
  double_click: 'double-click',
  triple_click: 'triple-click'
}

/** One acting step in words, lower-case: `click button "Save"`, `type "Lunch?" into input "Subject"`. */
export function actionWords(action: ComputerAction, ctx: TitleContext): string {
  const at = target(action, ctx)
  const mods = (s: string): string => (action.text ? `${s} with ${action.text}` : s)
  const click = CLICK_VERBS[action.action]
  if (click) return mods(`${click} ${landing(action, ctx)}`)
  switch (action.action) {
    case 'left_click_drag':
      return mods(`drag ${target(action, ctx, true) ?? 'from the cursor'} to ${at ?? 'the cursor'}`)
    case 'mouse_move': {
      const to = landing(action, ctx)
      return to.startsWith('at ') ? `point ${to}` : `point at ${to}`
    }
    case 'left_mouse_down':
      return 'press the mouse button'
    case 'left_mouse_up':
      return 'let go of the mouse button'
    case 'scroll':
      return mods(`scroll ${action.scroll_direction} ${action.scroll_amount}${at ? ` on ${at}` : ''}`)
    case 'type':
      return `type ${quoteShort(action.text ?? '')}${at ? ` into ${at}` : ''}`
    case 'paste':
      return `paste ${quoteShort(action.text ?? '')}${at ? ` into ${at}` : ''}`
    case 'key':
      return `press ${action.text}${action.repeat && action.repeat > 1 ? ` ${action.repeat} times` : ''}`
    case 'hold_key':
      return `hold ${action.text} for ${action.duration} s`
    case 'set_value':
      return `set ${at} to ${quoteShort(action.value ?? '')}`
    case 'select_text':
      return `select ${action.text !== undefined ? quoteShort(action.text) : `${action.range?.[0]}..${action.range?.[1]}`} in ${at}`
    case 'perform':
      return `${action.name} ${at}`
    case 'screenshot':
      return 'look at the window'
    case 'zoom':
      return 'zoom in'
    case 'cursor_position':
      return 'read the cursor'
    case 'wait':
      return `wait up to ${action.duration} s`
    default:
      return action.action
  }
}

const where = (ctx: TitleContext): string => `${ctx.appName}${ctx.window ? `, window ${JSON.stringify(ctx.window)}` : ''}`
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function actingSteps(tool: ComputerToolName, args: ToolArgs): ComputerAction[] {
  if (tool === 'computer_act') return args.action && sendsInput({ action: args.action }) ? [args as ComputerAction] : []
  if (tool === 'computer_batch') return ((args.actions ?? []) as ComputerAction[]).filter(sendsInput)
  return []
}

/**
 * The card's title (the card's row, the notifier and the away row read it):
 * `Click button "Save" in TextEdit, window "Untitled"`, a batch
 * `3 actions in Mail, window "New Message": click button "To", type "Lunch?", press super+Return`.
 * A batch's reads are left out.
 */
export function computerApprovalTitle(tool: ComputerToolName, args: ToolArgs, ctx: TitleContext): string {
  const steps = actingSteps(tool, args).map((a) => actionWords(a, ctx))
  if (steps.length === 1) return `${capital(steps[0])} in ${where(ctx)}`
  return `${steps.length} actions in ${where(ctx)}: ${steps.join(', ')}`
}

/** The card's input, for the preview thread's card: the app, the window and each acting step in words. */
export function computerApprovalInput(tool: ComputerToolName, args: ToolArgs, ctx: TitleContext): { app: string; window: string | null; actions: string[] } {
  return { app: ctx.appName, window: ctx.window, actions: actingSteps(tool, args).map((a) => actionWords(a, ctx)) }
}

const ACTIVITY: Partial<Record<ComputerActionName, string>> = {
  left_click: 'Clicking in',
  right_click: 'Clicking in',
  middle_click: 'Clicking in',
  double_click: 'Clicking in',
  triple_click: 'Clicking in',
  left_mouse_down: 'Clicking in',
  left_mouse_up: 'Clicking in',
  left_click_drag: 'Dragging in',
  mouse_move: 'Pointing in',
  scroll: 'Scrolling in',
  type: 'Typing in',
  paste: 'Pasting in',
  key: 'Pressing keys in',
  hold_key: 'Pressing keys in',
  set_value: 'Setting a value in',
  select_text: 'Selecting text in',
  perform: 'Using',
  screenshot: 'Looking at',
  zoom: 'Looking at',
  cursor_position: 'Looking at',
  wait: 'Waiting on'
}

/** The activity line describeTool shows for a computer tool, or null for any other tool. */
export function computerActivity(name: string, input: unknown): { text: string; kind: 'investigate' | 'edit' } | null {
  const of = computerToolOf(name)
  if (!of) return null
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const app = typeof i.app === 'string' && i.app.trim() ? i.app.trim() : 'an app'
  if (of.tool === 'computer_apps') return { text: 'Listing apps', kind: 'investigate' }
  if (of.tool === 'computer_observe') return { text: `Reading ${app}`, kind: 'investigate' }
  if (of.tool === 'computer_batch') {
    const actions = Array.isArray(i.actions) ? (i.actions as { action?: ComputerActionName }[]) : []
    const acts = actions.some((a) => a && typeof a.action === 'string' && sendsInput({ action: a.action }))
    return { text: `Working in ${app}`, kind: acts ? 'edit' : 'investigate' }
  }
  const action = of.action ?? (typeof i.action === 'string' ? (i.action as ComputerActionName) : undefined)
  const verb = action ? ACTIVITY[action] : undefined
  if (!action || !verb) return { text: `Using ${app}`, kind: 'edit' }
  return { text: `${verb} ${app}`, kind: sendsInput({ action }) ? 'edit' : 'investigate' }
}
