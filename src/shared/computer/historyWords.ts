/**
 * A computer call as the Computer section lists it (docs/computer-protocol.md
 * "What the person sees"): each step's words, what it acted on, how it went
 * and why it failed, made once on the host that ran it and written into the
 * thread's journal (src/main/server/computer/history.ts). Pure: the call's
 * own arguments, the thread's element book and the service's results in,
 * strings out.
 *
 * No secret in a step: typed, pasted, set and selected text is written only
 * when the step names its field by index, the book says that field is no
 * password field and no earlier step of the call sent input
 * (`mayQuoteText`); every other text is its length, and a bare printable key
 * is "a key". The start, the end and a batch's plan all go through that one
 * rule, and the read text the journal keeps has the texts the rule held back
 * taken out (`scrubReadText`).
 *
 * A step reads in the past only when it ran: "Clicked Save". One that
 * failed, was stopped, was refused or never ran reads as what was asked,
 * "Click Save", with why under it.
 */
import {
  COMPUTER_ABORT_WORDS,
  COMPUTER_SKIPPED_WORDS,
  COMPUTER_EFFECT_FACTS,
  COMPUTER_FAILURE_WORDS,
  COMPUTER_REFUSAL_WORDS,
  COMPUTER_ROUTE_WORDS
} from '../statusWords'
import type { ComputerHistoryStep, ComputerStepKind } from '../contract-computer'
import { errorLine, type ErrorContext } from './errorWords'
import type { HostErrorKind } from './hostErrors'
import { parseElementLine, parseKeyCombo, parseObservation } from './observation'
import {
  NO_INPUT_ACTIONS,
  type ComputerAction,
  type ComputerActionName,
  type ComputerError,
  type ElementBrief,
  type FrontReport,
  type StepResult,
  type WaitReport
} from './protocol'
import type { SessionTierRefusal } from './scheduleRules'
import { diskWords, menuPathSegments, type ComputerToolName } from './tools'
import { computerPhrase, isPasswordLine, quoteShort as quoted, type AppsOutcome, type ComputerPhrase } from './words'

/** What the words need of the thread's element book (computer/elements.ts). */
export interface WordsBook {
  brief(index: number): ElementBrief | null
  /** an element's ancestors, the nearest first */
  path(index: number): ElementBrief[]
}

/** The read text a call keeps: past this many UTF-8 bytes it is cut at a line and says so. */
export const READ_TEXT_MAX_BYTES = 12_000
/** A quoted text fact is cut at this many characters. */
export const TEXT_FACT_MAX = 60

const sendsInput = (a: Pick<ComputerAction, 'action'>): boolean => !NO_INPUT_ACTIONS.includes(a.action)

const KINDS: Readonly<Record<ComputerActionName, ComputerStepKind>> = {
  screenshot: 'look',
  zoom: 'look',
  cursor_position: 'look',
  left_click: 'click',
  right_click: 'click',
  middle_click: 'click',
  double_click: 'click',
  triple_click: 'click',
  left_click_drag: 'click',
  mouse_move: 'click',
  left_mouse_down: 'click',
  left_mouse_up: 'click',
  perform: 'click',
  select_text: 'click',
  scroll: 'scroll',
  type: 'type',
  paste: 'type',
  set_value: 'type',
  save_as: 'type',
  key: 'key',
  hold_key: 'key',
  wait: 'wait'
}

/** The steps a call runs: computer_act's one, computer_batch's list, none for apps and observe. */
export function callActions(tool: ComputerToolName, args: Record<string, unknown>): ComputerAction[] {
  if (tool === 'computer_batch') return Array.isArray(args.actions) ? (args.actions as ComputerAction[]) : []
  if (tool !== 'computer_act') return []
  const { app: _app, window: _window, screenshot: _screenshot, confirm: _confirm, ...action } = args
  return [action as ComputerAction]
}

// ── the secret rule ─────────────────────────────────────────────────────

/**
 * Whether step `k`'s text may be written as it is: it names its field by
 * index, the book knows that field and it is no password field, and no
 * earlier step of the call sent input (which could have moved the field).
 */
export function mayQuoteText(actions: readonly ComputerAction[], k: number, book: WordsBook | undefined): boolean {
  const index = actions[k]?.element
  if (index === undefined || !book) return false
  const brief = book.brief(index)
  if (!brief || isPasswordLine(brief.line)) return false
  return !actions.slice(0, k).some(sendsInput)
}

/** A key that writes a character into whatever has the focus: no super, ctrl or alt, and a single character. A combo off the grammar counts as one. */
function barePrintable(text: string | undefined): boolean {
  if (!text) return false
  try {
    const combo = parseKeyCombo(text)
    return [...combo.key].length === 1 && !combo.modifiers.some((m) => m !== 'shift')
  } catch {
    return true
  }
}

/** The step as the words may read it: a bare printable key becomes "a key". */
function safeAction(a: ComputerAction): ComputerAction {
  return (a.action === 'key' || a.action === 'hold_key') && barePrintable(a.text) ? { ...a, text: 'a key' } : a
}

const quoteShort = (text: string): string => quoted(text, TEXT_FACT_MAX)

/** The text a step put in, as a fact: quoted and cut when the rule allows it, else its length. */
function textFact(text: string, quote: boolean): string {
  if (quote) return quoteShort(text)
  const n = [...text].length
  return `${n} character${n === 1 ? '' : 's'}`
}

// ── what a step acted on ────────────────────────────────────────────────

const article = (role: string): string => (/^[aeiou]/.test(role) ? 'an' : 'a')

function roleAndName(brief: ElementBrief): { role: string; name: string | null } | null {
  try {
    const e = parseElementLine(`[${brief.index}] ${brief.line}`)
    return { role: e.role, name: e.name?.trim() ? e.name.trim() : null }
  } catch {
    return null
  }
}

/**
 * An element more exactly than its row's words: its role, and the nearest
 * named ancestor that is not the window (`a button in the "Save As" sheet`).
 * An element with no name is already its role on the row, so only where it
 * sits is said.
 */
function elementFact(brief: ElementBrief | null, path: readonly ElementBrief[]): string | undefined {
  const own = brief ? roleAndName(brief) : null
  let inside: string | null = null
  for (const ancestor of path) {
    const a = roleAndName(ancestor)
    if (a?.name && a.role !== 'window') {
      inside = `in the ${JSON.stringify(a.name)} ${a.role}`
      break
    }
  }
  const role = own?.name ? `${article(own.role)} ${own.role}` : null
  return [role, inside].filter(Boolean).join(' ') || undefined
}

/** A point in brackets, so its comma is not one of the facts line's. */
const pointWords = (p: readonly number[]): string => `(${p[0]}, ${p[1]})`

/**
 * What step `k` acted on, as an open row's fact, or undefined when its words
 * already say it. `resolved` is the element a `named` target resolved to.
 */
export function stepTargetWords(actions: readonly ComputerAction[], k: number, book: WordsBook | undefined, resolved?: ElementBrief): string | undefined {
  const a = actions[k]
  if (!a) return undefined
  if (a.menu !== undefined) return `menu ${menuPathSegments(a.menu).join(' › ')}`
  const index = a.element ?? resolved?.index
  const element = (): string | undefined =>
    index !== undefined ? elementFact(resolved?.index === index ? resolved : (book?.brief(index) ?? null), book?.path(index) ?? []) : undefined
  // into a field the book knows is a password field, even how long the text was is the person's to keep
  const secret = (): string | undefined => (index !== undefined && isPasswordLine((resolved?.index === index ? resolved : book?.brief(index))?.line) ? 'a password' : undefined)
  switch (a.action) {
    case 'type':
    case 'paste':
      return secret() ?? textFact(a.text ?? '', mayQuoteText(actions, k, book))
    case 'select_text':
      return a.text !== undefined ? (secret() ?? textFact(a.text, mayQuoteText(actions, k, book))) : element()
    case 'set_value':
      return secret() ?? textFact(a.value ?? '', mayQuoteText(actions, k, book))
    case 'scroll':
      return `${a.scroll_direction} ${a.scroll_amount}`
    case 'left_click_drag':
      return a.start_coordinate && a.coordinate ? `${pointWords(a.start_coordinate)} to ${pointWords(a.coordinate)}` : undefined
    case 'save_as':
      return a.path
    case 'key':
    case 'hold_key':
    case 'wait':
    case 'screenshot':
    case 'zoom':
    case 'cursor_position':
    case 'left_mouse_down':
    case 'left_mouse_up':
      return undefined
    default:
      return element() ?? (a.coordinate ? `at ${pointWords(a.coordinate)}` : undefined)
  }
}

// ── the steps as planned and as settled ─────────────────────────────────

export interface WordsContext {
  /** the app's own name, as the host knows it when the call starts; empty for a call that names none */
  app: string
  book?: WordsBook
}

/**
 * How a row words its step: `live` while it runs ("Clicking Save"), `done`
 * once it ran ("Clicked Save"), `asked` when it failed, was stopped, was
 * refused or never ran ("Click Save"): a row never says a thing was done
 * that was not.
 */
export type StepTense = 'live' | 'done' | 'asked'
const tenseOpts = (tense: StepTense): { live: boolean; asked?: true } => (tense === 'asked' ? { live: false, asked: true } : { live: tense === 'live' })

/** A row's words. */
export type StepWords = Pick<ComputerHistoryStep, 'verb' | 'object' | 'inApp'>

/**
 * A step as its start record holds it: the row while it runs, and the same
 * row as asked and as done, all made before the call from the book the
 * model acted on, so a button the click renames reads by the name it had.
 */
export interface PlannedStep extends ComputerHistoryStep {
  asked: StepWords
  done: StepWords
}

const stepOf = (kind: ComputerStepKind, full: ComputerPhrase | null, short: ComputerPhrase | null): ComputerHistoryStep => ({
  kind,
  verb: full?.verb ?? 'Using',
  object: short?.object ?? '',
  inApp: full?.object ?? ''
})

const wordsOf = ({ verb, object, inApp }: ComputerHistoryStep): StepWords => ({ verb, object, inApp })

/** One action's row words, both ways: with the app, and with it left out. */
function actionStep(a: ComputerAction, ctx: WordsContext, tense: StepTense, brief: (i: number) => ElementBrief | null): ComputerHistoryStep {
  const input = { ...safeAction(a), app: ctx.app }
  const opts = { ...tenseOpts(tense), brief }
  return stepOf(
    KINDS[a.action] ?? 'click',
    computerPhrase('computer_act', input, { ...opts, ...(ctx.app ? { app: ctx.app } : {}) }),
    computerPhrase('computer_act', input, { ...opts, app: false })
  )
}

/** A call that is not a list of actions, as its one step: the apps call, a read. */
function wholeStep(tool: ComputerToolName, args: Record<string, unknown>, ctx: WordsContext, tense: StepTense, launched?: AppsOutcome): ComputerHistoryStep {
  const opts = { ...tenseOpts(tense), ...(launched ? { launched } : {}) }
  if (tool === 'computer_apps') {
    const phrase = computerPhrase(tool, args, opts)
    return stepOf('app', phrase, phrase)
  }
  return stepOf('read', computerPhrase(tool, args, { ...opts, ...(ctx.app ? { app: ctx.app } : {}) }), computerPhrase(tool, args, { ...opts, app: false }))
}

/** A batch as one row while it runs ("Working in Mail") or when it never finished ("Work in Mail"). */
export function workingStep(app: string, tense: StepTense): ComputerHistoryStep {
  const input = { app, actions: [] }
  const opts = tenseOpts(tense)
  return stepOf('click', computerPhrase('computer_batch', input, { ...opts, ...(app ? { app } : {}) }), computerPhrase('computer_batch', input, { ...opts, app: false }))
}

/** The call's steps as planned, present tense: what its start record holds. Words and targets are read from the book now, before the call's closing read replaces it. */
export function plannedSteps(tool: ComputerToolName, args: Record<string, unknown>, ctx: WordsContext): PlannedStep[] {
  const actions = callActions(tool, args)
  if (tool !== 'computer_act' && tool !== 'computer_batch')
    return [{ ...wholeStep(tool, args, ctx, 'live'), asked: wordsOf(wholeStep(tool, args, ctx, 'asked')), done: wordsOf(wholeStep(tool, args, ctx, 'done')) }]
  const brief = (i: number): ElementBrief | null => ctx.book?.brief(i) ?? null
  return actions.map((a, k) => {
    const target = stepTargetWords(actions, k, ctx.book)
    return {
      ...actionStep(a, ctx, 'live', brief),
      ...(target ? { target } : {}),
      ...(a.element !== undefined ? { element: a.element } : {}),
      asked: wordsOf(actionStep(a, ctx, 'asked', brief)),
      done: wordsOf(actionStep(a, ctx, 'done', brief))
    }
  })
}

/** The texts of a call that the secret rule keeps out of its steps: the journal takes them out of the read text it keeps too. */
export function maskedTexts(tool: ComputerToolName, args: Record<string, unknown>, ctx: WordsContext): string[] {
  const actions = callActions(tool, args)
  return actions.flatMap((a, k) => {
    const text = a.action === 'set_value' ? a.value : a.action === 'type' || a.action === 'paste' || a.action === 'select_text' ? a.text : undefined
    return text && !mayQuoteText(actions, k, ctx.book) ? [text] : []
  })
}

/** A step's row as one string, the app left out: "Click Save". */
export const wordsLine = (words: StepWords): string => [words.verb, words.object].filter(Boolean).join(' ')

/**
 * A batch's planned steps, one line each, as what is asked: "Click To",
 * "Type into Subject", "Press ⌘Return". They are the rows the batch settles
 * into, in the same words, so the list never says one step two ways; a
 * typed text is never in them (a row's words hold none). Undefined for any
 * other call.
 */
export function planWords(tool: ComputerToolName, planned: readonly PlannedStep[]): string[] | undefined {
  return tool === 'computer_batch' && planned.length > 1 ? planned.map((step) => wordsLine(step.asked)) : undefined
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} s`

/** A wait that ran out says so; one that settled says nothing. */
const waitFact = (w: WaitReport | undefined): string | null => (w && !w.settled ? `still changing after ${seconds(w.waitedMs)}` : null)

/** How a step that ran went, each a fact of one comma run; the plain case (`changed`, its own tier, no route) says nothing. */
export function resultFacts(step: Extract<StepResult, { status: 'ok' }>, action: ComputerAction): string[] {
  const facts: string[] = []
  if (action.action === 'wait') {
    const w = waitFact(step.waited)
    return w ? [w] : []
  }
  if (!sendsInput(action)) return facts
  if (step.effect !== 'changed') facts.push(COMPUTER_EFFECT_FACTS[step.effect])
  const disk = step.effect === 'uncommitted' || step.disk?.unknown ? null : diskWords(step.disk)
  if (disk) facts.push(disk)
  if (step.opened) facts.push(`opened ${JSON.stringify(step.opened.title)}`)
  const via = step.input?.via
  // a menu target already names its path
  const route = via && action.menu === undefined ? (COMPUTER_ROUTE_WORDS as Partial<Record<string, (on?: string) => string>>)[via] : undefined
  if (route) facts.push(route(via === 'menu' ? step.input?.on : undefined))
  return facts
}

/** What the front guard did when the app came forward (§23.5), to the person it happened to. */
export function frontFact(name: string, front: FrontReport | undefined, person?: string | null): string | null {
  if (!front?.raised) return null
  switch (front.restored) {
    case 'restored':
      return `${name} came to the front and ${person ?? 'your app'} was put back`
    case 'person-chose':
      return `${name} came to the front because you chose it`
    case 'failed':
      return `${name} came to the front and could not be put back`
    case 'hid-app':
      return `${name} kept coming to the front and was hidden`
    default:
      return `${name} came to the front`
  }
}

/** Why the focus stopped a text step, by the service's reason (§25.9, §27.7a): only one of them is a focus that moved. */
const FOCUS_WHY: Readonly<Record<string, string>> = {
  secure: 'A password field takes text only by its element',
  'browser-field': "The keys would have gone to the browser's own field",
  unplanned: 'Another field had the focus'
}

const SESSION_WHY: Readonly<Record<string, string>> = {
  locked: 'The screen was locked',
  'secure-input': 'A password field had the keyboard',
  'activation-refused': 'The app would not come forward',
  'in-use': 'Another app held the screen'
}

/** A line's first sentence, as a person's: up to its first `;`, a capital first. */
function firstSentence(line: string): string {
  const cut = line.split(';')[0].trim().replace(/[.:]+$/, '')
  return cut ? cut.charAt(0).toUpperCase() + cut.slice(1) : 'It failed'
}

/** Why a step failed, in a person's words: the kind's line, else the service's own sentence up to its first `;`. */
export function failureWords(error: ComputerError, ctx: ErrorContext = {}): string {
  if (error.kind === 'permission_missing') return error.which === 'screenRecording' ? 'Screen Recording was off' : 'Accessibility was off'
  if (error.kind === 'session_unavailable' && error.reason && SESSION_WHY[error.reason]) return SESSION_WHY[error.reason]
  if (error.kind === 'needs_tier' && error.needed === 'front') return 'It needed the app in front'
  if (error.kind === 'focus_moved' && error.reason && FOCUS_WHY[error.reason]) return FOCUS_WHY[error.reason]
  if (error.kind === 'named_target' && error.reason === 'several') return 'Several elements had that name'
  if (error.kind === 'stale_element' && error.reason === 'service-restarted') return COMPUTER_REFUSAL_WORDS.service_restarted
  return COMPUTER_FAILURE_WORDS[error.kind] ?? firstSentence(errorLine(error, ctx))
}

/** Why a call never ran: the host's kind in a person's words, else the line's first sentence. */
export function refusalWords(kind: HostErrorKind | undefined, line?: string): string {
  return (kind && COMPUTER_REFUSAL_WORDS[kind]) || firstSentence(line ?? '')
}

/** What a call's journal entry needs of how it ended (computer/run.ts fills it). */
export interface SettleInput {
  tool: ComputerToolName
  args: Record<string, unknown>
  ctx: WordsContext
  /** the start record's steps: their words and targets were read from the book before the call ran */
  planned?: readonly PlannedStep[]
  /** the service's results, one per action in the actions' order: `not-run` (or none) where no answer came */
  results?: readonly StepResult[]
  /** the closing read's wait */
  waited?: WaitReport
  front?: FrontReport
  /** the person's app, for the front fact */
  person?: string | null
  /** menus the call opened and could not close (§26.11) */
  menusLeftOpen?: readonly string[]
  /** nothing ran, or the call threw: the host refused, by kind where it has one */
  refused?: { kind?: HostErrorKind; line: string }
  /** a request failed whole */
  error?: ComputerError
  /** the call threw (a host error, a service that went): `refused` ends the first step with no answer, whatever ran before */
  threw?: boolean
  /** the closing read failed with the service's own error after the steps answered */
  unread?: ComputerError
  /** the browser tab the host selected for the call, as the read that followed names it */
  selectedTab?: string
  /** the call's signal fired: its reason (`stopped`, `interrupt`, `paused`, …) */
  abort?: string
  /** computer_apps: what the launch did */
  launched?: AppsOutcome
  /** why the tier gate refused a step, by the step's index (scheduleRules.ts `SESSION_REFUSALS`) */
  gate?: Readonly<Record<number, string>>
}

/** How a step that was waiting (for the Mac, for the clipboard) or running answers when its call is aborted. */
const ABORTED_AS: ReadonlySet<ComputerError['kind']> = new Set<ComputerError['kind']>(['cancelled', 'needs_tier', 'clipboard_busy'])
const isTextStep = (a: ComputerAction): boolean => a.action === 'type' || a.action === 'paste' || a.action === 'set_value' || a.action === 'select_text'

/**
 * How a step the tier gate refused ended, by the gate's own reason. Every reason the gate has is here (a new one
 * fails the typecheck), so no refusal of the gate's leaves a step without its why: a card not taken and a call
 * given up are stops; a locked screen, a sleeping Mac and a host with nothing to schedule the step are failures.
 */
const GATE_END: Readonly<Record<SessionTierRefusal, Pick<ComputerHistoryStep, 'state' | 'reason'>>> = {
  skipped: { state: 'stopped', reason: COMPUTER_SKIPPED_WORDS },
  'skipped-earlier': { state: 'stopped', reason: COMPUTER_SKIPPED_WORDS },
  cancelled: { state: 'stopped', reason: COMPUTER_REFUSAL_WORDS.cancelled },
  'screen-locked': { state: 'failed', reason: 'The screen was locked' },
  asleep: { state: 'failed', reason: 'The Mac was asleep' },
  'no-scheduler': { state: 'failed', reason: COMPUTER_FAILURE_WORDS.needs_tier }
}

/** How a step the gate refused ended; null for a step the gate did not refuse. */
function gateEnd(reason: string | undefined): Pick<ComputerHistoryStep, 'state' | 'reason'> | null {
  return reason !== undefined && Object.hasOwn(GATE_END, reason) ? GATE_END[reason as SessionTierRefusal] : null
}

/** The refusals that are the person's own doing or the thread's: a stop, not a failure, so never the red. */
const STOPPED_REFUSALS: ReadonlySet<HostErrorKind> = new Set<HostErrorKind>(['stopped', 'paused', 'cancelled', 'denied', 'away'])

/** How the whole call ended when nothing of it ran to an answer: stopped, refused or failed, with its line; null when it ran. */
function callEnd(s: SettleInput): Pick<ComputerHistoryStep, 'state' | 'reason'> | null {
  if (s.abort) return { state: 'stopped', reason: COMPUTER_ABORT_WORDS[s.abort] ?? COMPUTER_REFUSAL_WORDS.cancelled }
  if (s.refused) return { state: s.refused.kind && STOPPED_REFUSALS.has(s.refused.kind) ? 'stopped' : 'failed', reason: refusalWords(s.refused.kind, s.refused.line) }
  if (s.error) return { state: 'failed', reason: failureWords(s.error, { app: s.ctx.app || undefined }) }
  return null
}

/** The browser tab the host selected for the call (§25): it changed what the person's window shows. */
const tabFact = (tab: string | undefined): string | null => (tab !== undefined ? `selected the tab ${JSON.stringify(tab)}` : null)

/** The fact on a launch whose call ended before the apps were listed. */
const APPS_UNLISTED = 'the list of apps could not be read after it'

/**
 * The call's steps as they ended, one per action: `ok` in the past tense
 * with its tier and facts; `failed` with why, `stopped` or `not-run` as what
 * was asked. A call that was refused, failed whole or stopped before any
 * step answered says so on its first step and leaves the rest not run.
 */
export function settledSteps(s: SettleInput): ComputerHistoryStep[] {
  const end = callEnd(s)
  if (s.tool !== 'computer_act' && s.tool !== 'computer_batch') {
    // an app the call's launch brought forward came forward whatever the call did after
    const front = frontFact(s.ctx.app || (typeof s.args.launch === 'string' ? s.args.launch : '') || 'The app', s.front, s.person)
    // a launch or an open the service answered happened, whatever the list after it did: only the list is lost
    if (end && s.tool === 'computer_apps' && (s.launched?.launched || s.launched?.opened))
      return [{ ...wholeStep(s.tool, s.args, s.ctx, 'done', s.launched), state: 'ok', facts: [...(front ? [front] : []), APPS_UNLISTED] }]
    const step = wholeStep(s.tool, s.args, s.ctx, end ? 'asked' : 'done', s.launched)
    const w = !end && s.tool === 'computer_observe' ? waitFact(s.waited) : null
    const facts = [tabFact(s.selectedTab), w, front].filter((f): f is string => f !== null)
    return [{ ...step, ...(end ?? { state: 'ok' as const }), ...(facts.length ? { facts } : {}) }]
  }
  const actions = callActions(s.tool, s.args)
  const ran = s.results?.some((r) => r.status !== 'not-run') === true
  let ended = false
  const steps = actions.map((a, k): ComputerHistoryStep => {
    const r = s.results?.[k]
    const resolved = r?.status === 'ok' && r.element ? r.element : undefined
    const brief = (i: number): ElementBrief | null => (resolved?.index === i ? resolved : (s.ctx.book?.brief(i) ?? null))
    const plan = s.planned?.[k]
    const tense: StepTense = r?.status === 'ok' ? 'done' : 'asked'
    // the planned words and target were read before the call moved the book; a `named` step's element is known only now
    const words: ComputerHistoryStep = plan && !resolved ? { kind: plan.kind, ...plan[tense] } : actionStep(a, s.ctx, tense, brief)
    const target = plan?.target ?? (resolved ? stepTargetWords(actions, k, s.ctx.book, resolved) : undefined) ?? stepTargetWords(actions, k, s.ctx.book)
    const element = a.element ?? (r?.status === 'ok' ? r.resolved : undefined)
    const base = { ...words, ...(target ? { target } : {}), ...(element !== undefined ? { element } : {}) }
    // A text step whose field is known only now (named by name, or found by focus) and is a password field: its
    // planned target was a length, made before anyone knew; not even that is kept.
    const passwordTarget = (found: ElementBrief | undefined): { target?: string } =>
      isTextStep(a) && isPasswordLine(found?.line) ? { target: 'a password' } : {}
    if (r?.status === 'ok') {
      const facts = resultFacts(r, a)
      return { ...base, ...passwordTarget(r.element), state: 'ok', ...(r.tier ? { tier: r.tier } : {}), ...(facts.length ? { facts } : {}) }
    }
    if (r?.status === 'failed') {
      ended = true
      // the person's touch stops a step; so does the call's own abort, which the service answers as cancelled, and
      // which a step still held for the Mac or the clipboard answers as the hold's own refusal
      if (r.error.kind === 'interrupted') return { ...base, ...passwordTarget(r.error.focused), state: 'stopped', reason: COMPUTER_FAILURE_WORDS.interrupted }
      if (s.abort && ABORTED_AS.has(r.error.kind)) return { ...base, state: 'stopped', reason: COMPUTER_ABORT_WORDS[s.abort] ?? COMPUTER_REFUSAL_WORDS.cancelled }
      // a step the gate refused says why the gate did: Skip is the person's own no, a locked screen is a locked screen
      const gated = gateEnd(s.gate?.[k])
      if (gated) return { ...base, ...gated }
      return { ...base, ...passwordTarget(r.error.focused), state: 'failed', reason: failureWords(r.error, { app: s.ctx.app || undefined, action: a, step: true }) }
    }
    // nothing answered for this step: the call's own end is said once, on the first of them. A refusal or a failed
    // request is the call's end only when no step ran; a stop ends it wherever it was
    // (a step the gate refused before anything of it ran, the browser tab's hold, says the gate's own reason)
    const gated = !ended && !s.abort ? gateEnd(s.gate?.[k]) : null
    if (gated) {
      ended = true
      return { ...base, ...gated }
    }
    // (a request that failed or threw after earlier ones of the batch answered ends the first step it held, and
    // leaves those that ran as they ran)
    if (!ended && end && (!ran || s.abort || s.error || s.threw)) {
      ended = true
      return { ...base, ...end }
    }
    return { ...base, state: 'not-run' }
  })
  // what the call says of itself goes on the last step that ran
  const last = steps.findLastIndex((st) => st.state === 'ok')
  if (last >= 0) {
    // every step answered and the call still failed (the service went during the closing read): the steps ran, and
    // the end the model was told has no step of its own to stand on
    // (or the service answered the closing read with an error of its own, which the model was told)
    const why = s.unread ? failureWords(s.unread, { app: s.ctx.app || undefined }) : end && !ended && !s.abort && (s.threw || s.error) ? end.reason : undefined
    const unread = why ? `the window was not read after it: ${why.charAt(0).toLowerCase()}${why.slice(1)}` : null
    const extra = [
      tabFact(s.selectedTab),
      waitFact(s.waited),
      frontFact(s.ctx.app || 'The app', s.front, s.person),
      s.menusLeftOpen?.length ? `left the menu ${s.menusLeftOpen.join(', ')} open` : null,
      unread
    ].filter((f): f is string => f !== null)
    if (extra.length) steps[last] = { ...steps[last], facts: [...(steps[last].facts ?? []), ...extra] }
  }
  return steps
}

// ── what the model read ─────────────────────────────────────────────────

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * What a read took in, as the open row's read line: "Read 46 elements",
 * "Read 3 changes", "Read no changes", or "Looked at the picture" when the
 * tree was too thin to act from and a picture did reach the model
 * (`sawPicture`); a thin tree with no picture is the few elements it read.
 * `more` says the text holds more than its header, so the line opens onto it.
 */
export function readSummary(text: string, sawPicture = false): { words: string; more: boolean } {
  let parsed: ReturnType<typeof parseObservation>
  try {
    parsed = parseObservation(text)
  } catch {
    return { words: 'Read the window', more: text.includes('\n') }
  }
  const { header, lines } = parsed
  const more = lines.length > 0
  const tail = header.loading ? ', still loading' : header.notDrawn ? ', page not drawn' : ''
  if (header.thin && sawPicture) return { words: 'Looked at the picture', more }
  if (header.change === 'unchanged') return { words: `Read no changes${tail}`, more }
  if (header.change === 'diff') {
    // a removed, changed or added group each counts once
    const changes =
      lines.filter((l) => l.type === 'added' || ((l.type === 'element' || l.type === 'range') && l.marker !== undefined)).length + (header.document?.changed ? 1 : 0)
    return { words: `Read ${changes ? count(changes, 'change') : 'the changes'}${tail}`, more }
  }
  let elements = 0
  for (const l of lines) {
    if (l.type === 'element') elements += 1
    else if (l.type === 'range') elements += l.last - l.first + 1
    else if (l.type === 'menuBar') elements += 1 + l.items.length
  }
  return { words: `Read ${count(elements, 'element')}${tail}`, more }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** The read text as the journal keeps it: whole up to `max` UTF-8 bytes, else cut at a character, at a line where it has one, with a last line that says so. */
export function cutReadText(text: string, max = READ_TEXT_MAX_BYTES): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= max) return text
  let end = max
  // never inside a character: step back off its continuation bytes
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  let kept = decoder.decode(bytes.subarray(0, end))
  const line = kept.lastIndexOf('\n')
  if (line > 0) kept = kept.slice(0, line)
  const left = text.slice(kept.length).split('\n').filter(Boolean).length
  return `${kept}\n… cut here, ${count(left, 'more line')}`
}

/** A text worth taking out: shorter ones are words any window holds. */
const SCRUB_MIN = 4

/** A quoted string as an observation prints one. */
const QUOTED = /"(?:[^"\\]|\\.)*"/g
/** A value the service cut: its first scalars, then how many more it has (observation.ts `cutValue`); a name it cut ends in the ellipsis alone. */
const CUT = /^([\s\S]*)…(?:\(\+(\d+) chars\))?$/

/**
 * The read text with the call's held-back texts taken out: each place one
 * stands, as typed or as the observation escapes it, reads as its length.
 * The service prints a long value cut (its first scalars and a count of
 * the rest, fewer still when the read is over its budget): a quoted value
 * that is the start of a held-back text, cut, goes whole too. The step
 * said only how long the text was; the field's value in the read that
 * follows must not say more.
 */
export function scrubReadText(text: string, masked: readonly string[]): string {
  // the longest first, so a text that holds another goes whole
  const secrets = [...new Set(masked)].filter((s) => [...s].length >= SCRUB_MIN).sort((a, b) => b.length - a.length)
  if (!secrets.length) return text
  const mark = (secret: string): string => `‹${count([...secret].length, 'character')}›`
  let out = text
  for (const secret of secrets) for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join(mark(secret))
  return out.replace(QUOTED, (literal) => {
    let value: string
    try {
      value = JSON.parse(literal) as string
    } catch {
      return literal
    }
    const cut = CUT.exec(value)
    if (!cut) return literal
    const [, shown, rest] = cut
    const hit = secrets.find((secret) => {
      if (!shown || !secret.startsWith(shown) || secret === shown) return false
      // a cut value says how many scalars it left out; a cut name says nothing, and must show enough to be the text
      return rest !== undefined ? [...secret].length - [...shown].length === Number(rest) : [...shown].length >= SCRUB_MIN
    })
    return hit ? JSON.stringify(mark(hit)) : literal
  })
}
