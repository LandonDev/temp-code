import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CallTiming, type BridgeTiming } from '@shared/computer/bridgeTiming'
import { approvalLine } from '@shared/approvalLine'
import type { ComputerSessionRow } from '@shared/contract-computer'
import {
  MAC_APPROVAL_WAIT_MS,
  MAC_BRIDGE_OFF,
  heldLine,
  type MacBridgeComputer,
  type MacBridgeHeld,
  type MacBridgeOutcome,
  type MacBridgePolicy,
  type MacBridgeRequest,
  type MacCallThread
} from '@shared/contract-macbridge'
import {
  COMPUTER_HOLD_MAX_MS,
  COMPUTER_LIVE_IDLE_MS,
  COMPUTER_ROW_MS,
  COMPUTER_SESSION_WAIT_MS,
  COMPUTER_SWITCH_OFF,
  MacComputerCallArgsSchema,
  MacComputerEndArgsSchema,
  MacComputerReaderArgsSchema,
  computerCallBudgetMs,
  computerUnavailableOnMac,
  macComputerKey,
  type ComputerPeerAnswer,
  type MacComputerEndResult,
  type MacComputerPeerMethod,
  type MacComputerReaderResult
} from '@shared/contract-maccomputer'
import { hostErrorLine } from '@shared/computer/hostErrors'
import type { ComputerToolCall } from '@shared/computer/tools'
import { needsApproval } from '@shared/computer/words'
import { awayAllowsKind } from '@shared/away'
import { MAC_AWAY_REFUSAL } from '../awayPrompts'
import type { ComputerToolOutcome } from '../computer/result'
import { abortedLine, type ComputerToolContext } from '../computer/run'
import { serviceSessionId } from '../computer/sessions'
import type { ApprovalRequest } from '../drivers/types'

/**
 * The Mac side of computer use through the Mac bridge (docs/box.md "Computer
 * use from a box thread"). A box thread's `computer_*` call arrives as a
 * `mac.computer` peer call and runs in a computer session this Mac owns,
 * keyed `macComputerKey(box, thread)`, through the same flow a Mac thread's
 * call takes (computer/run.ts). The Mac decides everything:
 *
 *  - The host's policy must be above Off and its switch
 *    (`macBridge.computer.<envId>`) on, and this Mac able to serve computer
 *    use at all; each refusal is one line the model can act on.
 *  - The person away: every card (the tier gate's too) is allowed as it is
 *    made and the answer says `away`, except a call the model flagged pay or
 *    subscribe, refused before anything waits (MAC_AWAY_REFUSAL), or at its
 *    card when Away turned on while it waited.
 *  - A live session is a running request of kind `computer` on the load
 *    guard: it takes a slot under the host's commands cap and its computer
 *    cap, waits in line with its standing when either is full, and gives
 *    the slot back at the box turn's settle, a Stop, or three idle minutes.
 *  - In safe and edits an acting call asks on the Mac as a card of kind
 *    `computer` (Allow, Deny, nothing remembered). While the call is out its
 *    row reaches the box as `peer.progress`, with `asking` while a card waits.
 *  - The answer is the outcome's step lines and body apart and its pictures
 *    read back as base64; the files land under a directory of their own here
 *    only to be read, and go once read.
 */

/** A request asks no longer than the box will wait for it, less this margin for the reply to travel. */
const REPLY_MARGIN_MS = 3_000

/** What this side needs of the computer host (computer/sessions.ts ComputerSessions). */
export interface MacComputerSessions {
  run(ctx: ComputerToolContext, tool: string, args: unknown): Promise<ComputerToolOutcome>
  rowOf(threadId: string): ComputerSessionRow | null
  onRows(fn: (rows: ComputerSessionRow[]) => void): () => void
  beginTurn(threadId: string): void
  settleTurn(threadId: string): void
  stop(threadId: string): Promise<boolean>
  end(threadIds: string[]): Promise<void>
}

export interface MacComputerHost {
  sessions: MacComputerSessions
}

export type ComputerRequestShape = Omit<MacBridgeRequest, 'id' | 'createdAt' | 'expiresAt' | 'status' | 'quiet'>

/** The bridge's slice MacComputer works through (remote/macBridge.ts). */
export interface MacComputerBridge {
  policyOf(envId: string): MacBridgePolicy
  computerOf(envId: string): boolean
  away(): boolean
  askComputer(
    shape: ComputerRequestShape,
    until: number,
    callId?: string,
    /** Away denies this card at the flip instead of allowing it (MacBridge.awayChanged): a money act */
    opts?: { awayDenies?: boolean }
  ): { id: string; answer: Promise<{ allow: boolean; outcome: MacBridgeOutcome; byAway?: true }> }
  /** Finish a card (allowed, denied, expired): MacBridge.ask leaves an allowed request pending for its caller to finish. */
  finishCard(id: string, outcome: MacBridgeOutcome): void
  /** A running request of kind computer, with Stop; its id. */
  openLive(shape: ComputerRequestShape, stop: () => void): string
  /** The guard, kind computer: each change of standing reaches onStanding; an aborted signal takes the waiter out of line. Throws the hold's line. */
  holdLive(
    envId: string,
    id: string,
    until: number,
    opts: { signal: AbortSignal; onStanding: (held: MacBridgeHeld) => void }
  ): Promise<void>
  updateLive(id: string, computer: { app: string; window: string | null }): void
  finishLive(id: string, outcome: MacBridgeOutcome): void
}

export interface MacComputerClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface MacComputerDeps {
  /** This Mac's computer host, or null where computer use is unavailable. */
  host: () => MacComputerHost | null
  /** Why computer use is unavailable on this Mac, or null when it is available. */
  unavailable: () => string | null
  bridge: MacComputerBridge
  /** Where a box thread's pictures land here before they are read back (bridgedLanding); removed when its session ends. */
  landing?: (key: string) => string
  clock?: MacComputerClock
  log?: (line: string) => void
}

/** Where ComputerSessions lands a box thread's pictures on the Mac: only to be read back to the box. */
export function bridgedLanding(dataDir: string, key: string): string {
  return join(dataDir, 'computer', 'bridged', serviceSessionId(key))
}

interface CallState {
  controller: AbortController
  /** a card was allowed because the person is away: the answer says `away` and the box writes the allowed row */
  away: boolean
  /** the model flagged the call pay or subscribe (@shared/away awayAllowsKind): Away denies its cards */
  awayDenies: boolean
  /** a card was denied because the person is away: the call ends in MAC_AWAY_REFUSAL */
  awayDenied: boolean
  /** the call's own progress sender */
  progress: RowSender | null
  /** someone on the box reads this call (mac.computerReader); while false its next request waits */
  reading: boolean
  /** service requests out */
  out: number
  /** woken when reading turns true */
  waiters: Set<() => void>
}

interface LiveState {
  id: string
  ready: Promise<void>
  idleTimer: unknown
}

interface KeyState {
  key: string
  envId: string
  threadId: string
  turn: string | null
  live: LiveState | null
  calls: Map<string, CallState>
  /** a card waits on the Mac: its question */
  asking: string | null
  /** waiting in line on the guard: the standing, and what the row says runs */
  held: { held: MacBridgeHeld; tool: string; startedAt: number } | null
  /** the row while the session has none of its own (its first call, held) */
  provisional: ComputerSessionRow | null
  /** the box's last call listed `front` among its features: it parses that tier on a row (§26, decision 14) */
  readsFront?: boolean
}

/** A row as the box can parse it: an older box knows no `front`, which it reads as the session tier it stands beside. */
export function rowForPeer(row: ComputerSessionRow, readsFront: boolean): ComputerSessionRow {
  return !readsFront && row.tier === 'front' ? { ...row, tier: 'session' } : row
}

/** One call's rows to the box, at most one per COMPUTER_ROW_MS. */
interface RowSender {
  poke(): void
  close(): void
}

const REAL_CLOCK: MacComputerClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

let localCalls = 0

/** The call's gate on the box's word (mac.computerReader): every request waits while nobody there reads the call. */
function readerOf(own: CallState): NonNullable<ComputerToolContext['reader']> {
  const whenPresent = (signal: AbortSignal): Promise<void> =>
    own.reading || signal.aborted
      ? Promise.resolve()
      : new Promise((resolve) => {
          const done = (): void => {
            own.waiters.delete(done)
            signal.removeEventListener('abort', done)
            resolve()
          }
          own.waiters.add(done)
          signal.addEventListener('abort', done, { once: true })
        })
  return {
    present: () => own.reading,
    whenPresent,
    request: async (signal, send) => {
      while (!own.reading) {
        if (signal.aborted) throw new Error(abortedLine(signal) ?? hostErrorLine('cancelled'))
        await whenPresent(signal)
      }
      if (signal.aborted) throw new Error(abortedLine(signal) ?? hostErrorLine('cancelled'))
      own.out++
      try {
        return await send()
      } finally {
        own.out--
      }
    }
  }
}

const appOf = (call: ComputerToolCall): string => ('app' in call.args && typeof call.args.app === 'string' ? call.args.app : '')
const windowOf = (call: ComputerToolCall): string | null =>
  'window' in call.args && typeof call.args.window === 'string' ? call.args.window : null

/** The card's words from the sessions flow's approval input: `{ app, window, actions }`. */
function cardInput(input: unknown): MacBridgeComputer {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  return {
    app: typeof i.app === 'string' ? i.app : '',
    window: typeof i.window === 'string' ? i.window : null,
    actions: Array.isArray(i.actions) ? i.actions.filter((a): a is string => typeof a === 'string') : []
  }
}

export class MacComputer {
  private readonly states = new Map<string, KeyState>()
  private readonly clock: MacComputerClock
  private readonly log: (line: string) => void

  constructor(private readonly deps: MacComputerDeps) {
    this.clock = deps.clock ?? REAL_CLOCK
    this.log = deps.log ?? ((line) => console.log(`[mac-bridge] ${line}`))
  }

  handle(
    env: { id: string; name: string },
    thread: MacCallThread,
    method: MacComputerPeerMethod,
    args: unknown,
    ctx: { deadlineAt: number; callId?: string; progress?: (chunk: string) => void }
  ): Promise<ComputerPeerAnswer | MacComputerEndResult | MacComputerReaderResult> {
    if (method === 'mac.computerReader') return Promise.resolve(this.reader(env, thread, args))
    return method === 'mac.computerEnd' ? this.end(env, thread, args) : this.call(env, thread, args, ctx)
  }

  /**
   * mac.computerReader from the box. `false` sets a call's flag only while it
   * waits at a hold (no request out) and answers `{ held: true }`: nothing
   * passes its gate unread from now. One with a request out keeps its flag and
   * answers `{ held: false }`, so the box waits on as for a running call.
   */
  private reader(env: { id: string; name: string }, thread: MacCallThread, raw: unknown): MacComputerReaderResult {
    const { callIds, reading } = MacComputerReaderArgsSchema.parse(raw)
    const st = this.states.get(macComputerKey(env.id, thread.id))
    const calls = callIds.map((id) => st?.calls.get(id))
    if (reading) {
      for (const c of calls) if (c && !c.reading) {
        c.reading = true
        for (const wake of [...c.waiters]) wake()
      }
      return { held: false }
    }
    if (calls.some((c) => !c || c.out > 0)) return { held: false }
    for (const c of calls) if (c) c.reading = false
    return { held: true }
  }

  /** mac.cancel from the box: the named calls of the thread stop now (the box has answered them already). */
  cancel(envId: string, threadId: string, callIds: ReadonlySet<string>, reason: 'paused' | 'stopped' = 'stopped'): number {
    const st = this.states.get(macComputerKey(envId, threadId))
    if (!st) return 0
    let n = 0
    for (const [id, c] of st.calls) {
      if (!callIds.has(id)) continue
      c.controller.abort(reason === 'paused' ? 'paused' : 'interrupt')
      n++
    }
    return n
  }

  /** The switch went off, or the policy to Off: every live session of the host ends, its calls with it. */
  endHost(envId: string): void {
    const host = this.deps.host()
    for (const st of [...this.states.values()]) {
      if (st.envId !== envId) continue
      for (const c of st.calls.values()) c.controller.abort('ended')
      this.endLive(st, 'stopped')
      this.states.delete(st.key)
      void host?.sessions.end([st.key])
      void this.removeLanding(st.key)
    }
  }

  /** The link to a host dropped: its calls stop and its live sessions give their slots back; the service sessions stay for their idle close. */
  linkDown(envId: string): void {
    const host = this.deps.host()
    for (const st of this.states.values()) {
      if (st.envId !== envId) continue
      for (const c of st.calls.values()) c.controller.abort('ended')
      if (st.live) host?.sessions.settleTurn(st.key)
      this.endLive(st, 'stopped')
    }
  }

  liveCount(envId: string): number {
    let n = 0
    for (const st of this.states.values()) if (st.envId === envId && st.live) n++
    return n
  }

  close(): void {
    for (const st of this.states.values()) {
      for (const c of st.calls.values()) c.controller.abort('ended')
      this.endLive(st, 'stopped')
    }
    this.states.clear()
  }

  // ── one call ───────────────────────────────────────────────────────

  private async call(
    env: { id: string; name: string },
    thread: MacCallThread,
    raw: unknown,
    ctx: { deadlineAt: number; callId?: string; progress?: (chunk: string) => void }
  ): Promise<ComputerPeerAnswer> {
    const startedAt = this.clock.now()
    const parsed = MacComputerCallArgsSchema.safeParse(raw)
    if (!parsed.success) throw new Error(`refused: the call did not parse (${parsed.error.issues[0]?.message ?? 'bad arguments'})`)
    const { call, turn, rootId, features } = parsed.data
    if (call.threadId !== thread.id) throw new Error('refused: the call names another thread')
    const key = macComputerKey(env.id, thread.id)
    const line = (decision: string): void => this.log(`${env.name} (${env.id}) thread=${thread.id} mac.computer ${call.tool} → ${decision}`)

    // policy, then the switch, then whether this Mac can serve it at all
    if (this.deps.bridge.policyOf(env.id) === 'off') {
      line('refused (bridge off)')
      throw new Error(MAC_BRIDGE_OFF)
    }
    if (!this.deps.bridge.computerOf(env.id)) {
      line('refused (computer use off)')
      throw new Error(COMPUTER_SWITCH_OFF)
    }
    const host = this.deps.host()
    const why = this.deps.unavailable() ?? (host ? null : 'the computer host is not running')
    if (why || !host) {
      line(`refused (unavailable: ${why})`)
      throw new Error(computerUnavailableOnMac(why ?? 'the computer host is not running'))
    }
    // Away allows every card but a money act's: that one is refused before anything waits
    const awayDenies = !awayAllowsKind((call.args as { confirm?: { kind?: string } }).confirm?.kind)
    if (awayDenies && this.deps.bridge.away() && needsApproval(call.tool, call.args as Parameters<typeof needsApproval>[1], call.permission).ask) {
      line('refused (away, spends money)')
      throw new Error(MAC_AWAY_REFUSAL)
    }

    const checkedAt = this.clock.now()
    const st = this.stateOf(key, env.id, thread.id)
    st.readsFront = features?.includes('front') === true
    const callId = ctx.callId ?? `local_${++localCalls}`
    const own: CallState = { controller: new AbortController(), away: false, awayDenies, awayDenied: false, progress: null, reading: true, out: 0, waiters: new Set() }
    const signal = own.controller.signal
    st.calls.set(callId, own)
    this.disarmIdle(st)
    const deadline = this.clock.setTimeout(() => own.controller.abort('deadline'), Math.max(0, ctx.deadlineAt - REPLY_MARGIN_MS - this.clock.now()))
    own.progress = ctx.progress ? this.rowSender(st, ctx.progress) : null
    const rowsOff = own.progress ? host.sessions.onRows(() => own.progress?.poke()) : null
    try {
      if (st.turn !== turn) {
        st.turn = turn
        host.sessions.beginTurn(key)
      }
      const guardFrom = this.clock.now()
      await this.ensureLive(env, thread, st, call, own, ctx.deadlineAt, host)
      if (signal.aborted) throw new Error(hostErrorLine('cancelled'))
      const budget = computerCallBudgetMs(call)
      const tally = new CallTiming()
      const runFrom = this.clock.now()
      const outcome = await host.sessions.run(
        {
          threadId: key,
          rootId: macComputerKey(env.id, rootId),
          permission: () => call.permission,
          signal,
          approve: (req) => this.ask(env, thread, st, own, req, ctx.deadlineAt - budget, callId, line),
          reader: readerOf(own),
          timing: tally
        },
        call.tool,
        call.args
      )
      // a money card Away denied: the box writes the skipped row from this refusal (computer/bridge.ts)
      if (own.awayDenied) throw new Error(MAC_AWAY_REFUSAL)
      const shotsFrom = this.clock.now()
      const images = await this.readShots(outcome)
      const shotsTo = this.clock.now()
      const sessionRow = host.sessions.rowOf(key)
      const row = sessionRow && rowForPeer(sessionRow, st.readsFront === true)
      const first = row?.apps[0]
      if (st.live && first) this.deps.bridge.updateLive(st.live.id, { app: first.name, window: first.window })
      line(outcome.isError ? `answered: ${outcome.body ?? 'error'}` : `answered (${outcome.steps.length} step(s), ${images.length} picture(s))`)
      const span = (from: number, to: number): number => Math.max(0, Math.round(to - from))
      const timing: BridgeTiming = {
        macMs: span(startedAt, this.clock.now()),
        checksMs: span(startedAt, checkedAt),
        guardMs: span(guardFrom, runFrom),
        runMs: span(runFrom, shotsFrom),
        serviceMs: tally.serviceMs,
        waitedMs: tally.waitedMs,
        shotsMs: span(shotsFrom, shotsTo),
        shotChars: images.reduce((n, i) => n + i.data.length, 0)
      }
      return { steps: outcome.steps, body: outcome.body, isError: outcome.isError, ...(own.away ? { away: true as const } : {}), images, row, timing }
    } finally {
      this.clock.clearTimeout(deadline)
      rowsOff?.()
      own.progress?.close()
      st.calls.delete(callId)
      this.armIdle(st)
    }
  }

  /** The live session: reused within the turn, else a running request taken through the guard, in line when the caps are full. */
  private async ensureLive(
    env: { id: string; name: string },
    thread: MacCallThread,
    st: KeyState,
    call: ComputerToolCall,
    own: CallState,
    deadlineAt: number,
    host: MacComputerHost
  ): Promise<void> {
    if (st.live) return await st.live.ready
    const now = this.clock.now()
    const shape: ComputerRequestShape = {
      environmentId: env.id,
      hostName: env.name,
      sessionId: thread.id,
      threadTitle: String(thread.title ?? ''),
      kind: 'computer',
      method: 'mac.computer',
      computer: { app: appOf(call), window: windowOf(call), actions: [] }
    }
    const id = this.deps.bridge.openLive(shape, () => void this.stopFromMac(st))
    const until = Math.min(
      now + COMPUTER_HOLD_MAX_MS,
      deadlineAt - MAC_APPROVAL_WAIT_MS - COMPUTER_SESSION_WAIT_MS - computerCallBudgetMs(call) - REPLY_MARGIN_MS
    )
    const ready = this.deps.bridge.holdLive(env.id, id, until, {
      signal: own.controller.signal,
      onStanding: (held) => {
        st.held = { held, tool: call.tool, startedAt: now }
        if (!host.sessions.rowOf(st.key))
          st.provisional = {
            threadId: st.key,
            since: now,
            lastCallAt: now,
            apps: [{ name: appOf(call), bundleId: null, window: windowOf(call) }],
            running: { tool: call.tool, words: heldLine(held), startedAt: now },
            tier: null
          }
        own.progress?.poke()
      }
    })
    st.live = { id, ready, idleTimer: null }
    try {
      await ready
    } catch (err) {
      if (st.live?.id === id) st.live = null
      // A Stop or a cancel while in line answers in its own words, not the guard's.
      const given = own.controller.signal.aborted ? abortedLine(own.controller.signal) : null
      throw given ? new Error(given) : err
    } finally {
      st.held = null
      st.provisional = null
    }
  }

  /** A card on the Mac (the call's own, or the tier gate's): Allow or Deny, nothing remembered; Away answers it as it is made (allowed, or denied for a money act), checked again at every card. */
  private async ask(
    env: { id: string; name: string },
    thread: MacCallThread,
    st: KeyState,
    own: CallState,
    req: ApprovalRequest,
    leaveBy: number,
    callId: string,
    line: (decision: string) => void
  ): Promise<boolean> {
    if (this.deps.bridge.away()) {
      if (own.awayDenies) {
        own.awayDenied = true
        line('card denied (away, spends money)')
        return false
      }
      own.away = true
      line('card allowed (away)')
      return true
    }
    const signal = req.signal ?? own.controller.signal
    if (signal.aborted) return false
    const input = cardInput(req.input)
    const until = Math.min(this.clock.now() + MAC_APPROVAL_WAIT_MS, leaveBy - REPLY_MARGIN_MS)
    const { id, answer } = this.deps.bridge.askComputer(
      {
        environmentId: env.id,
        hostName: env.name,
        sessionId: thread.id,
        threadTitle: String(thread.title ?? ''),
        kind: 'computer',
        method: 'mac.computer',
        computer: input
      },
      until,
      callId,
      own.awayDenies ? { awayDenies: true } : {}
    )
    st.asking = approvalLine('computer', input, req.title)
    own.progress?.poke()
    let outcome: MacBridgeOutcome = 'denied'
    let onAbort: (() => void) | null = null
    const aborted = new Promise<{ allow: false; outcome: MacBridgeOutcome }>((resolve) => {
      onAbort = () => resolve({ allow: false, outcome: 'denied' })
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const decision = await Promise.race([answer, aborted])
      outcome = decision.outcome
      // decided by Away turning on while it waited (MacBridge.awayChanged)
      if ('byAway' in decision && decision.byAway) {
        if (decision.allow) own.away = true
        else own.awayDenied = true
      }
      line(`card ${decision.outcome}${'byAway' in decision && decision.byAway ? ' (away turned on)' : ''}`)
      return decision.allow
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort)
      this.deps.bridge.finishCard(id, outcome)
      st.asking = null
      own.progress?.poke()
    }
  }

  // ── the end of a turn, a Stop, the thread's end ────────────────────

  private async end(env: { id: string; name: string }, thread: MacCallThread, raw: unknown): Promise<MacComputerEndResult> {
    const { reason } = MacComputerEndArgsSchema.parse(raw)
    const key = macComputerKey(env.id, thread.id)
    const st = this.states.get(key)
    const host = this.deps.host()
    this.log(`${env.name} (${env.id}) thread=${thread.id} mac.computerEnd → ${reason}${st ? '' : ' (nothing held)'}`)
    if (!st) {
      if (reason === 'ended') await host?.sessions.end([key])
      return { ended: false }
    }
    if (reason === 'settled') {
      host?.sessions.settleTurn(key)
      this.endLive(st, 'done')
    } else if (reason === 'stopped') {
      // A call still in line is stopped too (the sessions host knows nothing of it yet), then the slot goes.
      for (const c of st.calls.values()) c.controller.abort('stopped')
      this.endLive(st, 'stopped')
      await host?.sessions.stop(key)
    } else {
      for (const c of st.calls.values()) c.controller.abort('ended')
      this.endLive(st, 'stopped')
      this.states.delete(key)
      await host?.sessions.end([key])
      await this.removeLanding(key)
    }
    return { ended: true }
  }

  /** Stop on the Mac's own row: computer use ends for the box thread's turn; the call in flight answers its steps so far and stopped. */
  private async stopFromMac(st: KeyState): Promise<void> {
    this.log(`thread=${st.threadId}: computer session stopped on the Mac`)
    this.endLive(st, 'stopped')
    await this.deps.host()?.sessions.stop(st.key)
  }

  // ── inside ─────────────────────────────────────────────────────────

  private stateOf(key: string, envId: string, threadId: string): KeyState {
    let st = this.states.get(key)
    if (!st) {
      st = { key, envId, threadId, turn: null, live: null, calls: new Map(), asking: null, held: null, provisional: null }
      this.states.set(key, st)
    }
    return st
  }

  private endLive(st: KeyState, outcome: MacBridgeOutcome): void {
    const live = st.live
    if (!live) return
    st.live = null
    if (live.idleTimer !== null) this.clock.clearTimeout(live.idleTimer)
    this.deps.bridge.finishLive(live.id, outcome)
  }

  /** No call out for COMPUTER_LIVE_IDLE_MS: the slot goes back; the next call takes one again. */
  private armIdle(st: KeyState): void {
    const live = st.live
    if (!live || st.calls.size) return
    if (live.idleTimer !== null) this.clock.clearTimeout(live.idleTimer)
    live.idleTimer = this.clock.setTimeout(() => {
      live.idleTimer = null
      if (st.live !== live || st.calls.size) return
      this.log(`thread=${st.threadId}: computer session idle, its slot given back`)
      this.deps.host()?.sessions.settleTurn(st.key)
      this.endLive(st, 'done')
    }, COMPUTER_LIVE_IDLE_MS)
  }

  private disarmIdle(st: KeyState): void {
    if (st.live?.idleTimer != null) {
      this.clock.clearTimeout(st.live.idleTimer)
      st.live.idleTimer = null
    }
  }

  /** The row the box mirrors: the session's own (else the provisional one), the standing while held, the card's question while one waits. */
  private rowNow(st: KeyState): ComputerSessionRow | null {
    const base = this.deps.host()?.sessions.rowOf(st.key) ?? st.provisional
    if (!base) return null
    const row: ComputerSessionRow = { ...base }
    if (st.held)
      row.running = { tool: st.held.tool, words: heldLine(st.held.held), startedAt: base.running?.startedAt ?? st.held.startedAt, held: true }
    if (st.asking) row.asking = { line: st.asking }
    return rowForPeer(row, st.readsFront === true)
  }

  private rowSender(st: KeyState, send: (chunk: string) => void): RowSender {
    let last = 0
    let timer: unknown = null
    let open = true
    const flush = (): void => {
      timer = null
      if (!open) return
      const row = this.rowNow(st)
      if (!row) return
      last = this.clock.now()
      send(JSON.stringify({ row }))
    }
    return {
      poke: () => {
        if (!open || timer !== null) return
        const wait = last + COMPUTER_ROW_MS - this.clock.now()
        if (wait <= 0) flush()
        else timer = this.clock.setTimeout(flush, wait)
      },
      close: () => {
        open = false
        if (timer !== null) this.clock.clearTimeout(timer)
        timer = null
      }
    }
  }

  /** The outcome's pictures as base64, in order; each file goes once read (they landed here only for this). */
  private async readShots(outcome: ComputerToolOutcome): Promise<ComputerPeerAnswer['images']> {
    const images: ComputerPeerAnswer['images'] = []
    for (const s of outcome.shots) {
      images.push({ label: s.label, data: (await readFile(s.path)).toString('base64'), mimeType: s.mimeType, width: s.width, height: s.height })
      await rm(s.path, { force: true }).catch(() => undefined)
    }
    return images
  }

  private async removeLanding(key: string): Promise<void> {
    const dir = this.deps.landing?.(key)
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
