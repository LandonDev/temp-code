/**
 * What the person reads of a computer call (docs/computer-protocol.md
 * "Permission and Stop"): whether it asks in `safe` and `edits`, the card's
 * title and input, and the activity line the thread's row and Activity show.
 * Reads never ask; every action that sends input does, one card per call.
 */
import type { PermissionPolicy } from '../events'
import { parseElementLine } from './observation'
import { confirmInput, confirmTitle, type Confirm, type ConfirmNeed, type HostConfirmKind } from './policy'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ComputerActionName, type ElementBrief } from './protocol'
import { parseStepLine, type ComputerToolName } from './tools'

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

/** A call as one of the four tools: a per-verb call becomes computer_act with its action, every other field (confirm too) kept. */
export function asFourTool(name: string, args: unknown): { tool: ComputerToolName; args: Record<string, unknown> } | null {
  const of = computerToolOf(name)
  if (!of) return null
  const raw = args && typeof args === 'object' ? { ...(args as Record<string, unknown>) } : {}
  return { tool: of.tool, args: of.action ? { ...raw, action: of.action } : raw }
}

const sendsInput = (a: { action: ComputerActionName }): boolean => !NO_INPUT_ACTIONS.includes(a.action)

type ToolArgs = { action?: ComputerActionName; actions?: { action: ComputerActionName }[]; confirm?: Confirm; launch?: string; open?: string[] }

/** What a card or a line calls an item `computer_apps` opens: a path's or a file URL's last part, a web page's host and path. */
export function openItemName(item: string): string {
  if (/^https?:/i.test(item)) {
    try {
      const u = new URL(item)
      return (u.host + (u.pathname === '/' ? '' : u.pathname)) || item
    } catch {
      return item
    }
  }
  let path = item
  if (/^file:/i.test(item)) {
    try {
      path = decodeURIComponent(new URL(item).pathname)
    } catch {
      path = item.replace(/^file:\/*/i, '/')
    }
  }
  return path.replace(/\/+$/, '').split('/').pop() || path
}

/** `report.pdf`, or `3 items`. */
export function openItemsWords(open: readonly string[]): string {
  return open.length === 1 ? openItemName(open[0]) : `${open.length} items`
}

export interface ApprovalNeed {
  /** a card before the call */
  ask: boolean
  /** what the card says the act is: the model's flag, or the host's own password rule */
  confirm: ConfirmNeed | null
}

/**
 * Does this call need a card? An act or batch that sends input asks in safe
 * and edits; a flagged one (`confirm`) asks in every mode, full access
 * included; so does the host's own need (`password`), which takes the card
 * whole: the model's words may hold the very text, so they never show.
 * apps with `open` changes what an app holds, so it asks as an act does and
 * takes the flag; a bare launch and observe never ask.
 */
export function needsApproval(tool: ComputerToolName, args: ToolArgs, permission: PermissionPolicy = 'safe', hostNeed: ConfirmNeed | null = null): ApprovalNeed {
  const opens = tool === 'computer_apps' && (args.open?.length ?? 0) > 0
  const acts =
    tool === 'computer_act'
      ? args.action !== undefined && sendsInput({ action: args.action })
      : tool === 'computer_batch'
        ? (args.actions ?? []).some(sendsInput)
        : opens
  const flagged = tool === 'computer_act' || tool === 'computer_batch' || opens
  const flag = flagged && args.confirm ? { kind: args.confirm.kind as HostConfirmKind, what: args.confirm.what } : null
  const confirm = hostNeed ?? flag
  return { ask: confirm !== null || (acts && permission !== 'auto'), confirm }
}

export interface TitleContext {
  appName: string
  /** the model's `window`, else the bound window's title; null leaves it out */
  window: string | null
  /** the thread's book: an element's line, or null when it has none */
  element: (index: number) => ElementBrief | null
  /** text goes into a password field: steps say how long it is, never what */
  maskText?: boolean
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

const isPassword = (index: number | undefined, ctx: TitleContext): boolean => {
  if (index === undefined) return false
  const line = ctx.element(index)?.line
  return line === 'password' || !!line?.startsWith('password ')
}

/** The text a step puts in, quoted, or only its length when it goes into a password field. */
function textWords(text: string, action: ComputerAction, ctx: TitleContext): string {
  if (!ctx.maskText && !isPassword(action.element, ctx)) return quoteShort(text)
  const n = [...text].length
  return `${n} character${n === 1 ? '' : 's'}`
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
      return `type ${textWords(action.text ?? '', action, ctx)}${at ? ` into ${at}` : ''}`
    case 'paste':
      return `paste ${textWords(action.text ?? '', action, ctx)}${at ? ` into ${at}` : ''}`
    case 'key':
      return `press ${action.text}${action.repeat && action.repeat > 1 ? ` ${action.repeat} times` : ''}`
    case 'hold_key':
      return `hold ${action.text} for ${action.duration} s`
    case 'set_value':
      return `set ${at} to ${textWords(action.value ?? '', action, ctx)}`
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

const where = (ctx: Pick<TitleContext, 'appName' | 'window'>): string => `${ctx.appName}${ctx.window ? `, window ${JSON.stringify(ctx.window)}` : ''}`
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

function actingSteps(tool: ComputerToolName, args: ToolArgs): ComputerAction[] {
  if (tool === 'computer_act') return args.action && sendsInput({ action: args.action }) ? [args as ComputerAction] : []
  if (tool === 'computer_batch') return ((args.actions ?? []) as ComputerAction[]).filter(sendsInput)
  return []
}

/** What a card says when the call is expected to take the person's pointer and keyboard. */
export const USING_SESSION_WORDS = ', using your pointer and keyboard'

/**
 * The card's title (the card's row, the notifier and the away row read it):
 * `Click button "Save" in TextEdit, window "Untitled"`, a batch
 * `3 actions in Mail, window "New Message": click button "To", type "Lunch?", press super+Return`.
 * A flagged call leads with its kind: `Send in Mail: Reply to Ana (click button "Send")`.
 * A batch's reads are left out. With `session` (a step expected to need the
 * session tier) it ends `, using your pointer and keyboard`, and an Allow
 * then covers that tier too.
 */
export function computerApprovalTitle(
  tool: ComputerToolName,
  args: ToolArgs,
  ctx: TitleContext,
  confirm: ConfirmNeed | null = null,
  opts: { session?: boolean } = {}
): string {
  if (tool === 'computer_apps') {
    const app = args.launch ?? ctx.appName
    const what = `open ${openItemsWords(args.open ?? [])}`
    return confirm ? confirmTitle(confirm, app, what) : `${capital(what)} in ${app}`
  }
  const steps = actingSteps(tool, args).map((a) => actionWords(a, ctx))
  const using = opts.session ? USING_SESSION_WORDS : ''
  if (confirm) return confirmTitle(confirm, ctx.appName, steps.join(', ') || undefined) + using
  if (steps.length === 1) return `${capital(steps[0])} in ${where(ctx)}${using}`
  return `${steps.length} actions in ${where(ctx)}${using}: ${steps.join(', ')}`
}

/** The card tier scheduling raises for a held step: a tool name no harness calls. */
export const COMPUTER_SESSION_TOOL = 'computer_session'

/** That card's title: `Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"`. */
export function computerSessionAskTitle(stepWords: string, ctx: Pick<TitleContext, 'appName' | 'window'>): string {
  return `Use your pointer and keyboard to ${stepWords} in ${where(ctx)}`
}

export interface ComputerApprovalInput {
  app: string
  window: string | null
  actions: string[]
  confirm?: { kind: HostConfirmKind; label: string; what: string }
  /** computer_apps: the items it opens, as the model gave them */
  open?: string[]
}

/** The card's input, for the preview thread's card: the app, the window, each acting step in words, and the flag with its label. */
export function computerApprovalInput(tool: ComputerToolName, args: ToolArgs, ctx: TitleContext, confirm: ConfirmNeed | null = null): ComputerApprovalInput {
  if (tool === 'computer_apps')
    return {
      app: args.launch ?? ctx.appName,
      window: null,
      actions: (args.open ?? []).map((item) => `open ${openItemName(item)}`),
      open: args.open ?? [],
      ...(confirm ? { confirm: confirmInput(confirm) } : {})
    }
  return {
    app: ctx.appName,
    window: ctx.window,
    actions: actingSteps(tool, args).map((a) => actionWords(a, ctx)),
    ...(confirm ? { confirm: confirmInput(confirm) } : {})
  }
}

// ── a call in plain words: the working line, the transcript's row, the Activity row ──

/** A computer call in words: the verb a row draws muted, the object in foreground, a batch's step count. */
export interface ComputerPhrase {
  verb: string
  object: string
  tally?: string
}

export interface PhraseOptions {
  /** present tense while the call runs, past once it settled */
  live: boolean
  /** an element's book line (the host passes its book; the renderer has none while a call runs) */
  brief?: (index: number) => ElementBrief | null
  /** the settled result's text: its step lines name each element and its header the app */
  result?: string
  /** the app's own name when the host knows it, before the result says it */
  app?: string
}

type Named = { role: string; name: string | null } | null
type Forms = readonly [live: string, settled: string]

/** Never words a person should not read on a collapsed row: a name that is a URL or a path reads as its role. */
const LOOKS_LIKE_PATH = /:\/\/|^[/~]|^[A-Za-z]:\\/

function elementWords(e: Named): string | null {
  if (!e) return null
  if (e.name && e.name.trim() && !LOOKS_LIKE_PATH.test(e.name)) return e.name.trim()
  if (!e.role) return null
  return `${/^[aeiou]/.test(e.role) ? 'an' : 'a'} ${e.role}`
}

function briefNamed(brief: ElementBrief | null): Named {
  if (!brief) return null
  try {
    const e = parseElementLine(`[${brief.index}] ${brief.line}`)
    return { role: e.role, name: e.name ?? null }
  } catch {
    return null
  }
}

const CLICK_FORMS: Partial<Record<ComputerActionName, Forms>> = {
  left_click: ['Clicking', 'Clicked'],
  right_click: ['Right-clicking', 'Right-clicked'],
  middle_click: ['Middle-clicking', 'Middle-clicked'],
  double_click: ['Double-clicking', 'Double-clicked'],
  triple_click: ['Triple-clicking', 'Triple-clicked']
}

const titleWords = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
const keyWords = (s: unknown): string | null => (typeof s === 'string' && s.trim() && s.length <= 40 ? s.trim() : null)

type StepInput = { action?: unknown; element?: unknown; text?: unknown; scroll_direction?: unknown; name?: unknown }

/** One action in words, with the element it names (already resolved) in the app. */
function stepPhrase(a: StepInput, element: Named, app: string, live: boolean): ComputerPhrase {
  const f = (forms: Forms): string => forms[live ? 0 : 1]
  const who = elementWords(element)
  const inApp = `in ${app}`
  const on = (thing: string | null): string => (thing ? `${thing} ${inApp}` : inApp)
  const action = a.action as ComputerActionName
  const click = CLICK_FORMS[action]
  if (click) return { verb: f(click), object: on(who) }
  switch (action) {
    case 'type':
      return { verb: f(['Typing', 'Typed']), object: who ? `into ${who} ${inApp}` : inApp }
    case 'paste':
      return { verb: f(['Pasting', 'Pasted']), object: who ? `into ${who} ${inApp}` : inApp }
    case 'key':
      return { verb: f(['Pressing', 'Pressed']), object: on(keyWords(a.text) ?? 'a key') }
    case 'hold_key':
      return { verb: f(['Holding', 'Held']), object: on(keyWords(a.text) ?? 'a key') }
    case 'scroll':
      return { verb: f(['Scrolling', 'Scrolled']), object: on(typeof a.scroll_direction === 'string' ? a.scroll_direction : null) }
    case 'left_click_drag':
      return { verb: f(['Dragging', 'Dragged']), object: inApp }
    case 'mouse_move':
      return who ? { verb: f(['Pointing at', 'Pointed at']), object: on(who) } : { verb: f(['Moving', 'Moved']), object: on('the pointer') }
    case 'left_mouse_down':
      return { verb: f(['Pressing', 'Pressed']), object: on('the mouse button') }
    case 'left_mouse_up':
      return { verb: f(['Letting go of', 'Let go of']), object: on('the mouse button') }
    case 'set_value':
      return { verb: f(['Setting', 'Set']), object: on(who ?? 'a value') }
    case 'select_text':
      return { verb: f(['Selecting', 'Selected']), object: on('text') }
    case 'perform': {
      const what = keyWords(a.name)
      return { verb: f(['Using', 'Used']), object: on([what && titleWords(what), who && `on ${who}`].filter(Boolean).join(' ') || null) }
    }
    case 'screenshot':
      return { verb: f(['Looking at', 'Looked at']), object: app }
    case 'zoom':
      return { verb: f(['Zooming into', 'Zoomed into']), object: app }
    case 'wait':
      return { verb: f(['Waiting on', 'Waited on']), object: app }
    case 'cursor_position':
      return { verb: f(['Finding', 'Found']), object: on('the pointer') }
    default:
      return { verb: f(['Using', 'Used']), object: app }
  }
}

/** The app the observation's header names (`app "TextEdit" · window …`), when the result has one. */
function resultApp(result: string | undefined): string | null {
  if (!result) return null
  for (const line of result.split('\n')) {
    const m = /^app ("(?:[^"\\]|\\.)*")/.exec(line)
    if (m) {
      try {
        return JSON.parse(m[1]) as string
      } catch {
        return null
      }
    }
  }
  return null
}

const isAction = (a: unknown): a is StepInput & { action: ComputerActionName } =>
  !!a && typeof a === 'object' && (COMPUTER_ACTION_NAMES as readonly unknown[]).includes((a as StepInput).action)

/**
 * A computer call in plain words: "Clicking Save in TextEdit" while it runs,
 * "Clicked Save in TextEdit" once it settled. An element is named by its
 * name, else its role ("a button"), never its index; typed text, URLs and
 * paths never enter the words. Null for any other tool.
 */
export function computerPhrase(tool: string, input: unknown, opts: PhraseOptions): ComputerPhrase | null {
  const of = computerToolOf(tool)
  if (!of) return null
  const live = opts.live
  const f = (forms: Forms): string => forms[live ? 0 : 1]
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const app = (!live ? resultApp(opts.result) : null) ?? opts.app ?? (typeof i.app === 'string' && i.app.trim() ? i.app.trim() : 'an app')
  if (of.tool === 'computer_apps') return { verb: f(['Listing', 'Listed']), object: 'apps' }
  if (of.tool === 'computer_observe') return { verb: f(['Reading', 'Read']), object: app }

  const actions: (StepInput & { action: ComputerActionName })[] =
    of.tool === 'computer_batch'
      ? (Array.isArray(i.actions) ? i.actions : []).filter(isAction)
      : isAction({ ...i, action: of.action ?? i.action })
        ? [{ ...i, action: (of.action ?? i.action) as ComputerActionName }]
        : []
  if (!actions.length) return of.tool === 'computer_batch' ? { verb: f(['Working', 'Worked']), object: `in ${app}` } : { verb: f(['Using', 'Used']), object: app }

  // the settled result's first lines are the step lines, one per action, in order
  const lines = !live && opts.result ? opts.result.split('\n') : []
  const named = (k: number): Named => {
    const line = lines[k] !== undefined ? parseStepLine(lines[k]) : null
    if (line && line.action === actions[k].action) return line.element ? { role: line.element.role, name: line.element.name } : null
    const index = actions[k].element
    return typeof index === 'number' && opts.brief ? briefNamed(opts.brief(index)) : null
  }
  const acting = actions.flatMap((a, k) => (sendsInput(a) ? [k] : []))
  const one = acting.length === 1 ? acting[0] : actions.length === 1 ? 0 : null
  if (one !== null) return stepPhrase(actions[one], named(one), app, live)
  return { verb: f(['Working', 'Worked']), object: `in ${app}`, tally: `${actions.length} steps` }
}

/** The activity line the thread's row, Activity and the working line show while a computer call runs; null for any other tool. */
export function computerActivity(
  name: string,
  input: unknown,
  brief?: (index: number) => ElementBrief | null,
  app?: string
): { text: string; kind: 'investigate' | 'edit' } | null {
  const phrase = computerPhrase(name, input, { live: true, brief, app })
  if (!phrase) return null
  const of = computerToolOf(name)!
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const steps: unknown[] = of.tool === 'computer_batch' ? (Array.isArray(i.actions) ? i.actions : []) : of.tool === 'computer_act' ? [{ ...i, action: of.action ?? i.action }] : []
  const acts = steps.length === 0 ? of.tool === 'computer_act' : steps.some((a) => !isAction(a) || sendsInput(a))
  return { text: `${phrase.verb} ${phrase.object}`, kind: acts ? 'edit' : 'investigate' }
}
