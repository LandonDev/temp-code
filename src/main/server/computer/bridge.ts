import { randomBytes } from 'node:crypto'
import { approvalLine } from '@shared/approvalLine'
import type { ComputerSessionRow } from '@shared/contract-computer'
import { MAC_BRIDGE_OFFER } from '@shared/contract-macbridge'
import {
  COMPUTER_BAD_ANSWER,
  COMPUTER_BRIDGE_IDLE_CLOSE_MS,
  COMPUTER_MAC_WENT_OFFLINE,
  COMPUTER_NO_MAC,
  COMPUTER_OFFER_PREFIX,
  COMPUTER_ROW_MS,
  ComputerPeerAnswerSchema,
  ComputerPeerProgressSchema,
  MAC_COMPUTER_OFFER,
  askingWords,
  bridgedDeadlineMs,
  type ComputerPeerAnswer,
  type MacComputerEndArgs
} from '@shared/contract-maccomputer'
import { hostErrorLine } from '@shared/computer/hostErrors'
import type { ComputerToolCall, ComputerToolName } from '@shared/computer/tools'
import { computerActivity, computerApprovalInput, computerApprovalTitle } from '@shared/computer/words'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { MAC_AWAY_REFUSAL, MAC_AWAY_REFUSAL_LEGACY } from '../awayPrompts'
import { CANCELLED_PAUSED, CANCELLED_STOPPED, type MacPause } from '../macPause'
import { PeerOfflineError, type PeerCalls } from '../remote/peerCalls'
import type { MacThreadTokens } from '../macTools'
import { OfflineError } from '../threadResources'
import { refusal, type ComputerToolOutcome, type LandedShot } from './result'
import { abortedLine, checkComputerCall, type ComputerToolContext } from './run'
import { landShotBytes, nextShotNumber } from './shots'

/**
 * The box side of computer use through the Mac bridge (docs/box.md "Computer
 * use from a box thread"). A box thread whose bridge names a Mac that offers
 * computer use gets the four computer_* tools; each call is checked here,
 * then carried to the Mac as `mac.computer` (remote/macComputer.ts decides
 * and runs it), one at a time per thread. The Mac's answer comes back as its
 * step lines, body and pictures: the pictures land under this thread's own
 * attachment dir, so the result names files on this host. While a call is
 * out the Mac's row arrives as peer.progress and is mirrored here, re-keyed
 * to the thread, as its Activity row. The thread's turns, Stop, pause and
 * end reach the Mac as `mac.computerEnd` and `mac.cancel`.
 */

const SETTLED: readonly SessionStatus[] = ['idle', 'done', 'error', 'stopped', 'watching']
/** How long a Stop waits for the call in flight to answer its own steps before it is given up here. */
export const STOP_REPLY_MS = 10_000
/** A notice to the Mac (an end, a cancel): nothing waits on it. */
const NOTICE_DEADLINE_MS = 15_000

export interface BridgeClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: BridgeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface ComputerBridgeDeps {
  calls: Pick<PeerCalls, 'call' | 'cancel' | 'online' | 'offersOf'>
  /** The Mac a thread's bridge names (macTools.macPeerOf(id).macPeer). */
  macPeerOf: (sessionId: string) => string | null
  pause: Pick<MacPause, 'isPaused' | 'guard' | 'rootOf'>
  sessions: { get(id: string): SessionMeta | null | undefined; list(): SessionMeta[] }
  store: { getSetting(k: string): string | null; setSetting(k: string, v: string | null): void }
  /** Where the thread's pictures land: attachmentDir(session)/computer. */
  landing: (session: SessionMeta) => string
  /** What this host calls a Mac: its saved name, else its key's name, else its id. */
  macName: (envId: string) => string
  resources?: { recordComputer(sessionId: string, macPeer: string, label: string): void; computerEnded(sessionId: string, macPeer: string, note: string): void }
  /** The thread's tool set changed: its harness comes back with (or without) the tools at its next turn. */
  reboot?: (sessionId: string) => void
  /** The Mac decided a card for its away person: allowed (the answer says `away`) or denied (a money act; a Mac on an older build refused every one): the thread's away row. */
  awayNoticed?: (sessionId: string, kind: 'allowed' | 'approval', what: string) => void
  /** The call is held on the Mac (its line), or no longer (null): registry.setToolHold, so the thread's status says it. */
  held?: (sessionId: string, line: string | null) => void
  clock?: BridgeClock
  log?: (line: string) => void
}

interface Queued {
  /** answer now, without reaching the Mac */
  settle: (o: ComputerToolOutcome) => void
}

interface Inflight {
  callId: string | null
  macPeer: string
  giveUp: unknown
  /** Stop or the thread's end came while it was out: its late rows and reply restore no row and record no ledger entry. */
  closed: boolean
}

interface ThreadBridge {
  id: string
  /** the turn's number; a new turn clears Stop */
  turn: number
  status: SessionStatus | undefined
  stopped: boolean
  queue: Promise<unknown>
  queued: Set<Queued>
  inflight: Inflight | null
  /** the Mac's row, re-keyed; null while the session is not live */
  row: ComputerSessionRow | null
  /** the Mac this thread's calls went to, for its end */
  macPeer: string | null
  /** a live ledger row on that Mac */
  ledgered: boolean
  idleTimer: unknown
  nextShot: number | null
  /** the Mac's hold line last told to `deps.held` */
  holdLine: string | null
}

export class ComputerBridge {
  private readonly threads = new Map<string, ThreadBridge>()
  private readonly rowListeners = new Set<(rows: ComputerSessionRow[]) => void>()
  private readonly clock: BridgeClock
  private readonly log: (line: string) => void
  /** Turns are `<boot>:<n>`, so a Mac never takes a restarted box's turn 1 for the one it already saw. */
  private readonly boot = randomBytes(6).toString('base64url')
  private rowTimer: unknown = null
  private lastPush = 0

  constructor(private readonly deps: ComputerBridgeDeps) {
    this.clock = deps.clock ?? REAL_CLOCK
    this.log = deps.log ?? ((line) => console.log(`[computer-bridge] ${line}`))
  }

  // ── the offer ──────────────────────────────────────────────────────

  /** The thread's row, for the words its tools list in. */
  meta(sessionId: string): SessionMeta | null {
    return this.deps.sessions.get(sessionId) ?? null
  }

  /** The thread's bridge names a Mac whose last peer.register offered computer use to this host. */
  offered(sessionId: string): boolean {
    const mac = this.deps.macPeerOf(sessionId)
    if (!mac) return false
    const live = this.deps.calls.offersOf(mac)
    if (live) return live.has(MAC_COMPUTER_OFFER)
    return this.deps.store.getSetting(`${COMPUTER_OFFER_PREFIX}${mac}`) === 'on'
  }

  /** The thread's bridge names a Mac: its calls go there, and the Mac answers even a refusal (its switch off) in its own words. */
  bridged(sessionId: string): boolean {
    return this.deps.macPeerOf(sessionId) !== null
  }

  /** A Mac registered with another set of offers: kept for while it is offline; a flip reboots its bridged threads at their next turn. */
  offersChanged(envId: string, offers: ReadonlySet<string>): void {
    const on = offers.has(MAC_COMPUTER_OFFER)
    const key = `${COMPUTER_OFFER_PREFIX}${envId}`
    if ((this.deps.store.getSetting(key) === 'on') === on) return
    this.deps.store.setSetting(key, on ? 'on' : null)
    this.log(`${envId}: computer use ${on ? 'offered' : 'no longer offered'}`)
    for (const s of this.deps.sessions.list()) if (!s.archived && this.deps.macPeerOf(s.id) === envId) this.deps.reboot?.(s.id)
  }

  // ── one call ───────────────────────────────────────────────────────

  /** One call, as ComputerSessions.run serves a Mac thread; one at a time per thread, in arrival order. */
  run(ctx: ComputerToolContext, tool: string, args: unknown): Promise<ComputerToolOutcome> {
    const checked = checkComputerCall(tool, args)
    if (!checked.ok) return Promise.resolve(refusal(checked.line))
    const id = ctx.threadId
    const early = this.refusalFor(id, ctx.signal)
    if (early) return Promise.resolve(refusal(early))
    const t = this.thread(id)
    return new Promise<ComputerToolOutcome>((resolve) => {
      let done = false
      const settle = (o: ComputerToolOutcome): void => {
        if (done) return
        done = true
        t.queued.delete(entry)
        ctx.signal?.removeEventListener('abort', onAbort)
        resolve(o)
      }
      const entry: Queued = { settle }
      const onAbort = (): void => settle(refusal(abortedLine(ctx.signal) ?? hostErrorLine('cancelled')))
      t.queued.add(entry)
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      this.disarmIdle(t)
      t.queue = t.queue.then(async () => {
        if (done) return
        t.queued.delete(entry)
        ctx.signal?.removeEventListener('abort', onAbort)
        try {
          settle(await this.dispatch(t, ctx, checked.tool, checked.args))
        } catch (err) {
          this.log(`thread=${id}: computer call failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`)
          settle(refusal(`the computer call failed: ${err instanceof Error ? err.message : String(err)}`))
        } finally {
          this.armIdle(t)
        }
      })
    })
  }

  /** What refuses a call before it reaches the Mac: given up, Stopped this turn, paused, no Mac, the Mac offline. */
  private refusalFor(id: string, signal: AbortSignal | undefined): string | null {
    const given = abortedLine(signal)
    if (given) return given
    if (this.threads.get(id)?.stopped) return hostErrorLine('stopped')
    if (this.deps.pause.isPaused(id)) return hostErrorLine('paused')
    const mac = this.deps.macPeerOf(id)
    if (!mac) return hostErrorLine('service_unavailable', COMPUTER_NO_MAC)
    if (!this.deps.calls.online(mac, MAC_BRIDGE_OFFER)) return hostErrorLine('service_unavailable', new PeerOfflineError(mac).message)
    return null
  }

  private async dispatch(t: ThreadBridge, ctx: ComputerToolContext, tool: ComputerToolName, args: Record<string, unknown>): Promise<ComputerToolOutcome> {
    const id = t.id
    // the same refusals again: a call can be given up, Stopped or paused while it waits behind another
    const late = this.refusalFor(id, ctx.signal)
    if (late) return refusal(late)
    const mac = this.deps.macPeerOf(id)!
    const meta = this.deps.sessions.get(id)
    const permission = ctx.permission?.() ?? meta?.permission ?? 'safe'
    const call = { tool, args, threadId: id, permission } as ComputerToolCall
    const now = this.clock.now()
    t.macPeer = mac
    t.row = {
      ...(t.row ?? { threadId: id, since: now, lastCallAt: now, apps: [], tier: null, running: null }),
      macPeer: mac,
      macName: this.deps.macName(mac),
      running: { tool, words: computerActivity(tool, args)?.text ?? 'Using the computer', startedAt: now }
    }
    this.touched()

    const inflight: Inflight = { callId: null, macPeer: mac, giveUp: null, closed: false }
    t.inflight = inflight
    let given = false
    const onAbort = (): void => {
      given = true
      if (!inflight.callId) return
      this.deps.calls.cancel(inflight.callId, abortedLine(ctx.signal) ?? hostErrorLine('cancelled'))
      this.tell(mac, id, 'mac.cancel', { callIds: [inflight.callId], reason: 'stopped' })
    }
    ctx.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const raw = await this.deps.pause.guard({ sessionId: id, macPeer: mac, method: 'mac.computer', waitMs: 0, whilePaused: 'refuse' }, (callId) => {
        inflight.callId = callId
        if (given) return Promise.reject(new Error(abortedLine(ctx.signal) ?? hostErrorLine('cancelled')))
        return this.deps.calls.call<unknown>(
          mac,
          'mac.computer',
          { thread: { id, title: meta?.title ?? '', permission }, args: { call, turn: `${this.boot}:${t.turn}`, rootId: this.deps.pause.rootOf(id) } } as never,
          bridgedDeadlineMs(call),
          { callId, onProgress: (frame) => this.progress(t, inflight, frame.chunk) }
        )
      })
      return await this.answer(t, meta, call, raw, inflight)
    } catch (err) {
      return this.failure(t, call, err)
    } finally {
      ctx.signal?.removeEventListener('abort', onAbort)
      if (inflight.giveUp !== null) this.clock.clearTimeout(inflight.giveUp)
      if (t.inflight === inflight) t.inflight = null
      this.hold(t, null)
      if (t.row) {
        t.row = { ...t.row, running: null, lastCallAt: this.clock.now() }
        delete t.row.asking
        this.touched()
      }
    }
  }

  /** The Mac's answer as the outcome; one for a call Stop or the thread's end closed still answers, but moves neither the row nor the ledger. */
  private async answer(t: ThreadBridge, meta: SessionMeta | null | undefined, call: ComputerToolCall, raw: unknown, inflight: Inflight): Promise<ComputerToolOutcome> {
    const parsed = ComputerPeerAnswerSchema.safeParse(raw)
    if (!parsed.success) return refusal(hostErrorLine('service_unavailable', COMPUTER_BAD_ANSWER))
    const a: ComputerPeerAnswer = parsed.data
    const shots: LandedShot[] = []
    if (a.images.length && meta) {
      const dir = this.deps.landing(meta)
      t.nextShot ??= await nextShotNumber(dir)
      for (const image of a.images) {
        const { n, ...landed } = await landShotBytes(image, dir, t.nextShot)
        t.nextShot = n + 1
        shots.push(landed)
      }
    }
    // read after the pictures landed: a Stop or the thread's end may have come while they were written
    const closed = inflight.closed
    if (a.row && !closed) this.mirror(t, a.row)
    if (a.away) this.awayNotice(t.id, call, 'allowed')
    const mac = t.macPeer
    if (mac && !closed && !t.ledgered && this.deps.resources) {
      this.deps.resources.recordComputer(t.id, mac, a.row?.apps[0]?.name ?? ('app' in call.args ? String(call.args.app ?? '') : ''))
      t.ledgered = true
    }
    return { steps: a.steps, shots, body: a.body, isError: a.isError }
  }

  private failure(t: ThreadBridge, call: ComputerToolCall, err: unknown): ComputerToolOutcome {
    const message = err instanceof Error ? err.message : String(err)
    // a money act Away denied on the Mac; a Mac on the older build refused every asking call with its own words
    if (message === MAC_AWAY_REFUSAL || message === MAC_AWAY_REFUSAL_LEGACY) {
      this.awayNotice(t.id, call, 'approval')
      return refusal(message === MAC_AWAY_REFUSAL ? hostErrorLine('away') : message)
    }
    if (err instanceof PeerOfflineError) return refusal(COMPUTER_MAC_WENT_OFFLINE)
    if (message === CANCELLED_PAUSED || message === CANCELLED_STOPPED) return refusal(message)
    return refusal(message)
  }

  private awayNotice(id: string, call: ComputerToolCall, kind: 'allowed' | 'approval'): void {
    const args = call.args as Parameters<typeof computerApprovalTitle>[1] & { app?: string; window?: string }
    const titleCtx = { appName: args.app ?? 'an app', window: args.window ?? null, element: () => null }
    const title = computerApprovalTitle(call.tool, args, titleCtx)
    this.deps.awayNoticed?.(id, kind, approvalLine('computer', computerApprovalInput(call.tool, args, titleCtx), title))
  }

  /** A row from the Mac for the call in flight; one for a call that answered, was Stopped or ended is dropped, so it cannot set a hold again. */
  private progress(t: ThreadBridge, inflight: Inflight, chunk: string): void {
    if (inflight.closed || t.inflight !== inflight) return
    let json: unknown
    try {
      json = JSON.parse(chunk)
    } catch {
      return
    }
    const parsed = ComputerPeerProgressSchema.safeParse(json)
    if (parsed.success) this.mirror(t, parsed.data.row)
  }

  /** The Mac's row as this thread's: re-keyed, the Mac named, the card's words while one waits. */
  private mirror(t: ThreadBridge, row: ComputerSessionRow): void {
    const mac = t.macPeer
    if (!mac) return
    const macName = this.deps.macName(mac)
    const next: ComputerSessionRow = { ...row, threadId: t.id, macPeer: mac, macName }
    if (next.asking) next.running = { tool: next.running?.tool ?? 'computer_act', words: askingWords(macName), startedAt: next.running?.startedAt ?? this.clock.now() }
    t.row = next
    this.touched()
    // a card that replaces a hold is not a hold
    this.hold(t, next.running?.held && !next.asking ? next.running.words : null)
  }

  /** The thread's status says the Mac's hold line while the call waits there; told once per change. */
  private hold(t: ThreadBridge, line: string | null): void {
    if (t.holdLine === line) return
    t.holdLine = line
    this.deps.held?.(t.id, line)
  }

  // ── rows ───────────────────────────────────────────────────────────

  rows(): ComputerSessionRow[] {
    return [...this.threads.values()].flatMap((t) => (t.row ? [t.row] : []))
  }

  onRows(fn: (rows: ComputerSessionRow[]) => void): () => void {
    this.rowListeners.add(fn)
    return () => this.rowListeners.delete(fn)
  }

  private touched(): void {
    if (this.rowTimer !== null) return
    const wait = Math.max(0, this.lastPush + COMPUTER_ROW_MS - this.clock.now())
    this.rowTimer = this.clock.setTimeout(() => {
      this.rowTimer = null
      this.lastPush = this.clock.now()
      const rows = this.rows()
      for (const fn of this.rowListeners) fn(rows)
    }, wait)
  }

  // ── turns, Stop, the thread's end ──────────────────────────────────

  /** Stop on the Activity row: computer use ends for the thread's turn, here and on the Mac. */
  async stop(sessionId: string): Promise<boolean> {
    const t = this.threads.get(sessionId)
    if (!t) return false
    const wasLive = t.row !== null
    t.stopped = true
    for (const q of [...t.queued]) q.settle(refusal(hostErrorLine('stopped')))
    const mac = t.macPeer
    if (mac) {
      this.endOnMac(mac, t.id, 'stopped')
      // the Mac closes the session on a Stop: the ledger row goes, and the next session records one again
      if (t.ledgered) this.deps.resources?.computerEnded(t.id, mac, 'stopped by the person')
      t.ledgered = false
    }
    // the call in flight answers through its own reply (its steps so far, then stopped); one that never does is given up
    const inflight = t.inflight
    if (inflight) inflight.closed = true
    if (inflight)
      inflight.giveUp = this.clock.setTimeout(() => {
        if (inflight.callId) this.deps.calls.cancel(inflight.callId, hostErrorLine('stopped'))
      }, STOP_REPLY_MS)
    this.hold(t, null)
    this.endRow(t)
    return wasLive
  }

  /** The composer's Stop (session.interrupt): what waits in the thread's queue answers cancelled; MacPause cancels the call in flight. */
  cancel(sessionId: string): void {
    const t = this.threads.get(sessionId)
    if (!t) return
    for (const q of [...t.queued]) q.settle(refusal(CANCELLED_STOPPED))
  }

  /** registry.onMeta: a turn starts (Stop cleared) or settles (the Mac hears it, the row goes); an archive ends the thread. */
  onMeta(meta: SessionMeta): void {
    if (meta.archived) return this.threadsEnded([meta.id])
    const t = this.thread(meta.id)
    const prev = t.status
    t.status = meta.status
    if (prev === meta.status) return
    if ((meta.status === 'starting' || meta.status === 'running') && (prev === undefined || SETTLED.includes(prev))) {
      t.turn++
      t.stopped = false
      return
    }
    if (SETTLED.includes(meta.status) && t.row) {
      if (t.macPeer) this.endOnMac(t.macPeer, t.id, 'settled')
      this.endRow(t)
    }
  }

  /** Threads ended here (archived, deleted, moved away): their sessions end on the Mac and their ledger rows are stamped. */
  threadsEnded(ids: readonly string[]): void {
    for (const id of ids) {
      const t = this.threads.get(id)
      if (!t) continue
      this.threads.delete(id)
      if (t.inflight) t.inflight.closed = true
      this.hold(t, null)
      for (const q of [...t.queued]) q.settle(refusal(hostErrorLine('cancelled', 'the thread ended')))
      this.disarmIdle(t)
      if (t.macPeer) this.finish(t, t.macPeer, 'ended with the thread')
      if (t.row) {
        t.row = null
        this.touched()
      }
    }
  }

  /** The ledger's removal of a computer row: the session ends on its Mac. Rejects OfflineError while that Mac is offline. */
  async end(macPeer: string, thread: SessionMeta, sessionId: string): Promise<{ ended: boolean }> {
    if (!this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER)) throw new OfflineError(macPeer)
    const res = await this.deps.calls.call<{ ended?: boolean }>(
      macPeer,
      'mac.computerEnd',
      { thread: { id: sessionId, title: thread.title ?? '' }, args: { reason: 'ended' } } as never,
      NOTICE_DEADLINE_MS
    )
    const t = this.threads.get(sessionId)
    if (t) {
      t.ledgered = false
      this.disarmIdle(t)
      this.endRow(t)
    }
    return { ended: res?.ended === true }
  }

  /** A Mac's link dropped: its rows end; calls out on it fail through PeerCalls.drop. */
  linkDown(envId: string): void {
    for (const t of this.threads.values())
      if (t.macPeer === envId) {
        this.hold(t, null)
        this.endRow(t)
      }
  }

  close(): void {
    for (const t of this.threads.values()) {
      this.disarmIdle(t)
      if (t.inflight) t.inflight.closed = true
      this.hold(t, null)
      for (const q of [...t.queued]) q.settle(refusal(hostErrorLine('cancelled', 'the thread ended')))
    }
    if (this.rowTimer !== null) this.clock.clearTimeout(this.rowTimer)
    this.threads.clear()
    this.rowListeners.clear()
  }

  // ── inside ─────────────────────────────────────────────────────────

  private thread(id: string): ThreadBridge {
    let t = this.threads.get(id)
    if (!t) {
      t = { id, turn: 1, status: undefined, stopped: false, queue: Promise.resolve(), queued: new Set(), inflight: null, row: null, macPeer: null, ledgered: false, idleTimer: null, nextShot: null, holdLine: null }
      this.threads.set(id, t)
    }
    return t
  }

  private endRow(t: ThreadBridge): void {
    if (!t.row) return
    t.row = null
    this.touched()
  }

  /** The session ends on the Mac and its ledger row is stamped with why. */
  private finish(t: ThreadBridge, mac: string, note: string): void {
    this.endOnMac(mac, t.id, 'ended')
    if (t.ledgered) this.deps.resources?.computerEnded(t.id, mac, note)
    t.ledgered = false
  }

  /** Ten minutes with no call out or queued: the Mac session closes. */
  private armIdle(t: ThreadBridge): void {
    if (t.inflight || t.queued.size || !t.macPeer) return
    this.disarmIdle(t)
    t.idleTimer = this.clock.setTimeout(() => {
      t.idleTimer = null
      if (t.inflight || t.queued.size || !t.macPeer || this.threads.get(t.id) !== t) return
      this.log(`thread=${t.id}: computer session closed after 10 idle minutes`)
      this.finish(t, t.macPeer, 'closed after 10 idle minutes')
      this.endRow(t)
    }, COMPUTER_BRIDGE_IDLE_CLOSE_MS)
  }

  private disarmIdle(t: ThreadBridge): void {
    if (t.idleTimer === null) return
    this.clock.clearTimeout(t.idleTimer)
    t.idleTimer = null
  }

  private endOnMac(mac: string, sessionId: string, reason: MacComputerEndArgs['reason']): void {
    this.tell(mac, sessionId, 'mac.computerEnd', { reason })
  }

  /** One notice to the Mac, fire and forget: an offline Mac or a refusal changes nothing here. */
  private tell(mac: string, sessionId: string, method: 'mac.computerEnd' | 'mac.cancel', args: unknown): void {
    if (!this.deps.calls.online(mac, MAC_BRIDGE_OFFER)) return
    const title = this.deps.sessions.get(sessionId)?.title ?? ''
    this.deps.calls
      .call(mac, method, { thread: { id: sessionId, title }, args } as never, NOTICE_DEADLINE_MS)
      .catch((err: unknown) => this.log(`thread=${sessionId}: ${method} to ${mac} failed (${err instanceof Error ? err.message : String(err)})`))
  }
}

/**
 * The box's bridge, for the tools (computer/mcp.ts) and the RPCs
 * (computer/rpc.ts), and the per-thread tokens of purpose `computer` its
 * codex and Muse bridges carry; index.ts sets both.
 */
export const computerBridgeHooks: { current: ComputerBridge | null; tokens: MacThreadTokens | null } = { current: null, tokens: null }
