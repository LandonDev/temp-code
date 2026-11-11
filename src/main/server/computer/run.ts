import type { z } from 'zod'
import {
  COMPUTER_WAIT,
  NO_INPUT_ACTIONS,
  actionElements,
  waitActionWait,
  type AppRef,
  type ComputerAction,
  type ComputerError,
  type ComputerMethod,
  type ComputerParams,
  type ComputerResult,
  type FrontReport,
  type IgnoredRoutes,
  type Observation,
  type PermissionName,
  type StepResult,
  type Tier
} from '@shared/computer/protocol'
import { COMPUTER_ACTIONS, COMPUTER_TOOLS, formatStepLine, mayRunAtAx, type ActionClass, type ComputerToolName } from '@shared/computer/tools'
import { actionWords, asFourTool, computerActivity, computerApprovalInput, computerApprovalTitle, needsApproval, type TitleContext } from '@shared/computer/words'
import { errorLine, type ErrorContext } from '@shared/computer/errorWords'
import { hostErrorLine, noObservationLine, noReadForTextLine, sessionRefusedLine } from '@shared/computer/hostErrors'
import { formatHeldLine } from '@shared/computer/scheduleRules'
import { LOCAL_CARD_WORDS, READER_WAIT_WORDS, UNREAD_WORDS } from '@shared/computer/heldCalls'
import { awayAllowsKind } from '@shared/away'
import type { PermissionPolicy, SessionMeta } from '@shared/events'
import type { ApprovalRequest } from '../drivers/types'
import { planBatch } from './batchPlan'
import { ComputerHostError, ComputerRpcError } from './connection'
import { ElementBook } from './elements'
import {
  REFUSED_LAUNCH_BUNDLES,
  passwordTarget,
  refusedLaunch,
  refusedOpenItem,
  refusedTarget,
  textTargetProblem,
  type Resolved,
  type TargetResolver
} from './policy'
import {
  formatAppsList,
  frontLine,
  mergeFront,
  outcomeOf,
  refusal,
  type ComputerToolOutcome,
  type LandedShot,
  type LaunchReport,
  type StepsResult
} from './result'
import type { ComputerService } from './service'
import type { CallReader } from './pending'
import { landShot, nextShotNumber } from './shots'
import type { SessionTierGate, TierDecision, TierGateContext } from './tierGate'
import type { SettingsStore, TierVerdicts } from './verdicts'

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
}

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
 * action, `confirm` kept, the tool's full schema parses the arguments, and a
 * batch's text step after another input must name its element.
 */
export function checkComputerCall(toolName: string, rawArgs: unknown): { ok: true; tool: ComputerToolName; args: Record<string, unknown> } | { ok: false; line: string } {
  const four = asFourTool(toolName, rawArgs)
  if (!four) return { ok: false, line: hostErrorLine('invalid_args', `no computer tool is called ${toolName}`) }
  const spec = COMPUTER_TOOLS.find((s) => s.name === four.tool)!
  const parsed = spec.input.safeParse(four.args)
  if (!parsed.success) return { ok: false, line: hostErrorLine('invalid_args', issueWords(parsed.error)) }
  const args = parsed.data as Args
  const textProblem = textTargetProblem(actionsOf(four.tool, args))
  if (textProblem) return { ok: false, line: textProblem }
  return { ok: true, tool: four.tool, args }
}

export async function runComputerTool(host: RunHost, t: ThreadComputer, ctx: ComputerToolContext, toolName: string, rawArgs: unknown, signal: AbortSignal): Promise<ComputerToolOutcome> {
  // 1. normalize and check
  const checked = checkComputerCall(toolName, rawArgs)
  if (!checked.ok) return refusal(checked.line)
  const tool = checked.tool
  const args = checked.args as Args

  // 2. refusals before anything
  const meta = host.registry.get(ctx.threadId)
  const early =
    abortedLine(signal) ??
    (t.stopped ? hostErrorLine('stopped') : null) ??
    (meta?.status === 'paused' ? hostErrorLine('paused') : null) ??
    (() => {
      const why = host.service.unavailableReason()
      return why ? hostErrorLine('service_unavailable', why) : null
    })()
  if (early) return refusal(early)

  const now = host.now()
  t.live = t.live ?? { since: now, lastCallAt: now, running: null, tier: null }
  // the words name the element from the thread's book: "Clicking Save in TextEdit"
  const known = args.app ? lookupApp(t, args.app) : undefined
  const words = computerActivity(tool, args, (i) => known?.book.brief(i) ?? null, known?.name)?.text
  t.live.running = { tool, words: words ?? 'Using the computer', startedAt: now }
  host.touched(t)
  try {
    const out = await runChecked(host, t, ctx, tool, args, signal)
    if (!t.pendingFront.length) return out
    const late = t.pendingFront.splice(0)
    return { ...out, steps: [...out.steps, ...late] }
  } finally {
    if (t.live) {
      t.live.running = null
      t.live.held = null
      t.live.lastCallAt = host.now()
    }
    host.touched(t)
  }
}

async function runChecked(host: RunHost, t: ThreadComputer, ctx: ComputerToolContext, tool: ComputerToolName, args: Args, signal: AbortSignal): Promise<ComputerToolOutcome> {
  const threadId = ctx.threadId
  const app = (): AppState | undefined => (args.app ? lookupApp(t, args.app) : undefined)
  const steps = actionsOf(tool, args)

  // read first: an element, or text, needs a read of the app in this thread
  const named =
    tool === 'computer_observe' ? (args.element !== undefined ? [args.element as number] : []) : steps.flatMap(actionElements)
  if (named.length && !app()) return refusal(noObservationLine(named[0], args.app!))
  if (steps.some((s) => s.action === 'type' || s.action === 'paste') && !app()) return refusal(hostErrorLine('no_observation', noReadForTextLine(args.app!)))
  // text with no element goes to the focused element of the window the thread read, never one it has not
  const blindText = steps.some((s) => (s.action === 'type' || s.action === 'paste') && s.element === undefined)
  const readWindow = app()?.window?.title
  if (blindText && args.window && !(readWindow ?? '').includes(args.window))
    return refusal(hostErrorLine('no_observation', noReadForTextLine(args.app!, args.window)))

  // an app no call may touch, or an item that is no page, file or folder: refused before the card
  if (tool === 'computer_apps') {
    const refused =
      (typeof args.launch === 'string' ? refusedLaunch(args.launch) : null) ?? (openOf(args).map(refusedOpenItem).find((l) => l !== null) ?? null)
    if (refused) return refusal(refused)
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
  // a card is a hold: the row says so, and a bridged call held on it answers in time (pending.ts)
  const approve = (req: ApprovalRequest): Promise<boolean> => holding(LOCAL_CARD_WORDS, () => ask(req))
  const hostNeed = passwordTarget(steps, app()?.book)
  const titleCtx = (): TitleContext => {
    const a = app()
    return {
      appName: a?.name ?? args.app ?? 'an app',
      window: args.window ?? a?.window?.title ?? null,
      element: (i) => a?.book.brief(i) ?? null,
      maskText: hostNeed !== null
    }
  }
  const gateCtx = (classes: ActionClass[]): TierGateContext => {
    const a = app()
    return {
      threadId,
      rootId: ctx.rootId ?? host.rootOf(threadId),
      permission,
      app: a ? { pid: a.pid, bundleId: a.bundleId, name: a.name } : { pid: 0, bundleId: null, name: args.app ?? '' },
      window: a?.window ?? null,
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
    const words = titleCtx()
    // Away allows every card but a money act, read off the model's own flag: the card's confirm may be the host's `password`
    const awayDenies = !awayAllowsKind((args.confirm as { kind?: string } | undefined)?.kind)
    const allowed = await approve({
      toolName: `mcp__app__${tool}`,
      input: computerApprovalInput(tool, args, words, need.confirm),
      title: computerApprovalTitle(tool, args, words, need.confirm, { session }),
      callId: ctx.callId,
      signal,
      ...(awayDenies ? { awayDenies: true as const } : {})
    })
    if (!allowed) return refusal(abortedLine(signal) ?? hostErrorLine(awayDenies && host.registry.awayOn() ? 'away' : 'denied'))
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
    await host.service.request('session.open', { session: t.serviceSession })
    t.openedIn = conn.epoch
  }
  async function send<M extends ComputerMethod>(method: M, params: ComputerParams<M>): Promise<ComputerResult<M>> {
    await open()
    try {
      return await host.service.request(method, params, { signal })
    } catch (e) {
      if (!(e instanceof ComputerRpcError) || e.data?.kind !== 'unknown_session') throw e
      t.openedIn = null
      await open()
      return await host.service.request(method, params, { signal })
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
      const apps = await runApps(call, args, t.serviceSession)
      return abortedLine(signal) ? refusal(abortedLine(signal)!) : apps
    }

    // 5. the target: the app pinned to a pid before any request, and checked
    const pin = await pinApp(host, args.app!, call, t.serviceSession)
    if ('line' in pin) return refusal(pin.line)
    /** the person's app as the list cached before the act reads it, for the front line */
    const person = host.targets.activeName(pin.app.pid)
    const refused = refusedTarget(pin.app, steps.some(sendsInput) ? 'act' : 'read')
    if (refused) return refusal(refused)
    const a = app()
    const bound = !args.window && a?.window ? { id: a.window.id } : undefined
    // text with no element is pinned to the window the thread read, by id: a title names it, not which window the service picks
    const readOne = blindText && a?.window ? { id: a.window.id } : undefined
    const target = (useBound = true): TargetBase => ({
      session: t.serviceSession,
      app: { pid: pin.app.pid },
      ...(readOne ? { window: readOne } : args.window ? { window: { title: args.window } } : bound && useBound ? { window: bound } : {}),
      launch: false,
      ...(named.length && a ? { epoch: a.epoch } : {})
    })
    /** A bound window that closed falls back to the app's main window, once. */
    const targeted: Targeted = async (method, params) => {
      try {
        return await call(method, params(target()))
      } catch (e) {
        if (!(bound && !blindText && e instanceof ComputerRpcError && e.data?.kind === 'window_not_found')) throw e
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
      if (st) st.needsFull = true
    }
    const take = async (obs: Observation | undefined): Promise<void> => {
      if (!obs) return
      remember(t, args.app!, obs)
      noteMissing(obs.shotError)
      if (obs.shot) await land(obs.shot, 'observation', 'observation')
    }

    // 6. the call
    if (tool === 'computer_observe') {
      const full = args.full === true || a?.needsFull === true
      const obs = await targeted('state.get', (tg) => ({
        ...tg,
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
      return { ...out, steps: notes }
    }

    const single = tool === 'computer_act'
    const actions: ComputerAction[] = steps
    /** An observation the model will not see: the book takes it, and that app's next read is full. */
    const drop = (obs: Observation): void => {
      remember(t, args.app!, obs)
      lookupApp(t, args.app!)!.needsFull = true
    }
    const result = await runActions(host, {
      threadId,
      session: t.serviceSession,
      args,
      actions,
      single,
      signal,
      targeted,
      call,
      appOf: app,
      drop,
      gateCtx,
      wordsOf: (a) => actionWords(a, titleCtx()),
      callKey: `${threadId}:${++callSeq}`
    })
    for (const s of result.steps) if (s.status === 'failed') noteMissing(s.error)
    for (const [i, s] of result.steps.entries()) if (s.status === 'ok' && s.shot) await land(s.shot, `step ${i + 1}`, i + 1)
    await take(result.observation)
    // the window the thread used closed, or the app quit (§22.6): its next call targets the app's main window
    if (result.observationError?.kind === 'window_not_found') {
      const st = app()
      if (st) st.window = null
    }
    const lastTier = [...result.steps].reverse().find((s) => s.status === 'ok' && s.tier !== null)
    if (t.live && lastTier?.status === 'ok') t.live.tier = lastTier.tier
    const out = outcomeOf(actions, result, shots, result.hostLines, errCtx, person)
    const stoppedLine = abortedLine(signal)
    if (stoppedLine && result.observation) discarded()
    return { ...out, steps: [...out.steps, ...notes], ...(stoppedLine ? { body: stoppedLine, isError: true } : {}) }
  } catch (e) {
    const stoppedLine = abortedLine(signal)
    if (stoppedLine) return refusal(stoppedLine)
    if (e instanceof ComputerHostError) return refusal(e.message)
    if (e instanceof ComputerRpcError) {
      // the line says where the switch is; the system asks once per install
      if (e.data?.kind === 'permission_missing' && e.data.which) askOnce(e.data.which)
      // the service caught an app no call may touch (a path to TempCode.app): the host's own words for it
      if (e.data?.kind === 'open_refused' && e.data.reason === 'app') return refusal(hostErrorLine('refused_app', 'tempcode'))
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
async function runApps(call: <M extends ComputerMethod>(m: M, p: ComputerParams<M>) => Promise<ComputerResult<M>>, args: Args, session: string): Promise<ComputerToolOutcome> {
  const launch = typeof args.launch === 'string' ? args.launch : null
  const open = openOf(args)
  const r = launch ? await call('apps.launch', { app: launch, ...(open.length ? { open } : {}), session, refuse: [...REFUSED_LAUNCH_BUNDLES] }) : null
  const { apps } = await call('apps.list', { windows: true })
  const app = r ? apps.find((a) => a.pid === r.pid) : undefined
  const refused = r ? refusedTarget(app ?? { pid: r.pid, bundleId: null }, open.length ? 'act' : 'read') : null
  if (refused) return refusal(refused)
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
  signal: AbortSignal
  targeted: Targeted
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
async function runActions(host: RunHost, run: ActionsRun): Promise<StepsResult & { hostLines: Map<number, string> }> {
  const { actions, signal, gateCtx } = run
  const gate = host.gate()
  const bundleOf = (): string | null => run.appOf()?.bundleId ?? null
  const classes = [...new Set(actions.filter(sendsInput).map(classOf).filter((c): c is ActionClass => c !== null))]
  const admitted = gate.admitted(gateCtx(classes))
  const override = new Map<number, Tier[]>()
  const tiersOf = (a: ComputerAction, i: number): Tier[] => override.get(i) ?? host.verdicts.tiersFor(bundleOf(), a, admitted)
  const steps: StepResult[] = actions.map((a, index) => ({ index, action: a.action, status: 'not-run' }))
  const hostLines = new Map<number, string>()
  /** a step that waited before it ran: the line said before its own */
  const heldLines = new Map<number, string>()
  let observation: Observation | undefined
  let observationError: ComputerError | undefined
  let front: FrontReport | undefined
  /** A step that will not run: its error's words, its line the host's. */
  const fail = (i: number, error: ComputerError): void => {
    steps[i] = { index: i, action: actions[i].action, status: 'failed', error }
    hostLines.set(i, formatStepLine(steps[i], actions[i]))
  }
  /** steps trying `ax` alone before the gate, under a `session` verdict */
  const axFirst = new Set<number>()
  const refuse = (i: number, decision: Extract<TierDecision, { admit: false }>, menu?: string[]): void => {
    const message =
      decision.reason === 'cancelled'
        ? (abortedLine(signal) ?? sessionRefusedLine('cancelled'))
        : sessionRefusedLine(decision.reason, run.appOf()?.name ?? run.args.app, { menu })
    fail(i, { kind: 'needs_tier', message, needed: 'session', ...(menu ? { menu } : {}) })
  }
  const stepCtx = (i: number) => {
    const a = actions[i]
    const cls = classOf(a)
    return { ...gateCtx(cls ? [cls] : []), step: i, action: a, words: run.wordsOf(a), call: run.callKey, signal }
  }
  const askGate = async (i: number, menu?: string[]): Promise<Tier[] | null> => {
    const decision = await gate.request(stepCtx(i))
    if (!decision.admit) {
      refuse(i, decision, menu)
      return null
    }
    const line = decision.via && decision.waitedMs !== undefined ? formatHeldLine({ waitedMs: decision.waitedMs, via: decision.via }) : null
    if (line) heldLines.set(i, line)
    return host.verdicts.tiersFor(bundleOf(), actions[i], true)
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
  if (!admitted) {
    for (const [i, a] of actions.entries()) {
      if (!sendsInput(a) || !host.verdicts.needsSession(bundleOf(), a)) continue
      if (mayRunAtAx(a)) {
        override.set(i, ['ax'])
        axFirst.add(i)
        continue
      }
      const tiers = await askGate(i)
      if (!tiers) {
        stopAt = i
        break
      }
      override.set(i, tiers)
    }
  }

  // probe an app once, before the first process-tier input, after the card
  await probeOnce(host, run, actions.slice(0, stopAt))

  const retried = new Set<number>()
  let from = 0
  let ranAny = false
  while (from < stopAt && !signal.aborted) {
    const segments = planBatch(actions.slice(from, stopAt), (a, k) => tiersOf(a, from + k))
    let failedAt: number | null = null
    for (const seg of segments) {
      const at = from + seg.from
      // an ax-first try leaves the ignored routes out, so it never ends ok/none short of the gate
      const skip = seg.actions.some((_, k) => axFirst.has(at + k))
      const ignored = host.verdicts.ignoredFor(bundleOf())
      const r = await runSegment(run, gate, classes, seg.actions, seg.tiers, seg.last, skip ? { ...ignored, skip: true } : ignored)
      ranAny = true
      front = mergeFront(front, r.front)
      r.steps.forEach((s, k) => (steps[at + k] = { ...s, index: at + k }))
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
    }
    if (failedAt === null || signal.aborted) break
    const failed = steps[failedAt]
    if (failed.status !== 'failed') break
    const a = actions[failedAt]
    let retry: Tier[] | null = null
    // the clipboard's wait has its own deadline (schedule.ts), so a paste refused again may wait again
    const recentCopy = failed.error.kind === 'clipboard_busy' && failed.error.reason === 'recent-copy'
    if (!recentCopy && retried.has(failedAt)) break
    const wasAxFirst = axFirst.delete(failedAt)
    if (recentCopy) retry = await askClipboard(failedAt, tiersOf(a, failedAt))
    else if (failed.error.kind === 'needs_tier' && (failed.error.needed === 'session' || wasAxFirst)) retry = await askGate(failedAt, failed.error.menu)
    else if (failed.error.kind === 'key_window_unavailable') {
      // a key or paste: the menu route refuses a window that is not key as the process keys do (§24.2)
      const drop: Tier[] = a.action === 'key' || a.action === 'paste' ? ['ax', 'process'] : ['process']
      retry = a.action === 'type' ? ['ax'] : ((await askGate(failedAt))?.filter((tier) => !drop.includes(tier)) ?? null)
    } else break
    if (!retry) break
    if (!recentCopy) retried.add(failedAt)
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
        mode: run.appOf()?.needsFull ? 'full' : 'auto',
        screenshot: shotPolicy(run.args.screenshot),
        wait: COMPUTER_WAIT.action
      }))
    } catch (e) {
      if (!(e instanceof ComputerRpcError)) throw e
      observationError = e.data ?? { kind: 'timeout', message: e.message }
    }
  }
  for (const [i, line] of heldLines) if (steps[i].status !== 'not-run') hostLines.set(i, `${line}\n${hostLines.get(i) ?? formatStepLine(steps[i], actions[i])}`)
  return { steps, observation, observationError, hostLines, ...(front ? { front } : {}) }
}

/** One acting request, through the gate: it may take `session` out of the tiers, holds the Mac for it and puts it back after. */
async function runSegment(
  run: ActionsRun,
  gate: SessionTierGate,
  classes: ActionClass[],
  actions: ComputerAction[],
  tiers: Tier[],
  last: boolean,
  ignored?: IgnoredRoutes
): Promise<StepsResult> {
  const observe = last ? { mode: run.appOf()?.needsFull ? ('full' as const) : ('auto' as const), screenshot: shotPolicy(run.args.screenshot) } : { mode: 'none' as const }
  const wait = last ? COMPUTER_WAIT.action : COMPUTER_WAIT.step
  const extras = {
    ...(gate.pasteQuietMs !== undefined ? { pasteQuietMs: gate.pasteQuietMs } : {}),
    ...(ignored ? { ignored } : {})
  }
  const ctx = { ...run.gateCtx(classes), tiers, actions, signal: run.signal }
  if (run.single) {
    const action = actions[0]
    const r = await gate.run(ctx, (allowed) =>
      run.targeted('action.run', (tg) => ({
        ...tg,
        action,
        tiers: allowed,
        wait: action.action === 'wait' && action.duration ? waitActionWait(action.duration) : wait,
        observe,
        ...extras
      }))
    )
    return { steps: [r.step], observation: r.observation, observationError: r.observationError, ...(r.front ? { front: r.front } : {}) }
  }
  return await gate.run(ctx, (allowed) => run.targeted('action.batch', (tg) => ({ ...tg, actions, tiers: allowed, stepWait: COMPUTER_WAIT.step, wait, observe, ...extras })))
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
