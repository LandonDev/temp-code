import type { z } from 'zod'
import {
  COMPUTER_WAIT,
  NO_INPUT_ACTIONS,
  actionElements,
  waitActionWait,
  type AppRef,
  type AppInfo,
  type ComputerAction,
  type ComputerError,
  type ComputerMethod,
  type ComputerParams,
  type ComputerResult,
  type FrontReport,
  type IgnoredRoutes,
  type Observation,
  type PermissionName,
  type Prior,
  type StepResult,
  type Tier
} from '@shared/computer/protocol'
import { buildPrior, lastInputEffect } from '@shared/computer/batchStop'
import { COMPUTER_ACTIONS, COMPUTER_TOOLS, formatStepLine, mayRunAtAx, type ActionClass, type ComputerToolName } from '@shared/computer/tools'
import { actionWords, asFourTool, computerActivity, computerApprovalInput, computerApprovalTitle, needsApproval, type AppsOutcome, type TitleContext } from '@shared/computer/words'
import { errorLine, type ErrorContext } from '@shared/computer/errorWords'
import { hostErrorLine, noObservationLine, noReadForTextLine, sessionRefusedLine } from '@shared/computer/hostErrors'
import { maskedTexts, planWords, plannedSteps, readSummary, scrubReadText, settledSteps, type PlannedStep } from '@shared/computer/historyWords'
import { approvalLine } from '@shared/approvalLine'
import { formatHeldLine } from '@shared/computer/scheduleRules'
import { LOCAL_CARD_WORDS, READER_WAIT_WORDS, UNREAD_WORDS } from '@shared/computer/heldCalls'
import { awayAllowsKind } from '@shared/away'
import type { PermissionPolicy, SessionMeta } from '@shared/events'
import type { ApprovalRequest } from '../drivers/types'
import { computerAxWaits, planBatch, stoppedBefore, type AxWaitRows } from './batchPlan'
import { ComputerHostError, ComputerRpcError } from './connection'
import { ElementBook } from './elements'
import {
  REFUSED_LAUNCH_BUNDLES,
  passwordTarget,
  refusedLaunch,
  refusedOpenItem,
  refusedTarget,
  type Resolved,
  type TargetResolver
} from './policy'
import {
  formatAppsList,
  frontLine,
  mergeFront,
  outcomeOf,
  refusal,
  refusalOf,
  refused,
  type ComputerToolOutcome,
  type LandedShot,
  type LaunchReport,
  type StepsResult
} from './result'
import type { ComputerService } from './service'
import type { ComputerHistory, HistoryEntry, PictureTarget } from './history'
import type { CallReader } from './pending'
import { landShot, nextShotNumber } from './shots'
import type { SessionTierGate, TierDecision, TierGateContext } from './tierGate'
import type { Admitted, SettingsStore, TierVerdicts } from './verdicts'
import type { CallTiming } from '@shared/computer/bridgeTiming'

/**
 * One computer call, start to end (docs/computer-protocol.md "Sessions" and
 * "Permission and Stop"): normalize and check the arguments, refuse what may
 * not run, ask the card in safe and edits, open the thread's service session,
 * resolve the target, probe an app once, run the actions in segments (a step
 * that needs the session tier goes to the gate, a key-window failure is
 * retried once at the next tier), learn the verdicts, land the pictures and
 * build the outcome. ComputerSessions runs it behind each thread's queue.
 */

export interface ComputerToolContext {
  threadId: string
  /** read inside the queue, right before the card; default the registry's live row */
  permission?: () => PermissionPolicy
  /** claude's tool_use id: the card sits under the tool's row */
  callId?: string
  /** claude's extra.signal, the bridge's cancel, a closed bridge socket */
  signal?: AbortSignal
  /** how a card is asked; default registry.requestApproval for this host's threads. The tier gate's own ask past its bound uses it too. */
  approve?: (req: ApprovalRequest) => Promise<boolean>
  /** the thread's root for the tier gate; default the host's rootOf (a box thread on the Mac: macComputerKey(box, root)) */
  rootId?: string
  /**
   * A bridged call (pending.ts): every service request waits for someone to
   * read the call's answer; Claude's calls carry none and pay nothing.
   */
  reader?: Pick<CallReader, 'present' | 'whenPresent' | 'request'>
  /** the call's tally (shared/computer/bridgeTiming.ts): each service request's round trip, each observation's wait */
  timing?: CallTiming
  /** a bridged call's turn, as its box named it: the journal groups the thread's calls by it (computer/history.ts) */
  turn?: string
}

export interface ComputerRegistry {
  get(sessionId: string): SessionMeta | null
  requestApproval(sessionId: string, req: ApprovalRequest): Promise<boolean>
  awayOn(): boolean
}

export interface AppState {
  key: string
  pid: number
  bundleId: string | null
  name: string
  /** of the last observation the model got */
  epoch: string
  seq: number
  /** the window this thread last used in the app */
  window: { id: number; title: string } | null
  thin: boolean
  /** the service returned an observation the model never saw: the next read is full */
  needsFull: boolean
  book: ElementBook
}

export interface ThreadComputer {
  threadId: string
  serviceSession: string
  /** the epoch session.open last ran in */
  openedIn: string | null
  apps: Map<string, AppState>
  /** The last apps list this thread saw, for tab names on its card. */
  listedApps?: AppInfo[]
  /** the model's `app` strings, lower-cased → key */
  aliases: Map<string, string>
  /** app keys, last used first */
  used: string[]
  queue: Promise<unknown>
  live: {
    since: number
    lastCallAt: number
    running: { tool: string; words: string; startedAt: number } | null
    tier: Tier | null
    /** the running call is held for the session tier or the clipboard (schedule.ts): the row says this instead */
    held?: string | null
    /** a card of this host's own thread waits: its title as a question (the row's `asking`) */
    asking?: string | null
  } | null
  /** Stop this turn */
  stopped: boolean
  /** the call in flight (the queue runs one at a time) */
  inflight: AbortController | null
  /** the thread ended: calls still queued answer cancelled and send nothing */
  ended: boolean
  idleTimer: unknown
  nextShot: number | null
  /** steals the front guard undid after their call answered (apps/frontRestored): said once, in the thread's next result */
  pendingFront: string[]
}

export interface RunHost {
  service: ComputerService
  verdicts: TierVerdicts
  gate(): SessionTierGate
  registry: ComputerRegistry
  store: SettingsStore
  resolveApp?: (query: string) => AppRef | null
  /** the call's app pinned to a pid, the list cached until apps/changed */
  targets: TargetResolver
  landing(threadId: string): string
  rootOf(threadId: string): string
  now(): number
  log(line: string): void
  /** the thread's live row moved */
  touched(t: ThreadComputer): void
  /** the thread's journal (history.ts); without it nothing is journaled, as in every script and test that builds its own sessions */
  history?: ComputerHistory
}

/** What a call's journal entry needs of how it went: runChecked and runApps fill it as they go, runComputerTool writes it. */
interface CallNote {
  /** the service's results, one per action that got one */
  results?: StepResult[]
  /** the call's closing read, whether or not the model got it: the picture is of the window it names */
  observation?: Observation
  front?: FrontReport
  /** the person's app, for the front fact */
  person?: string | null
  menusLeftOpen?: string[]
  /** a request failed whole */
  error?: ComputerError
  /** computer_apps: what the launch did */
  launched?: AppsOutcome
}

/** A finished call's journal entry and the window to picture, handed to the thread's queue (sessions.ts). */
export type JournalDone = (entry: HistoryEntry, target: PictureTarget | null) => void

/** Where a person turns a grant on, said once per install with the first refusal. */
export const PERMISSION_SWITCH: Readonly<Record<PermissionName, string>> = {
  accessibility: 'turn on TempCode under System Settings → Privacy & Security → Accessibility',
  screenRecording: 'turn on TempCode under System Settings → Privacy & Security → Screen & System Audio Recording'
}
export const permissionPromptedSetting = (which: PermissionName): string => `computer.prompted.${which}`

const ABORT_WORDS: Record<string, string> = {
  stopped: hostErrorLine('stopped'),
  paused: hostErrorLine('cancelled', 'the thread was paused'),
  interrupt: hostErrorLine('cancelled', 'the turn was stopped'),
  ended: hostErrorLine('cancelled', 'the thread ended'),
  settled: hostErrorLine('cancelled', 'the turn ended'),
  unread: hostErrorLine('cancelled', UNREAD_WORDS),
  superseded: hostErrorLine('cancelled', 'a later computer call replaced it'),
  cancel: hostErrorLine('cancelled', 'computer_result cancelled it')
}

/** The line a call answers once its signal fired, or null while it runs on. */
export function abortedLine(signal: AbortSignal | undefined): string | null {
  if (!signal?.aborted) return null
  return (typeof signal.reason === 'string' && ABORT_WORDS[signal.reason]) || hostErrorLine('cancelled', 'the call was given up')
}

const issueWords = (error: z.ZodError): string => {
  const i = error.issues[0]
  return i ? `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` : 'refused'
}

const shotPolicy = (screenshot: boolean | undefined): 'always' | 'never' | 'auto' =>
  screenshot === true ? 'always' : screenshot === false ? 'never' : 'auto'

const sendsInput = (a: ComputerAction): boolean => !NO_INPUT_ACTIONS.includes(a.action)
const classOf = (a: ComputerAction): ActionClass | null => COMPUTER_ACTIONS[a.action].class

export function lookupApp(t: ThreadComputer, query: string): AppState | undefined {
  const q = query.toLowerCase()
  return t.apps.get(t.aliases.get(q) ?? q)
}

type Args = Record<string, unknown> & {
  app?: string
  window?: string
  screenshot?: boolean
  action?: ComputerAction['action']
  actions?: ComputerAction[]
}

/** A known unselected tab, after exact window matches and before substring window matches. */
function knownTab(t: ThreadComputer, query: string | undefined, ref: string | undefined): { title: string; window: string } | null {
  if (!query || !ref) return null
  const known = lookupApp(t, query)
  const app = t.listedApps?.find((a) =>
    known ? a.pid === known.pid : [a.name, a.bundleId].some((s) => s?.toLowerCase() === query.toLowerCase())
  )
  const windows = app?.windows ?? []
  if (windows.some((w) => w.title === ref)) return null
  const tabs = windows.flatMap((w) => (w.tabs ?? []).map((tab) => ({ ...tab, window: w.title })))
  const exact = tabs.find((tab) => tab.title === ref)
  const match = exact ?? (windows.some((w) => w.title.includes(ref)) ? undefined : tabs.find((tab) => tab.title.includes(ref)))
  return match && !match.selected ? { title: match.title, window: match.window } : null
}

/** What every targeted request carries (protocol.ts TargetSchema). */
interface TargetBase {
  session: string
  app: AppRef
  window?: { id: number } | { title: string }
  launch: boolean
  epoch?: string
}
type Targeted = <M extends ComputerMethod>(method: M, params: (target: TargetBase) => ComputerParams<M>) => Promise<ComputerResult<M>>

/**
 * Step 1 of a call, on its own (the Mac bridge's box side checks a call with
 * it before it crosses): a per-verb name becomes `computer_act` with its
 * action, `confirm` kept, and the tool's full schema parses the arguments.
 * Where text with no target goes is the service's to judge (§27.7).
 */
export function checkComputerCall(toolName: string, rawArgs: unknown): { ok: true; tool: ComputerToolName; args: Record<string, unknown> } | { ok: false; line: string } {
  const four = asFourTool(toolName, rawArgs)
  if (!four) return { ok: false, line: hostErrorLine('invalid_args', `no computer tool is called ${toolName}`) }
  const spec = COMPUTER_TOOLS.find((s) => s.name === four.tool)!
  const parsed = spec.input.safeParse(four.args)
  if (!parsed.success) return { ok: false, line: hostErrorLine('invalid_args', issueWords(parsed.error)) }
  return { ok: true, tool: four.tool, args: parsed.data as Args }
}

export async function runComputerTool(
  host: RunHost,
  t: ThreadComputer,
  ctx: ComputerToolContext,
  toolName: string,
  rawArgs: unknown,
  signal: AbortSignal,
  journaled?: JournalDone
): Promise<ComputerToolOutcome> {
  // 1. normalize and check
  const checked = checkComputerCall(toolName, rawArgs)
  if (!checked.ok) return refusal(checked.line)
  const tool = checked.tool
  const args = checked.args as Args
  const known = args.app ? lookupApp(t, args.app) : undefined

  // the journal's start, with the steps as planned: their targets are read from the book now, before the call's
  // closing read replaces it. A call refused below is journaled too, as a start and its end at once.
  const note: CallNote = {}
  const words = { app: known?.name ?? args.app ?? '', ...(known ? { book: known.book } : {}) }
  let planned: PlannedStep[] = []
  let masked: string[] = []
  let entry: HistoryEntry | null = null
  if (host.history) {
    try {
      planned = plannedSteps(tool, args, words)
      masked = maskedTexts(tool, args, words)
      const plan = planWords(tool, planned)
      entry = host.history.begin(t.threadId, {
        app: words.app,
        window: args.window ?? known?.window?.title ?? null,
        steps: planned.map(({ done: _done, ...step }) => step),
        ...(plan ? { plan } : {}),
        ...(ctx.turn !== undefined ? { token: ctx.turn } : {})
      })
    } catch (e) {
      host.log(`computer history: the start of a call was not written: ${(e as Error).message}`)
    }
  }
  /** The entry's end, from the note and the outcome; nothing it does reaches the answer. */
  const settle = (out: ComputerToolOutcome | undefined): void => {
    if (!entry) return
    const obs = note.observation
    try {
      const after = args.app ? lookupApp(t, args.app) : undefined
      // an abort with no reason of its own (a harness that gave the call up, a dropped bridge) is not the model's cancel
      const abort = signal.aborted ? (typeof signal.reason === 'string' ? signal.reason : 'aborted') : undefined
      // the model reads the closing observation only when it is the answer's body, and looked at a picture only when one came with it
      const read = obs && out?.body === obs.text ? readSummary(obs.text, out.shots.length > 0) : null
      const app = obs?.app.name ?? after?.name ?? words.app
      void entry.end({
        app,
        window: obs?.window.title ?? after?.window?.title ?? args.window ?? null,
        steps: settledSteps({
          tool,
          args,
          ctx: { app, ...(after ? { book: after.book } : {}) },
          planned,
          ...(note.results ? { results: note.results } : {}),
          ...(obs?.waited ? { waited: obs.waited } : {}),
          ...(note.front ? { front: note.front } : {}),
          person: note.person ?? null,
          ...(note.menusLeftOpen ? { menusLeftOpen: note.menusLeftOpen } : {}),
          ...(!out || (out.isError && !note.results?.length && !note.error) ? { refused: { ...(out?.refused ? { kind: out.refused } : {}), line: out?.body ?? '' } } : {}),
          ...(note.error ? { error: note.error } : {}),
          ...(abort ? { abort } : {}),
          ...(note.launched ? { launched: note.launched } : {})
        }),
        ...(read ? { read: read.words } : {}),
        // a text the steps held back is held back here too
        ...(read?.more ? { text: scrubReadText(obs!.text, masked) } : {})
      })
    } catch (e) {
      host.log(`computer history: the end of a call was not worded: ${(e as Error).message}`)
      // the call did end: its entry ends too, as what was asked, so no reader goes on showing it as running
      // (how it went is not known here: the first step says so, the rest read as not run, as for a refused call)
      void entry.end({
        app: words.app,
        window: args.window ?? null,
        steps: planned.map(({ asked, done: _done, ...step }, k) => ({ ...step, ...asked, ...(k === 0 ? { state: 'failed' as const, reason: 'It failed' } : { state: 'not-run' as const }) }))
      })
    }
    journaled?.(entry, obs ? { session: t.serviceSession, pid: obs.app.pid, windowId: obs.window.id, width: obs.space.width, height: obs.space.height, epoch: obs.epoch } : null)
  }

  // 2. refusals before anything
  const meta = host.registry.get(ctx.threadId)
  const aborted = abortedLine(signal)
  const unavailable = aborted || t.stopped || meta?.status === 'paused' ? null : host.service.unavailableReason()
  const early = aborted
    ? refusal(aborted)
    : t.stopped
      ? refused('stopped')
      : meta?.status === 'paused'
        ? refused('paused')
        : unavailable
          ? refused('service_unavailable', unavailable)
          : null
  if (early) {
    settle(early)
    return early
  }

  const now = host.now()
  t.live = t.live ?? { since: now, lastCallAt: now, running: null, tier: null }
  // the words name the element from the thread's book: "Clicking Save in TextEdit"
  const activity = computerActivity(tool, args, (i) => known?.book.brief(i) ?? null, known?.name)?.text
  t.live.running = { tool, words: activity ?? 'Using the computer', startedAt: now }
  host.touched(t)
  let out: ComputerToolOutcome | undefined
  try {
    out = await runChecked(host, t, ctx, tool, args, signal, note)
    if (t.pendingFront.length) {
      const late = t.pendingFront.splice(0)
      out = { ...out, steps: [...out.steps, ...late] }
    }
    return out
  } finally {
    if (t.live) {
      t.live.running = null
      t.live.held = null
      t.live.asking = null
      t.live.lastCallAt = host.now()
    }
    host.touched(t)
    settle(out)
  }
}

async function runChecked(
  host: RunHost,
  t: ThreadComputer,
  ctx: ComputerToolContext,
  tool: ComputerToolName,
  args: Args,
  signal: AbortSignal,
  note: CallNote
): Promise<ComputerToolOutcome> {
  const threadId = ctx.threadId
  const app = (): AppState | undefined => (args.app ? lookupApp(t, args.app) : undefined)
  const steps = actionsOf(tool, args)
  const readFocus = app()?.book.focused ?? null

  // read first: an element, or text, needs a read of the app in this thread
  const named =
    tool === 'computer_observe' ? (args.element !== undefined ? [args.element as number] : []) : steps.flatMap(actionElements)
  if (named.length && !app()) return refused('no_observation', noObservationLine(named[0], args.app!))
  if (steps.some((s) => s.action === 'type' || s.action === 'paste') && !app()) return refused('no_observation', noReadForTextLine(args.app!))
  // text with no target goes to the window the thread read: the service judges a named window by its live titles (§27.6)
  const blindText = steps.some((s) => (s.action === 'type' || s.action === 'paste') && s.element === undefined && s.named === undefined)
  // with no window read (it closed), the service has no id to hold text into a named window to: refused as before
  if (args.window && blindText && !app()?.window) return refused('no_observation', noReadForTextLine(args.app!, args.window))

  // an app no call may touch, or an item that is no page, file or folder: refused before the card
  if (tool === 'computer_apps') {
    const line =
      (typeof args.launch === 'string' ? refusedLaunch(args.launch) : null) ?? (openOf(args).map(refusedOpenItem).find((l) => l !== null) ?? null)
    if (line) return refusalOf(line)
  }

  // 3. the card, the permission read now: safe and edits ask for every act, every mode for a flag or a password field
  const permission = ctx.permission?.() ?? host.registry.get(threadId)?.permission ?? 'safe'
  const ask = ctx.approve ?? ((req: ApprovalRequest) => host.registry.requestApproval(threadId, req))
  /** The row's held line while a wait of the call's own lasts; a line the gate set meanwhile is left alone. */
  const holding = async <T>(line: string, wait: () => Promise<T>): Promise<T> => {
    const live = t.live
    const mine = live !== null && !live.held
    if (mine) {
      live.held = line
      host.touched(t)
    }
    try {
      return await wait()
    } finally {
      if (mine && live!.held === line) {
        live!.held = null
        host.touched(t)
      }
    }
  }
  // a card is a hold: the row says so, and a bridged call held on it answers in time (pending.ts). A card of this
  // host's own thread is also the row's `asking`, its title as a question; a box thread's is the bridge's to say
  const approve = (req: ApprovalRequest): Promise<boolean> =>
    holding(LOCAL_CARD_WORDS, async () => {
      const live = ctx.approve ? null : t.live
      const line = live ? approvalLine('computer', req.input, req.title) : null
      if (live) {
        live.asking = line
        host.touched(t)
      }
      try {
        return await ask(req)
      } finally {
        if (live && live.asking === line) {
          live.asking = null
          host.touched(t)
        }
      }
    })
  const hostNeed = passwordTarget(steps, app()?.book)
  let resolvedApp: { pid: number; bundleId: string | null; name: string } | undefined
  const titleCtx = (): TitleContext => {
    const a = app()
    const tab = knownTab(t, args.app, args.window)
    const listed = t.listedApps?.find((entry) => [entry.name, entry.bundleId].some((name) => name?.toLowerCase() === args.app?.toLowerCase()))
    return {
      appName: a?.name ?? listed?.name ?? args.app ?? 'an app',
      window: tab?.window ?? args.window ?? a?.window?.title ?? null,
      ...(tab ? { tab: tab.title } : {}),
      element: (i) => a?.book.brief(i) ?? null,
      maskText: hostNeed !== null
    }
  }
  const gateCtx = (classes: ActionClass[]): TierGateContext => {
    const a = app()
    const targetApp = resolvedApp ?? (a ? { pid: a.pid, bundleId: a.bundleId, name: a.name } : undefined)
    const window = t.listedApps?.find((entry) => entry.pid === targetApp?.pid)?.windows?.find((w) => w.title === titleCtx().window)
    return {
      threadId,
      rootId: ctx.rootId ?? host.rootOf(threadId),
      permission,
      app: targetApp ?? { pid: 0, bundleId: null, name: args.app ?? '' },
      window: window ? { id: window.id, title: window.title } : a?.window ?? null,
      classes,
      serviceSession: t.serviceSession,
      ...(ctx.callId ? { callId: ctx.callId } : {}),
      approve,
      ...(ctx.reader ? { reader: ctx.reader } : {})
    }
  }
  const need = needsApproval(tool, args, permission, hostNeed)
  if (need.ask) {
    // a step expected to take the session tier says so on the card, and its Allow covers that tier too
    const bundleId = app()?.bundleId ?? null
    const session = steps.some(
      // a step with an ax route tries it first (§24.1): the card claims the session tier only for one without
      (a) => sendsInput(a) && ((host.verdicts.needsSession(bundleId, a) && !mayRunAtAx(a)) || (a.action === 'perform' && a.name === 'raise'))
    )
    // a step whose class needs the app in front says so; an Allow covers the hold (§26.6)
    const front =
      !session &&
      host.service.serves?.('front') === true &&
      steps.some((a) => sendsInput(a) && (host.verdicts.needsFront(bundleId, a) || needsKeyWindowFront(host, bundleId, a)))
    const words = titleCtx()
    // Away allows every card but a money act, read off the model's own flag: the card's confirm may be the host's `password`
    const awayDenies = !awayAllowsKind((args.confirm as { kind?: string } | undefined)?.kind)
    const allowed = await approve({
      toolName: `mcp__app__${tool}`,
      input: computerApprovalInput(tool, args, words, need.confirm),
      title: computerApprovalTitle(tool, args, words, need.confirm, { session, front }),
      callId: ctx.callId,
      signal,
      ...(awayDenies ? { awayDenies: true as const } : {})
    })
    if (!allowed) {
      const stopped = abortedLine(signal)
      return stopped ? refusal(stopped) : refused(awayDenies && host.registry.awayOn() ? 'away' : 'denied')
    }
    const after = abortedLine(signal)
    if (after) return refusal(after)
    if (session) host.gate().cardAllowed?.(gateCtx([]), host.now())
  }

  const asked = new Set<PermissionName>()
  const askOnce = (which: PermissionName): void => {
    if (asked.has(which)) return
    asked.add(which)
    const key = permissionPromptedSetting(which)
    if (host.store.getSetting(key)) return
    host.store.setSetting(key, String(host.now()))
    void host.service.request('permissions.request', { which }).catch(() => undefined)
  }

  // 4. the connection and the session, a session the service forgot opened again once
  const open = async (): Promise<void> => {
    const conn = await host.service.connection()
    if (t.openedIn === conn.epoch) return
    await timed('session.open', { session: t.serviceSession })
    t.openedIn = conn.epoch
  }
  /** One service request, its round trip and any observation's wait on the call's tally. */
  async function timed<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> {
    const tally = ctx.timing
    if (!tally) return await host.service.request(method, params, { signal })
    const at = host.now()
    try {
      const result = await host.service.request(method, params, { signal })
      tally.addWaited(waitedIn(result))
      return result
    } finally {
      tally.addService(host.now() - at)
    }
  }
  async function send<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> {
    await open()
    try {
      return await timed(method, params)
    } catch (e) {
      if (!(e instanceof ComputerRpcError) || e.data?.kind !== 'unknown_session') throw e
      t.openedIn = null
      await open()
      return await timed(method, params)
    }
  }
  /** Every request, a read or an input: on the bridge it waits until someone will read the result, so nothing runs unread. */
  async function call<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> {
    const reader = ctx.reader
    if (!reader) return await send(method, params)
    if (!reader.present()) await holding(READER_WAIT_WORDS, () => reader.whenPresent(signal))
    return await reader.request(signal, () => send(method, params))
  }

  const errCtx: ErrorContext = {
    app: args.app ?? (typeof args.launch === 'string' ? args.launch : undefined),
    window: args.window,
    ...(tool === 'computer_act' ? { action: steps[0] } : {}),
    ...(tool === 'computer_apps' && openOf(args).length ? { open: openOf(args) } : {})
  }
  try {
    if (tool === 'computer_apps') {
      const apps = await runApps(call, args, t, note)
      return abortedLine(signal) ? refusal(abortedLine(signal)!) : apps
    }

    // 5. the target: the app pinned to a pid before any request, and checked
    const pin = await pinApp(host, args.app!, call, t.serviceSession)
    if ('line' in pin) return refusalOf(pin.line)
    resolvedApp = pin.app
    /** the person's app as the list cached before the act reads it, for the front line */
    const person = host.targets.activeName(pin.app.pid)
    note.person = person
    const offLimits = refusedTarget(pin.app, steps.some(sendsInput) ? 'act' : 'read')
    if (offLimits) return refusalOf(offLimits)
    const a = app()
    const bound = !args.window && a?.window ? { id: a.window.id } : undefined
    // text with no target in a call that names no window is pinned to the window the thread read, by id; a named
    // window goes as given, with the id the thread read for the service to hold the text to (§27.6)
    const readOne = !args.window && blindText && a?.window ? { id: a.window.id } : undefined
    const textWindowId = args.window && blindText && a?.window ? a.window.id : undefined
    /** a window a step opened: the call's later requests act there (§27.5) */
    let followed: { id: number } | null = null
    /** the window the thread had bound before the call followed one */
    const original = a?.window ? { ...a.window } : null
    const expectFocus = steps.length ? a?.book.focused ?? undefined : undefined
    const epoch = a?.epoch
    const windowOf = (useBound: boolean): TargetBase['window'] =>
      followed ?? readOne ?? (args.window ? { title: args.window } : bound && useBound ? bound : undefined)
    const target = (useBound = true): TargetBase => {
      const window = windowOf(useBound)
      return {
        session: t.serviceSession,
        app: { pid: pin.app.pid },
        ...(window ? { window } : {}),
        launch: false,
        ...((named.length || expectFocus !== undefined) && epoch ? { epoch } : {})
      }
    }
    /**
     * A followed window that closed falls back to the call's own window, once (§27.5); a bound window that closed
     * falls back to the app's main window, once.
     */
    const targeted: Targeted = async (method, params) => {
      try {
        return await call(method, params(target()))
      } catch (e) {
        const gone = e instanceof ComputerRpcError && e.data?.kind === 'window_not_found'
        if (gone && followed) {
          followed = null
          const st = app()
          if (st) st.window = original
          return await targeted(method, params)
        }
        if (!(gone && bound && !readOne)) throw e
        if (a) a.window = null
        return await call(method, params(target(false)))
      }
    }

    const shots: LandedShot[] = []
    const notes: string[] = []
    const pinFront = pin.front ? frontLine(pin.app.name, pin.front, person) : null
    if (pinFront) notes.push(pinFront)
    const land = async (shot: NonNullable<Observation['shot']>, label: string, where: LandedShot['where']): Promise<void> => {
      const dir = host.landing(threadId)
      t.nextShot ??= await nextShotNumber(dir)
      const landed = await landShot(shot, dir, t.nextShot, label, where)
      t.nextShot = landed.n + 1
      const { n: _n, ...rest } = landed
      shots.push(rest)
    }
    const noteMissing = (error: ComputerError | undefined): void => {
      if (error?.kind !== 'permission_missing' || !error.which) return
      if (!asked.has(error.which)) notes.push(`${error.which === 'screenRecording' ? 'Screen Recording' : 'Accessibility'} is off: ${PERMISSION_SWITCH[error.which]}`)
      askOnce(error.which)
    }
    /** The model will not see the observation just taken: that app's next read is full. */
    const discarded = (): void => {
      const st = app()
      if (st) {
        st.needsFull = true
        st.book.focused = readFocus
      }
    }
    const take = async (obs: Observation | undefined): Promise<void> => {
      if (!obs) return
      note.observation = obs
      remember(t, args.app!, obs)
      noteMissing(obs.shotError)
      if (obs.shot) await land(obs.shot, 'observation', 'observation')
    }

    // 6. the call
    if (tool === 'computer_observe') {
      const full = args.full === true || a?.needsFull === true
      const obs = await targeted('state.get', (tg) => ({
        ...tg,
        tabs: 'background',
        mode: full ? 'full' : 'auto',
        ...(args.element !== undefined ? { element: args.element as number } : {}),
        screenshot: shotPolicy(args.screenshot),
        ...(typeof args.menus === 'boolean' ? { menus: args.menus } : {}),
        wait: COMPUTER_WAIT.observe
      }))
      await take(obs)
      const stopped = abortedLine(signal)
      if (stopped) {
        discarded()
        return refusal(stopped)
      }
      const out = outcomeOf([], { steps: [], observation: obs }, shots, undefined, errCtx)
      return { ...out, steps: [...out.steps, ...notes] }
    }

    const single = tool === 'computer_act'
    const actions: ComputerAction[] = steps
    /** An observation the model will not see: the book takes it, and that app's next read is full. */
    const drop = (obs: Observation): void => {
      const focused = app()?.book.focused ?? null
      remember(t, args.app!, obs)
      const st = lookupApp(t, args.app!)!
      st.book.focused = focused
      st.needsFull = true
    }
    const result = await runActions(host, {
      threadId,
      session: t.serviceSession,
      args,
      actions,
      expectFocus,
      ...(textWindowId !== undefined ? { textWindowId } : {}),
      single,
      signal,
      targeted,
      follow: (opened) => {
        // every target the call holds moves to the window the step opened, and the thread binds it (§27.5)
        followed = { id: opened.id }
        const st = app()
        if (st) st.window = { id: opened.id, title: opened.title }
      },
      call,
      appOf: app,
      drop,
      gateCtx,
      wordsOf: (a) => actionWords(a, titleCtx()),
      callKey: `${threadId}:${++callSeq}`
    })
    note.results = result.steps
    if (result.front) note.front = result.front
    if (result.menusLeftOpen?.length) note.menusLeftOpen = result.menusLeftOpen
    for (const s of result.steps) if (s.status === 'failed') noteMissing(s.error)
    for (const [i, s] of result.steps.entries()) if (s.status === 'ok' && s.shot) await land(s.shot, `step ${i + 1}`, i + 1)
    await take(result.observation)
    // after the closing read, so a full read that leaves them out keeps them: a named step's element (§27.9), and the
    // password field a refusal named, so the resend by element asks the password card (§27.7a)
    const book = app()?.book
    if (book)
      for (const s of result.steps) {
        if (s.status === 'ok' && s.resolved !== undefined && s.element?.index === s.resolved) book.learn(s.element)
        if (s.status === 'failed' && s.error.kind === 'focus_moved' && s.error.reason === 'secure' && s.error.focused) book.learn(s.error.focused)
      }
    // the window the thread used closed, or the app quit (§22.6): its next call targets the app's main window
    if (result.observationError?.kind === 'window_not_found') {
      const st = app()
      if (st) st.window = null
    }
    const lastTier = [...result.steps].reverse().find((s) => s.status === 'ok' && s.tier !== null)
    if (t.live && lastTier?.status === 'ok') t.live.tier = lastTier.tier
    const out = outcomeOf(actions, result, shots, result.hostLines, errCtx, person)
    if (result.requestLine) return { ...out, body: result.requestLine, isError: true }
    const stoppedLine = abortedLine(signal)
    if (stoppedLine && result.observation) discarded()
    return { ...out, steps: [...out.steps, ...notes], ...(stoppedLine ? { body: stoppedLine, isError: true } : {}) }
  } catch (e) {
    const stoppedLine = abortedLine(signal)
    if (stoppedLine) return refusal(stoppedLine)
    if (e instanceof ComputerHostError) return { ...refusal(e.message), refused: e.kind }
    if (e instanceof ComputerRpcError) {
      // the line says where the switch is; the system asks once per install
      if (e.data?.kind === 'permission_missing' && e.data.which) askOnce(e.data.which)
      // the service caught an app no call may touch (a path to TempCode.app): the host's own words for it
      if (e.data?.kind === 'open_refused' && e.data.reason === 'app') return refused('refused_app', 'tempcode')
      if (e.data) note.error = e.data
      return refusal(e.data ? errorLine(e.data, errCtx) : e.message)
    }
    host.log(`computer call failed in ${threadId}: ${(e as Error).stack ?? e}`)
    return refusal(`the computer call failed: ${(e as Error).message}`)
  }
}

/** computer_apps' items, as the model gave them. */
const openOf = (args: Args): string[] => (Array.isArray(args.open) ? (args.open as string[]) : [])

/**
 * computer_apps: one apps.launch with the items, the session a late steal
 * names and the refused bundles, then the list. The app it answered is
 * checked against the refused ones as a pinned target is.
 */
async function runApps(
  call: <M extends ComputerMethod>(m: M, p: ComputerParams<M>) => Promise<ComputerResult<M>>,
  args: Args,
  t: ThreadComputer,
  note: CallNote
): Promise<ComputerToolOutcome> {
  const session = t.serviceSession
  const launch = typeof args.launch === 'string' ? args.launch : null
  const open = openOf(args)
  const r = launch ? await call('apps.launch', { app: launch, ...(open.length ? { open } : {}), session, refuse: [...REFUSED_LAUNCH_BUNDLES] }) : null
  const { apps } = await call('apps.list', { windows: true })
  t.listedApps = apps
  const app = r ? apps.find((a) => a.pid === r.pid) : undefined
  const offLimits = r ? refusedTarget(app ?? { pid: r.pid, bundleId: null }, open.length ? 'act' : 'read') : null
  if (offLimits) return refusalOf(offLimits)
  if (r) note.launched = { launched: r.launched, opened: open.length > 0 }
  const launched: LaunchReport | undefined =
    r && launch
      ? {
          name: app?.name ?? launch,
          launched: r.launched,
          ...(open.length ? { open } : {}),
          ...(r.front ? { front: r.front } : {}),
          ...(r.window ? { window: r.window } : {}),
          ...(r.others?.length ? { others: r.others } : {}),
          // put back, the person's app is in front again as the list reads it
          person: apps.find((a) => a.active && a.pid !== r.pid)?.name ?? null
        }
      : undefined
  return { steps: [], shots: [], body: formatAppsList(apps, launched), isError: false }
}

function actionOf(args: Args): ComputerAction {
  const { app: _app, window: _window, screenshot: _screenshot, confirm: _confirm, ...action } = args
  return action as ComputerAction
}

/** The steps a call runs: computer_act's one, computer_batch's list, none for apps and observe. */
function actionsOf(tool: ComputerToolName, args: Args): ComputerAction[] {
  return tool === 'computer_act' ? [actionOf(args)] : tool === 'computer_batch' ? (args.actions as ComputerAction[]) : []
}

/** The proof's pin (resolveApp with a pid) wins; else the resolver, on the service's own app methods. */
async function pinApp(
  host: RunHost,
  query: string,
  call: <M extends ComputerMethod>(m: M, p: ComputerParams<M>) => Promise<ComputerResult<M>>,
  session: string
): Promise<Resolved> {
  const proof = host.resolveApp?.(query)
  if (proof?.pid !== undefined) return { app: { pid: proof.pid, bundleId: null, name: query } }
  return host.targets.resolve(
    proof?.app ?? query,
    {
      list: async () => (await call('apps.list', {})).apps,
      launch: (app) => call('apps.launch', { app, session, refuse: [...REFUSED_LAUNCH_BUNDLES] }),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms))
    },
    (e) => (e instanceof ComputerRpcError ? (e.data ?? null) : null)
  )
}

/** The app's state from an observation the model gets: who it is, its window, the epoch, the book. */
/** The smart wait the service reported for the observations in a result: a `state.get`'s own, or an action's or batch's closing one. */
export function waitedIn(result: unknown): number {
  if (!result || typeof result !== 'object') return 0
  const r = result as { text?: unknown; waited?: { waitedMs?: number }; observation?: { waited?: { waitedMs?: number } } }
  const own = typeof r.text === 'string' ? (r.waited?.waitedMs ?? 0) : 0
  return own + (r.observation?.waited?.waitedMs ?? 0)
}

export function remember(t: ThreadComputer, query: string, obs: Observation): void {
  const key = (obs.app.bundleId ?? obs.app.name).toLowerCase()
  const st: AppState = t.apps.get(key) ?? {
    key,
    pid: obs.app.pid,
    bundleId: obs.app.bundleId,
    name: obs.app.name,
    epoch: obs.epoch,
    seq: obs.seq,
    window: null,
    thin: false,
    needsFull: false,
    book: new ElementBook()
  }
  if (st.epoch !== obs.epoch) st.book.clear()
  Object.assign(st, { pid: obs.app.pid, bundleId: obs.app.bundleId, name: obs.app.name, epoch: obs.epoch, seq: obs.seq, thin: obs.stats.thin })
  st.window = { id: obs.window.id, title: obs.window.title }
  const tab = obs.page?.tab ?? obs.selectedTab
  const listed = t.listedApps?.find((a) => a.pid === obs.app.pid)?.windows?.find((w) => w.id === obs.window.id)
  if (listed) {
    listed.title = obs.window.title
    if (tab) for (const entry of listed.tabs ?? []) entry.selected = entry.title === tab
  }
  st.book.apply(obs.text, obs.kind)
  if (obs.kind === 'full') st.needsFull = false
  t.apps.set(key, st)
  for (const alias of [query, obs.app.name, obs.app.bundleId]) if (alias) t.aliases.set(alias.toLowerCase(), key)
  t.used = [key, ...t.used.filter((k) => k !== key)]
}

interface ActionsRun {
  threadId: string
  session: string
  args: Args
  actions: ComputerAction[]
  single: boolean
  expectFocus?: number
  /** the window the thread last read, sent when the call names a window and types with no target (§27.6) */
  textWindowId?: number
  signal: AbortSignal
  targeted: Targeted
  /** a step opened a window: the call's later requests and its closing read go there (§27.5) */
  follow: (opened: { id: number; title: string }) => void
  call: <M extends ComputerMethod>(method: M, params: ComputerParams<M>) => Promise<ComputerResult<M>>
  appOf: () => AppState | undefined
  drop: (obs: Observation) => void
  /** the gate's context for the call's current app and window */
  gateCtx: (classes: ActionClass[]) => TierGateContext
  /** a step as the card names it */
  wordsOf: (action: ComputerAction) => string
  /** this call, unique on the host: the gate keys a paste's deadline by it */
  callKey: string
}

let callSeq = 0

/**
 * The actions in segments of equal tier lists. A step the service says needs
 * the session tier, one the verdict says needs it, and a key-window retry of a
 * key or paste go to the gate; an admit re-runs from that step with `session`
 * allowed, a refusal fails it. A step the verdict sends to the session tier
 * that may have an `ax` route (`mayRunAtAx`, §24.1) tries `ax` alone first,
 * the routes the app ignored left out, and goes to the gate only when that
 * answers `needs_tier`. A `type` that met a window that is not key retries once
 * at `ax`. Every acting call names the routes the app was seen to ignore. A
 * retry drops the first run's closing observation, so that app's next read is
 * full.
 */
async function runActions(host: RunHost, run: ActionsRun): Promise<StepsResult & { hostLines: Map<number, string>; requestLine?: string }> {
  const { actions, signal, gateCtx } = run
  const gate = host.gate()
  const bundleOf = (): string | null => run.appOf()?.bundleId ?? null
  const classes = [...new Set(actions.filter(sendsInput).map(classOf).filter((c): c is ActionClass => c !== null))]
  // `front` only to a service that speaks it (§26, decision 14)
  const served = host.service.serves?.('front') === true
  const admitted: Admitted = { session: gate.admitted(gateCtx(classes)), front: served && (gate.frontAdmitted?.(gateCtx(classes)) ?? false) }
  const override = new Map<number, Tier[]>()
  const tiersOf = (a: ComputerAction, i: number): Tier[] => override.get(i) ?? host.verdicts.tiersFor(bundleOf(), a, admitted)
  const steps: StepResult[] = actions.map((a, index) => ({ index, action: a.action, status: 'not-run' }))
  const hostLines = new Map<number, string>()
  /** a step that waited before it ran: the line said before its own */
  const heldLines = new Map<number, string>()
  let observation: Observation | undefined
  let observationError: ComputerError | undefined
  let front: FrontReport | undefined
  const menusLeftOpen: string[] = []
  /** A step that will not run: its error's words, its line the host's. */
  const fail = (i: number, error: ComputerError): void => {
    steps[i] = { index: i, action: actions[i].action, status: 'failed', error }
    hostLines.set(i, formatStepLine(steps[i], actions[i]))
  }
  /** steps trying `ax` alone before the gate, under a `session` verdict */
  const axFirst = new Set<number>()
  const refuse = (i: number, decision: Extract<TierDecision, { admit: false }>, menu?: string[], needed: 'front' | 'session' = 'session'): void => {
    const message =
      decision.reason === 'cancelled'
        ? (abortedLine(signal) ?? sessionRefusedLine('cancelled'))
        : sessionRefusedLine(decision.reason, run.appOf()?.name ?? run.args.app, { menu, tier: needed })
    fail(i, { kind: 'needs_tier', message, needed, ...(menu ? { menu } : {}) })
  }
  const stepCtx = (i: number) => {
    const a = actions[i]
    const cls = classOf(a)
    return { ...gateCtx(cls ? [cls] : []), step: i, action: a, words: run.wordsOf(a), call: run.callKey, signal }
  }
  /** The gate for a step that needs `front` or `session`; admitted, the step's tiers with that one in them. */
  const askGate = async (i: number, menu?: string[], needed: 'front' | 'session' = 'session'): Promise<Tier[] | null> => {
    const decision = await gate.request({ ...stepCtx(i), ...(needed === 'front' ? { needed } : {}) })
    if (!decision.admit) {
      refuse(i, decision, menu, needed)
      return null
    }
    const line = decision.via && decision.waitedMs ? formatHeldLine({ waitedMs: decision.waitedMs, via: decision.via }) : null
    if (line) heldLines.set(i, line)
    return needed === 'front'
      ? host.verdicts.tiersFor(bundleOf(), actions[i], { front: true, session: admitted.session })
      : host.verdicts.tiersFor(bundleOf(), actions[i], { front: admitted.front, session: true })
  }
  /** A paste the service held off for the person's copy: wait for a quiet clipboard, then run it again; null when it may not. */
  const askClipboard = async (i: number, tiers: Tier[]): Promise<Tier[] | null> => {
    const decision = gate.clipboard ? await gate.clipboard(stepCtx(i)) : { ok: false as const, message: hostErrorLine('clipboard_recent') }
    if (decision.ok) {
      const line = formatHeldLine({ waitedMs: decision.waitedMs, via: 'clipboard' })
      if (line) heldLines.set(i, line)
      return tiers
    }
    const message = decision.cancelled ? (abortedLine(signal) ?? hostErrorLine('cancelled')) : hostErrorLine('clipboard_recent')
    fail(i, { kind: 'clipboard_busy', message, reason: 'recent-copy' })
    return null
  }

  // the verdict alone says session for a step the gate did not admit up front
  let stopAt = actions.length
  for (const [i, a] of actions.entries()) {
    if (!sendsInput(a)) continue
    // the verdict alone says session, or front while the setting holds front back (§26.6)
    const needed =
      !admitted.session && host.verdicts.needsSession(bundleOf(), a)
        ? 'session'
        : served && !admitted.front && host.verdicts.needsFront(bundleOf(), a)
          ? 'front'
          : null
    if (!needed) continue
    if (mayRunAtAx(a)) {
      override.set(i, ['ax'])
      axFirst.add(i)
      continue
    }
    const tiers = await askGate(i, undefined, needed)
    if (!tiers) {
      stopAt = i
      break
    }
    override.set(i, tiers)
  }

  // probe an app once, before the first process-tier input, after the card
  await probeOnce(host, run, actions.slice(0, stopAt))

  /**
   * §27.8 ended the call before step `i`: it and every later step not yet run read the stop, numbered from the call's
   * last step that ran and sent input, whatever request the stop came from.
   */
  const stopFrom = (i: number): void => {
    let afterStep = -1
    for (let k = i - 1; k >= 0 && afterStep < 0; k--) if (steps[k].status === 'ok' && sendsInput(actions[k])) afterStep = k
    if (afterStep < 0) return
    for (let k = i; k < actions.length; k++)
      if (steps[k].status === 'not-run') steps[k] = { index: k, action: actions[k].action, status: 'not-run', stopped: { afterStep, reason: 'no-change' } }
  }

  const waits = computerAxWaits()

  /** the tiers each step has been offered past its first run: `process → front → session`, each once (§26, decision 13) */
  const offered = new Map<number, Set<Tier>>()
  const wasOffered = (i: number, tier: Tier): boolean => offered.get(i)?.has(tier) === true
  /** a key or paste whose window was not key leaves out the tiers that refused it on every later retry */
  const dropped = new Map<number, Tier[]>()
  let from = 0
  let ranAny = false
  let tabsAny = false
  let stopped = false
  let opened = false
  while (from < stopAt && !signal.aborted) {
    const segments = planBatch(actions.slice(from, stopAt), (a, k) => tiersOf(a, from + k))
    let failedAt: number | null = null
    for (const seg of segments) {
      const at = from + seg.from
      // the host's half of §27.8: blind keys after a step that changed nothing in an earlier request never go out
      if (at > 0 && stoppedBefore(actions, steps, at) !== null) {
        stopFrom(at)
        stopped = true
        break
      }
      // what the call's earlier requests did, for the service to read as if they had run in this one (§27.7b); before
      // any step sent input there is nothing to tell, and the read's focus still binds the call's first key or text step
      const before = steps.slice(0, at)
      const inputBefore = lastInputEffect(actions, before) !== undefined || before.some((s) => s.status === 'failed' && s.error.session !== undefined)
      const prior = inputBefore ? buildPrior(actions, before) : undefined
      const expectFocus = inputBefore ? undefined : run.expectFocus
      // an ax-first try leaves the ignored routes out, so it never ends ok/none short of the gate
      const skip = seg.actions.some((_, k) => axFirst.has(at + k))
      const ignored = host.verdicts.ignoredFor(bundleOf())
      const sendSegment = () =>
        runSegment(run, gate, classes, seg.actions, seg.tiers, seg.last, { ignored: skip ? { ...ignored, skip: true } : ignored, expectFocus, tabsAny, prior, waits })
      let r: StepsResult
      try {
        r = await sendSegment()
      } catch (e) {
        if (!(e instanceof ComputerRpcError && e.data?.kind === 'tab_in_use') || !actions.some(sendsInput)) throw e
        // Request errors run no steps. Reads never come here; this act takes the same hold as a session step.
        const decision = await gate.request({ ...stepCtx(at), words: `select tab ${JSON.stringify(run.args.window ?? '')} and ${run.wordsOf(actions[at])}` })
        if (!decision.admit) return { steps: steps.filter((s) => s.status !== 'not-run'), hostLines, requestLine: decision.message }
        const line = decision.via && decision.waitedMs !== undefined ? formatHeldLine({ waitedMs: decision.waitedMs, via: decision.via }) : null
        if (line) heldLines.set(at, line)
        tabsAny = true
        r = await sendSegment()
      }
      ranAny = true
      front = mergeFront(front, r.front)
      for (const m of r.menusLeftOpen ?? []) if (!menusLeftOpen.includes(m)) menusLeftOpen.push(m)
      r.steps.forEach((s, k) => (steps[at + k] = { ...s, index: at + k }))
      for (const s of r.steps)
        if (s.status === 'ok' && s.opened) {
          run.follow(s.opened)
          opened = true
        }
      const appName = r.observation?.app.name ?? run.appOf()?.name
      for (const [k, s] of r.steps.entries()) host.verdicts.learn(r.observation?.app.bundleId ?? bundleOf(), seg.actions[k], s, appName)
      for (const s of r.steps) if (s.status === 'ok' && s.tier === 'session') gate.ran?.(gateCtx(classes), s.session)
      if (seg.last) {
        observation = r.observation
        observationError = r.observationError
      }
      const failed = r.steps.findIndex((s) => s.status === 'failed')
      if (failed >= 0) {
        failedAt = at + failed
        break
      }
      // a step the service stopped ends the call: no later request, the closing read as after a failure (§27.7b)
      const stop = r.steps.findIndex((s) => s.status === 'not-run' && s.stopped)
      if (stop >= 0) {
        stopFrom(at + stop)
        stopped = true
        break
      }
    }
    // a refused named target or a focus the call did not plan for is the model's to resolve: never retried
    if (stopped || failedAt === null || signal.aborted) break
    const failed = steps[failedAt]
    if (failed.status !== 'failed') break
    const a = actions[failedAt]
    let retry: Tier[] | null = null
    // the clipboard's wait has its own deadline (schedule.ts), so a paste refused again may wait again
    const recentCopy = failed.error.kind === 'clipboard_busy' && failed.error.reason === 'recent-copy'
    const wasAxFirst = axFirst.delete(failedAt)
    /** the tier this retry offers; a tier already offered to the step ends the chain */
    let offering: Tier | null = null
    if (recentCopy) retry = await askClipboard(failedAt, tiersOf(a, failedAt))
    else if (failed.error.kind === 'needs_tier' && failed.error.needed === 'front' && served && !wasOffered(failedAt, 'front')) {
      offering = 'front'
      retry = admitted.front
        ? host.verdicts.tiersFor(bundleOf(), a, { front: true, session: admitted.session })
        : await askGate(failedAt, failed.error.menu, 'front')
    } else if (failed.error.kind === 'needs_tier' && (failed.error.needed === 'session' || wasAxFirst) && !wasOffered(failedAt, 'session')) {
      offering = 'session'
      retry = await askGate(failedAt, failed.error.menu)
    } else if (failed.error.kind === 'key_window_unavailable') {
      // a key or paste: the menu route refuses a window that is not key as the process keys do (§24.2)
      const drop: Tier[] = a.action === 'key' || a.action === 'paste' ? ['ax', 'process'] : ['process']
      dropped.set(failedAt, drop)
      if (a.action === 'type') {
        if (wasOffered(failedAt, 'ax')) break
        offering = 'ax'
        retry = ['ax']
      } else {
        // `front` makes the target window key with AXMain and AXRaise before the session tier is asked (§26, decision 10);
        // a front the gate refuses goes on to the session tier's own ask
        if (served && !wasOffered(failedAt, 'front')) {
          offering = 'front'
          const tiers = admitted.front
            ? host.verdicts.tiersFor(bundleOf(), a, { front: true, session: admitted.session })
            : await askGate(failedAt, undefined, 'front')
          retry = tiers?.filter((tier) => !drop.includes(tier)) ?? null
        }
        if (!retry && !signal.aborted && !wasOffered(failedAt, 'session')) {
          offering = 'session'
          retry = (await askGate(failedAt))?.filter((tier) => !drop.includes(tier) && tier !== 'front') ?? null
        }
        if (!retry) break
      }
    } else break
    retry = retry?.filter((tier) => !(dropped.get(failedAt) ?? []).includes(tier)) ?? null
    if (!retry?.length) break
    if (offering) offered.set(failedAt, new Set([...(offered.get(failedAt) ?? []), offering]))
    override.set(failedAt, retry)
    if (observation) run.drop(observation)
    observation = undefined
    observationError = undefined
    for (let i = failedAt; i < actions.length; i++) steps[i] = { index: i, action: actions[i].action, status: 'not-run' }
    from = failedAt
  }

  // a batch that ended before its last segment, or a refusal after steps that ran: read the window once
  if (ranAny && !observation && !observationError && !signal.aborted) {
    try {
      observation = await run.targeted('state.get', (tg) => ({
        ...tg,
        tabs: 'background',
        // a window the call opened is read whole (§27.5)
        mode: run.appOf()?.needsFull || opened ? 'full' : 'auto',
        screenshot: shotPolicy(run.args.screenshot),
        wait: COMPUTER_WAIT.action
      }))
    } catch (e) {
      if (!(e instanceof ComputerRpcError)) throw e
      observationError = e.data ?? { kind: 'timeout', message: e.message }
    }
  }
  for (const [i, line] of heldLines) if (steps[i].status !== 'not-run') hostLines.set(i, `${line}\n${hostLines.get(i) ?? formatStepLine(steps[i], actions[i])}`)
  return { steps, observation, observationError, hostLines, ...(front ? { front } : {}), ...(menusLeftOpen.length ? { menusLeftOpen } : {}) }
}

/** One acting request, through the gate: it may take `session` out of the tiers, holds the Mac for it and puts it back after. */
interface SegmentOptions {
  ignored?: IgnoredRoutes
  expectFocus?: number
  tabsAny: boolean
  /** the call's earlier requests, on every request after the first (§27.7b) */
  prior?: Prior
  waits: AxWaitRows
}

async function runSegment(
  run: ActionsRun,
  gate: SessionTierGate,
  classes: ActionClass[],
  actions: ComputerAction[],
  tiers: Tier[],
  last: boolean,
  { ignored, expectFocus, tabsAny, prior, waits }: SegmentOptions
): Promise<StepsResult> {
  const observe = last ? { mode: run.appOf()?.needsFull ? ('full' as const) : ('auto' as const), screenshot: shotPolicy(run.args.screenshot) } : { mode: 'none' as const }
  const wait = last ? COMPUTER_WAIT.action : COMPUTER_WAIT.step
  const extras = (allowed: Tier[]) => ({
    // the service picks the ax rows for the steps that went in at ax (§27.3)
    axWait: last ? waits.axAction : waits.axStep,
    axStepWait: waits.axStep,
    ...(prior ? { prior } : {}),
    ...(run.textWindowId !== undefined ? { textWindowId: run.textWindowId } : {}),
    ...(expectFocus !== undefined ? { expectFocus } : {}),
    ...(gate.pasteQuietMs !== undefined ? { pasteQuietMs: gate.pasteQuietMs } : {}),
    ...(allowed.includes('session') && gate.personIdleMs ? { personIdleMs: gate.personIdleMs() } : {}),
    ...(ignored ? { ignored } : {})
  })
  const ctx = { ...run.gateCtx(classes), tiers: tabsAny && !tiers.includes('session') ? [...tiers, 'session' as const] : tiers, actions, signal: run.signal }
  const tabs = (allowed: Tier[]) => tabsAny && allowed.includes('session') ? 'any' as const : 'background' as const
  if (run.single) {
    const action = actions[0]
    const r = await gate.run(ctx, (allowed) =>
      run.targeted('action.run', (tg) => ({
        ...tg,
        action,
        tiers: allowed,
        tabs: tabs(allowed),
        wait: action.action === 'wait' && action.duration ? waitActionWait(action.duration) : wait,
        observe,
        ...extras(allowed)
      }))
    )
    return {
      steps: [r.step],
      observation: r.observation,
      observationError: r.observationError,
      ...(r.front ? { front: r.front } : {}),
      ...(r.menusLeftOpen ? { menusLeftOpen: r.menusLeftOpen } : {})
    }
  }
  return await gate.run(ctx, (allowed) => run.targeted('action.batch', (tg) => ({ ...tg, actions, tiers: allowed, tabs: tabs(allowed), stepWait: COMPUTER_WAIT.step, wait, observe, ...extras(allowed) })))
}

/** A key or paste into an app whose background windows were seen not key: its retry brings the app forward (§26, decision 10). */
function needsKeyWindowFront(host: RunHost, bundleId: string | null, a: ComputerAction): boolean {
  return (a.action === 'key' || a.action === 'paste') && host.verdicts.get(bundleId)?.needsKeyWindow === true
}

async function probeOnce(host: RunHost, run: ActionsRun, actions: ComputerAction[]): Promise<void> {
  const a = run.appOf()
  if (!a?.bundleId || !host.verdicts.needsProbe(a.bundleId)) return
  if (!actions.some((x) => sendsInput(x) && !COMPUTER_ACTIONS[x.action].axOnly)) return
  if (host.service.permissions()?.accessibility === false) return
  try {
    const report = await run.call('input.probe', { session: run.session, app: { pid: a.pid }, ...(a.window ? { window: { id: a.window.id } } : {}) })
    host.verdicts.learnProbe(a.bundleId, report, a.name)
  } catch (e) {
    host.verdicts.stampProbe(a.bundleId, a.name)
    host.log(`the probe of ${a.name} failed: ${(e as Error).message}`)
  }
}
