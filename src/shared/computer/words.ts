/**
 * What the person reads of a computer call (docs/computer-protocol.md
 * "Permission and Stop"): whether it asks in `safe` and `edits`, the card's
 * title and input, and the activity line the thread's row and Activity show.
 * Reads never ask; every action that sends input does, one card per call.
 */
import type { PermissionPolicy } from '../events'
import { COMPUTER_RESULT_TOOL } from './heldCalls'
import { parseElementLine } from './observation'
import { confirmInput, confirmTitle, type Confirm, type ConfirmNeed, type HostConfirmKind } from './policy'
import { COMPUTER_ACTION_NAMES, NO_INPUT_ACTIONS, type ComputerAction, type ComputerActionName, type ElementBrief } from './protocol'
import { menuPathSegments, parseStepLine, type ComputerToolName, type TierVerdict } from './tools'

/**
 * A tool's own name: `mcp__app__computer_act` and `computer_act` alike, a
 * per-verb `computer_left_click` as its verb. Null for computer_result, which
 * is none of the four (`isComputerResult`).
 */
export function computerToolOf(name: string): { tool: ComputerToolName; action?: ComputerActionName } | null {
  const bare = name.replace(/^mcp__app__/, '')
  if (bare === 'computer_apps' || bare === 'computer_observe' || bare === 'computer_act' || bare === 'computer_batch')
    return { tool: bare }
  const verb = bare.startsWith('computer_') ? bare.slice('computer_'.length) : null
  if (verb && (COMPUTER_ACTION_NAMES as readonly string[]).includes(verb))
    return { tool: 'computer_act', action: verb as ComputerActionName }
  return null
}

/** computer_result (heldCalls.ts), bare or as `mcp__app__computer_result`. */
export const isComputerResult = (name: string): boolean => name.replace(/^mcp__app__/, '') === COMPUTER_RESULT_TOOL

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
  /** A known tab this call will select before its steps. */
  tab?: string
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
      return `select ${action.text !== undefined ? textWords(action.text, action, ctx) : `${action.range?.[0]}..${action.range?.[1]}`} in ${at}`
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
    case 'save_as':
      return `save as ${action.path}${action.replace ? ', replacing the file there' : ''}`
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
/** What a card says when a step is expected to bring the app forward for a moment (§26.6): `, bringing TextEdit forward for a moment`. */
export const bringingForwardWords = (app: string): string => `, bringing ${app} forward for a moment`

/**
 * The card's title (the card's row, the notifier and the away row read it):
 * `Click button "Save" in TextEdit, window "Untitled"`, a batch
 * `3 actions in Mail, window "New Message": click button "To", type "Lunch?", press super+Return`.
 * A flagged call leads with its kind: `Send in Mail: Reply to Ana (click button "Send")`.
 * A batch's reads are left out. With `session` (a step expected to need the
 * session tier) it ends `, using your pointer and keyboard`, and an Allow
 * then covers that tier too; with `front` (a step expected to need the app in
 * front, §26.6) it ends `, bringing TextEdit forward for a moment`, and an
 * Allow covers the hold.
 */
export function computerApprovalTitle(
  tool: ComputerToolName,
  args: ToolArgs,
  ctx: TitleContext,
  confirm: ConfirmNeed | null = null,
  opts: { session?: boolean; front?: boolean } = {}
): string {
  if (tool === 'computer_apps') {
    const app = args.launch ?? ctx.appName
    const what = `open ${openItemsWords(args.open ?? [])}`
    return confirm ? confirmTitle(confirm, app, what) : `${capital(what)} in ${app}`
  }
  const steps = actingSteps(tool, args).map((a) => actionWords(a, ctx))
  const using = opts.session ? USING_SESSION_WORDS : opts.front ? bringingForwardWords(ctx.appName) : ''
  if (confirm) return confirmTitle(confirm, ctx.appName, [...(ctx.tab ? [`select tab ${JSON.stringify(ctx.tab)}`] : []), ...steps].join(', ') || undefined) + using
  if (ctx.tab) return `Select tab ${JSON.stringify(ctx.tab)} and ${steps.length === 1 ? steps[0] : `${steps.length} actions`} in ${where(ctx)}${using}${steps.length > 1 ? `: ${steps.join(', ')}` : ''}`
  if (steps.length === 1) return `${capital(steps[0])} in ${where(ctx)}${using}`
  return `${steps.length} actions in ${where(ctx)}${using}: ${steps.join(', ')}`
}

/** The card tier scheduling raises for a held step: a tool name no harness calls. */
export const COMPUTER_SESSION_TOOL = 'computer_session'

/**
 * That card's title: `Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"`;
 * for a step that needs the app in front (§26.6) `Bring TextEdit forward for a moment to press super+s, window "Total.txt"`.
 */
export function computerSessionAskTitle(stepWords: string, ctx: Pick<TitleContext, 'appName' | 'window'>, opts: { front?: boolean } = {}): string {
  if (opts.front) return `Bring ${ctx.appName} forward for a moment to ${stepWords}${ctx.window ? `, window ${JSON.stringify(ctx.window)}` : ''}`
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
    actions: [...(ctx.tab ? [`select tab ${JSON.stringify(ctx.tab)}`] : []), ...actingSteps(tool, args).map((a) => actionWords(a, ctx))],
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
  /** the call did not run to a good end: its words are what was asked of it ("Click Save"), whatever `live` says */
  asked?: boolean
  /** an element's book line (the host passes its book; the renderer has none while a call runs) */
  brief?: (index: number) => ElementBrief | null
  /** the settled result's text: its step lines name each element and its header the app */
  result?: string
  /** the app's own name when the host knows it, before the result says it; `false` leaves the app out of the object, which is then empty when the app is all there is (the Computer section names an app only where it changes) */
  app?: string | false
  /** computer_apps: what the launch did, when the caller knows it without the result's text */
  launched?: AppsOutcome
}

/** What a `computer_apps { launch, open }` did: whether it started the app, and whether it opened its items. */
export interface AppsOutcome {
  launched: boolean
  opened: boolean
}

type Named = { role: string; name: string | null } | null
type Forms = readonly [live: string, settled: string, asked: string]
/** Which of a verb's forms a row takes: 0 while it runs, 1 once it ran, 2 for a step that was asked and did not end well. */
type Tense = 0 | 1 | 2
const tenseOf = (opts: Pick<PhraseOptions, 'live' | 'asked'>): Tense => (opts.asked ? 2 : opts.live ? 0 : 1)

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
  left_click: ['Clicking', 'Clicked', 'Click'],
  right_click: ['Right-clicking', 'Right-clicked', 'Right-click'],
  middle_click: ['Middle-clicking', 'Middle-clicked', 'Middle-click'],
  double_click: ['Double-clicking', 'Double-clicked', 'Double-click'],
  triple_click: ['Triple-clicking', 'Triple-clicked', 'Triple-click']
}

const titleWords = (s: string): string => s.replace(/\b[a-z]/g, (c) => c.toUpperCase())
const keyWords = (s: unknown): string | null => (typeof s === 'string' && s.trim() && s.length <= 40 ? s.trim() : null)

type StepInput = { action?: unknown; element?: unknown; text?: unknown; scroll_direction?: unknown; name?: unknown; named?: unknown; menu?: unknown }

/** A step's target by its name (§27.9) or the last item of its menu path (§27.10), before any line names the element. */
function targetNamed(a: StepInput): Named {
  if (typeof a.named === 'string' && a.named.trim()) return { role: '', name: a.named }
  if (typeof a.menu === 'string') {
    const item = menuPathSegments(a.menu).at(-1)
    if (item) return { role: 'menu item', name: item }
  }
  return null
}

/** One action in words, with the element it names (already resolved) in the app; a null app is left out. */
function stepPhrase(a: StepInput, element: Named, appName: string | null, tense: Tense): ComputerPhrase {
  const f = (forms: Forms): string => forms[tense]
  const who = elementWords(element)
  const app = appName ?? ''
  const inApp = appName === null ? '' : `in ${appName}`
  const on = (thing: string | null): string => [thing, inApp].filter(Boolean).join(' ')
  const action = a.action as ComputerActionName
  const click = CLICK_FORMS[action]
  if (click) return { verb: f(click), object: on(who) }
  switch (action) {
    case 'type':
      return { verb: f(['Typing', 'Typed', 'Type']), object: on(who && `into ${who}`) }
    case 'paste':
      return { verb: f(['Pasting', 'Pasted', 'Paste']), object: on(who && `into ${who}`) }
    case 'key':
      return { verb: f(['Pressing', 'Pressed', 'Press']), object: on(keyWords(a.text) ?? 'a key') }
    case 'hold_key':
      return { verb: f(['Holding', 'Held', 'Hold']), object: on(keyWords(a.text) ?? 'a key') }
    case 'scroll':
      return { verb: f(['Scrolling', 'Scrolled', 'Scroll']), object: on(typeof a.scroll_direction === 'string' ? a.scroll_direction : null) }
    case 'left_click_drag':
      return { verb: f(['Dragging', 'Dragged', 'Drag']), object: on(null) }
    case 'mouse_move':
      return who ? { verb: f(['Pointing at', 'Pointed at', 'Point at']), object: on(who) } : { verb: f(['Moving', 'Moved', 'Move']), object: on('the pointer') }
    case 'left_mouse_down':
      return { verb: f(['Pressing', 'Pressed', 'Press']), object: on('the mouse button') }
    case 'left_mouse_up':
      return { verb: f(['Letting go of', 'Let go of', 'Let go of']), object: on('the mouse button') }
    case 'set_value':
      return { verb: f(['Setting', 'Set', 'Set']), object: on(who ?? 'a value') }
    case 'select_text':
      return { verb: f(['Selecting', 'Selected', 'Select']), object: on('text') }
    case 'perform': {
      const what = keyWords(a.name)
      return { verb: f(['Using', 'Used', 'Use']), object: on([what && titleWords(what), who && `on ${who}`].filter(Boolean).join(' ') || null) }
    }
    case 'screenshot':
      return { verb: f(['Looking at', 'Looked at', 'Look at']), object: app }
    case 'zoom':
      return { verb: f(['Zooming into', 'Zoomed into', 'Zoom into']), object: app }
    case 'wait':
      return { verb: f(['Waiting on', 'Waited on', 'Wait on']), object: app }
    case 'cursor_position':
      return { verb: f(['Finding', 'Found', 'Find']), object: on('the pointer') }
    default:
      return { verb: f(['Using', 'Used', 'Use']), object: app }
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

/** A web page reads as "a page" and a file by its name: a URL never enters a row's words. */
const openWords = (open: readonly string[]): string => (open.length === 1 ? (/^https?:/i.test(open[0]) ? 'a page' : openItemName(open[0])) : `${open.length} items`)

/** The app a launch names, as a row says it: a path's or a bundle id's last part, never the path. */
function launchName(launch: string): string {
  const name = launch.trim()
  if (LOOKS_LIKE_PATH.test(name)) return openItemName(name).replace(/\.app$/i, '')
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(name) ? name.split('.').pop()! : name
}

/** What the result's own lines say a launch did (result.ts `launchLines`). */
function appsOutcomeOf(result: string | undefined): AppsOutcome {
  const lines = result ? result.split('\n') : []
  return { launched: lines[0]?.startsWith('Launched ') === true, opened: lines.some((l) => l.startsWith('Opened ')) }
}

/**
 * computer_apps in words: an open says what it opens in which app, a launch
 * that started the app says so once it settled, and every other call lists.
 * While it runs a bare launch still reads Listing: whether the app starts is
 * the service's to find.
 */
function appsPhrase(i: Record<string, unknown>, opts: PhraseOptions): ComputerPhrase {
  const f = (forms: Forms): string => forms[tenseOf(opts)]
  const launch = typeof i.launch === 'string' && i.launch.trim() ? launchName(i.launch) : null
  const open = Array.isArray(i.open) ? i.open.filter((o): o is string => typeof o === 'string') : []
  const did = opts.live || opts.asked ? null : (opts.launched ?? appsOutcomeOf(opts.result))
  if (launch && open.length && (opts.live || opts.asked || did?.opened)) return { verb: f(['Opening', 'Opened', 'Open']), object: `${openWords(open)} in ${launch}` }
  // what was asked of a bare launch is the launch, whether or not the app was already running
  if (launch && opts.asked) return { verb: 'Launch', object: launch }
  if (launch && did?.launched) return { verb: 'Launched', object: launch }
  return { verb: f(['Listing', 'Listed', 'List']), object: 'apps' }
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
  const live = opts.live
  const tense = tenseOf(opts)
  const f = (forms: Forms): string => forms[tense]
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  if (isComputerResult(tool))
    return { verb: i.cancel === true ? f(['Cancelling', 'Cancelled', 'Cancel']) : f(['Waiting for', 'Waited for', 'Wait for']), object: 'the held call' }
  const of = computerToolOf(tool)
  if (!of) return null
  // null leaves the app out of every object (`app: false`)
  const app = opts.app === false ? null : ((!live ? resultApp(opts.result) : null) ?? opts.app ?? (typeof i.app === 'string' && i.app.trim() ? i.app.trim() : 'an app'))
  const inApp = app === null ? '' : `in ${app}`
  if (of.tool === 'computer_apps') return appsPhrase(i, opts)
  if (of.tool === 'computer_observe') return { verb: f(['Reading', 'Read', 'Read']), object: app ?? '' }

  const actions: (StepInput & { action: ComputerActionName })[] =
    of.tool === 'computer_batch'
      ? (Array.isArray(i.actions) ? i.actions : []).filter(isAction)
      : isAction({ ...i, action: of.action ?? i.action })
        ? [{ ...i, action: (of.action ?? i.action) as ComputerActionName }]
        : []
  if (!actions.length) return of.tool === 'computer_batch' ? { verb: f(['Working', 'Worked', 'Work']), object: inApp } : { verb: f(['Using', 'Used', 'Use']), object: app ?? '' }

  // the settled result's first lines are the step lines, one per action, in order
  const lines = !live && opts.result ? opts.result.split('\n') : []
  const named = (k: number): Named => {
    const line = lines[k] !== undefined ? parseStepLine(lines[k]) : null
    if (line && line.action === actions[k].action && line.element) return { role: line.element.role, name: line.element.name }
    const index = actions[k].element
    if (typeof index === 'number') return opts.brief ? briefNamed(opts.brief(index)) : null
    return targetNamed(actions[k])
  }
  const acting = actions.flatMap((a, k) => (sendsInput(a) ? [k] : []))
  const one = acting.length === 1 ? acting[0] : actions.length === 1 ? 0 : null
  if (one !== null) return stepPhrase(actions[one], named(one), app, tense)
  return { verb: f(['Working', 'Worked', 'Work']), object: inApp, tally: `${actions.length} steps` }
}

/** The activity line the thread's row, Activity and the working line show while a computer call runs; null for any other tool. */
export function computerActivity(
  name: string,
  input: unknown,
  brief?: (index: number) => ElementBrief | null,
  app?: string
): { text: string; kind: 'investigate' | 'edit' } | null {
  const phrase = computerPhrase(name, input, { live: true, brief, ...(app !== undefined ? { app } : {}) })
  if (!phrase) return null
  const of = computerToolOf(name)
  // computer_result sends nothing itself: the call it reads already said what it does
  if (!of) return { text: `${phrase.verb} ${phrase.object}`, kind: 'investigate' }
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const steps: unknown[] = of.tool === 'computer_batch' ? (Array.isArray(i.actions) ? i.actions : []) : of.tool === 'computer_act' ? [{ ...i, action: of.action ?? i.action }] : []
  const acts = steps.length === 0 ? of.tool === 'computer_act' : steps.some((a) => !isAction(a) || sendsInput(a))
  return { text: `${phrase.verb} ${phrase.object}`, kind: acts ? 'edit' : 'investigate' }
}

// ── what Settings → Computer use says an app's verdict learned ──

/** The classes in the order a person reads them, each as its verb. */
const CLASS_VERBS: readonly (readonly [keyof TierVerdict['classes'], string])[] = [
  ['click', 'click'],
  ['drag', 'drag'],
  ['hover', 'hover'],
  ['scroll', 'scroll'],
  ['key', 'press keys'],
  ['type', 'type']
]

/**
 * What an app's verdict learned, in a person's words: "May take the screen to
 * click and type" for the classes at `session`, null when none is. A class
 * absent from the verdict was never tested, and one at `session` still tries
 * the background routes first (§24), so nothing else is said and no tier is named.
 */
export function verdictWords(classes: TierVerdict['classes']): string | null {
  const verbs = CLASS_VERBS.filter(([c]) => classes[c] === 'session').map(([, verb]) => verb)
  if (!verbs.length) return null
  const list = verbs.length === 1 ? verbs[0] : `${verbs.slice(0, -1).join(', ')} and ${verbs[verbs.length - 1]}`
  return `May take the screen to ${list}`
}
