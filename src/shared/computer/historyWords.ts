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
import { diskWords, menuPathSegments, type ComputerToolName } from './tools'
import { actionWords, computerPhrase, type AppsOutcome, type ComputerPhrase } from './words'

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
const isPasswordLine = (line: string): boolean => line === 'password' || line.startsWith('password ')

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

const quoteShort = (text: string): string => {
  const s = [...text]
  return JSON.stringify(s.length > TEXT_FACT_MAX ? s.slice(0, TEXT_FACT_MAX).join('') + '…' : text)
}

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
  switch (a.action) {
    case 'type':
    case 'paste':
      return textFact(a.text ?? '', mayQuoteText(actions, k, book))
    case 'select_text':
      return a.text !== undefined ? textFact(a.text, mayQuoteText(actions, k, book)) : element()
    case 'set_value':
      return textFact(a.value ?? '', mayQuoteText(actions, k, book))
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

/** A batch's planned steps in the card's words, each through the secret rule; undefined for any other call. */
export function planWords(tool: ComputerToolName, args: Record<string, unknown>, ctx: WordsContext): string[] | undefined {
  if (tool !== 'computer_batch') return undefined
  const actions = callActions(tool, args)
  if (actions.length < 2) return undefined
  return actions.map((a, k) =>
    actionWords(safeAction(a), {
      appName: ctx.app,
      window: null,
      element: (i) => ctx.book?.brief(i) ?? null,
      maskText: !mayQuoteText(actions, k, ctx.book)
    })
  )
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
  /** the service's results, one per action that got one */
  results?: readonly StepResult[]
  /** the closing read's wait */
  waited?: WaitReport
  front?: FrontReport
  /** the person's app, for the front fact */
  person?: string | null
  /** menus the call opened and could not close (§26.11) */
  menusLeftOpen?: readonly string[]
  /** nothing ran: the host refused, by kind where it has one */
  refused?: { kind?: HostErrorKind; line: string }
  /** a request failed whole */
  error?: ComputerError
  /** the call's signal fired: its reason (`stopped`, `interrupt`, `paused`, …) */
  abort?: string
  /** computer_apps: what the launch did */
  launched?: AppsOutcome
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

/**
 * The call's steps as they ended, one per action: `ok` in the past tense
 * with its tier and facts; `failed` with why, `stopped` or `not-run` as what
 * was asked. A call that was refused, failed whole or stopped before any
 * step answered says so on its first step and leaves the rest not run.
 */
export function settledSteps(s: SettleInput): ComputerHistoryStep[] {
  const end = callEnd(s)
  if (s.tool !== 'computer_act' && s.tool !== 'computer_batch') {
    const step = wholeStep(s.tool, s.args, s.ctx, end ? 'asked' : 'done', s.launched)
    const w = s.tool === 'computer_observe' ? waitFact(s.waited) : null
    return [{ ...step, ...(end ?? { state: 'ok' as const }), ...(!end && w ? { facts: [w] } : {}) }]
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
    if (r?.status === 'ok') {
      const facts = resultFacts(r, a)
      return { ...base, state: 'ok', ...(r.tier ? { tier: r.tier } : {}), ...(facts.length ? { facts } : {}) }
    }
    if (r?.status === 'failed') {
      ended = true
      // the person's touch stops a step; so does the call's own abort, which the service answers as cancelled
      if (r.error.kind === 'interrupted') return { ...base, state: 'stopped', reason: COMPUTER_FAILURE_WORDS.interrupted }
      if (s.abort && r.error.kind === 'cancelled') return { ...base, state: 'stopped', reason: COMPUTER_ABORT_WORDS[s.abort] ?? COMPUTER_REFUSAL_WORDS.cancelled }
      return { ...base, state: 'failed', reason: failureWords(r.error, { app: s.ctx.app || undefined, action: a, step: true }) }
    }
    // nothing answered for this step: the call's own end is said once, on the first of them. A refusal or a failed
    // request is the call's end only when no step ran; a stop ends it wherever it was
    if (!ended && end && (!ran || s.abort)) {
      ended = true
      return { ...base, ...end }
    }
    return { ...base, state: 'not-run' }
  })
  // what the call says of itself goes on the last step that ran
  const last = steps.findLastIndex((st) => st.state === 'ok')
  if (last >= 0) {
    const extra = [
      waitFact(s.waited),
      frontFact(s.ctx.app || 'The app', s.front, s.person),
      s.menusLeftOpen?.length ? `left the menu ${s.menusLeftOpen.join(', ')} open` : null
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

/**
 * The read text with the call's held-back texts taken out: each place one
 * stands, as typed or as the observation escapes it, reads as its length.
 * The step said only how long the text was; the field's value in the read
 * that follows must not say more.
 */
export function scrubReadText(text: string, masked: readonly string[]): string {
  let out = text
  // the longest first, so a text that holds another goes whole
  for (const secret of [...new Set(masked)].sort((a, b) => b.length - a.length)) {
    const n = [...secret].length
    if (n < SCRUB_MIN) continue
    const mark = `‹${count(n, 'character')}›`
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) out = out.split(form).join(mark)
  }
  return out
}
