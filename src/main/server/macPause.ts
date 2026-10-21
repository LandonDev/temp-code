import { MAC_BRIDGE_OFFER, type MacCancelArgs, type MacHeldCall } from '@shared/contract-macbridge'
import type { MacPeerMethod } from '@shared/contract-macjobs'
import type { SessionMeta } from '@shared/events'
import { LIVE_STATUSES } from '@shared/session-lifecycle'
import { PeerCalls } from './remote/peerCalls'

/**
 * Pause reaches the Mac (docs/box.md "The Mac bridge", "Pause and Stop").
 * The box side of every mac.* call passes through here (macTools.ts), so a
 * thread's Mac work follows its status:
 *
 *  - A thread that pauses (or stops) has every call of its still out on the
 *    Mac cancelled: the box answers each at once with CANCELLED_PAUSED (or
 *    CANCELLED_STOPPED), which is what the harness's tool result says, and
 *    sends the Mac one `mac.cancel` per thread naming those calls, so the
 *    Mac gives them what its Stop button sends (a waiting card is denied, a
 *    running command killed) and ends the thread's interactive jobs. Its
 *    subagents' calls and jobs go with it: a thread is paused when it or
 *    any ancestor is (`parentId` chain), and a pause of a root reaches every
 *    call under it.
 *  - While paused, a new command, job or write call from the thread or a
 *    subagent is held here in arrival order and never sent: it answers after
 *    resume, when the hold lifts in that order, or at once with
 *    REFUSED_PAUSED once the time the caller would have waited (its
 *    timeoutMs) has gone by. Stop refuses what is held. A read is not held:
 *    it goes to the Mac marked `paused`, and the Mac answers it only where
 *    it needs no prompt (macBridge.ts).
 *  - The Mac sees what is held: `mac.held` carries the thread's whole held
 *    set whenever it changes, and the Mac lists each as a `paused` row
 *    without Stop. The box's own clients get `macBridge.held` with the
 *    count under the thread's root, for the paused strip.
 *
 * This hold is about the thread's state, nothing else: a call the load
 * guard holds for room is a different wait and does not pass through here.
 */

export const CANCELLED_PAUSED = 'cancelled: the thread was paused'
export const CANCELLED_STOPPED = 'cancelled: the thread was stopped'
export const REFUSED_PAUSED = 'refused: the thread is paused'
/** How long the Mac may take to act on a cancel or list a held set: nothing waits on it. */
const NOTICE_DEADLINE_MS = 15_000
const CHAIN_MAX = 32

const READS = new Set<string>(['mac.readFile', 'mac.listDir', 'mac.fetchFile'])
export const isMacRead = (method: string): boolean => READS.has(method)

export interface MacPauseDeps {
  sessions: { get(id: string): SessionMeta | null | undefined }
  calls: PeerCalls
  /** Threads with an interactive job on a Mac (macTools.ts jobThreads): their jobs end with the cancel. */
  jobThreads?: () => Iterable<[sessionId: string, macPeer: string]>
  /** The count a thread's tree holds changed (0 when none): the box's clients hear it as `macBridge.held`. */
  heldChanged?: (rootId: string, held: number) => void
  log?: (line: string) => void
  now?: () => number
}

/** One call out on the Mac right now. */
interface Inflight {
  callId: string
  sessionId: string
  macPeer: string
  method: MacPeerMethod
}

/** One call waiting here while its thread is paused. */
interface Held {
  id: string
  sessionId: string
  macPeer: string
  method: MacPeerMethod
  shape: Omit<MacHeldCall, 'id' | 'since' | 'method'>
  since: number
  timer: NodeJS.Timeout
  send: (callId: string) => Promise<unknown>
  resolve: (value: unknown) => void
  reject: (err: Error) => void
}

export interface GuardedCall {
  sessionId: string
  macPeer: string
  method: MacPeerMethod
  /** What the Mac's paused row shows (argv, cwd, path, bytes); never a file's contents. */
  shape?: Omit<MacHeldCall, 'id' | 'since' | 'method'>
  /** How long the caller would have waited for this call: a hold past it answers REFUSED_PAUSED. */
  waitMs: number
}

let heldSeq = 0

export class MacPause {
  /** Session ids whose status is `paused` right now (the roots and live descendants pauseRun marks). */
  private readonly paused = new Set<string>()
  private readonly inflight = new Map<string, Inflight>()
  private held: Held[] = []
  private readonly log: (line: string) => void
  private readonly now: () => number

  constructor(private readonly deps: MacPauseDeps) {
    this.log = deps.log ?? ((line) => console.log(`[mac-pause] ${line}`))
    this.now = deps.now ?? Date.now
  }

  // ── the tree ───────────────────────────────────────────────────────

  /** The thread, then its ancestors, root last (a cycle or a gap ends the walk). */
  private chain(sessionId: string): string[] {
    const out: string[] = []
    let id: string | null = sessionId
    for (let depth = 0; id && depth < CHAIN_MAX && !out.includes(id); depth++) {
      out.push(id)
      id = this.deps.sessions.get(id)?.parentId ?? null
    }
    return out
  }

  rootOf(sessionId: string): string {
    const chain = this.chain(sessionId)
    return chain[chain.length - 1] ?? sessionId
  }

  /** Whether `sessionId` is `ancestorId` or under it. */
  private under(sessionId: string, ancestorId: string): boolean {
    return this.chain(sessionId).includes(ancestorId)
  }

  /** Paused itself, or under a paused thread. */
  isPaused(sessionId: string): boolean {
    return this.chain(sessionId).some((id) => this.paused.has(id))
  }

  // ── one call ───────────────────────────────────────────────────────

  /**
   * Run one mac.* call through the gate: sent at once (and cancellable while
   * out) when the thread runs or the call is a read; held when paused.
   */
  guard<T>(call: GuardedCall, send: (callId: string) => Promise<T>): Promise<T> {
    if (isMacRead(call.method) || !this.isPaused(call.sessionId)) return this.dispatch(call, send)
    return new Promise<T>((resolve, reject) => {
      const id = `h${++heldSeq}_${this.now().toString(36)}`
      const held: Held = {
        id,
        sessionId: call.sessionId,
        macPeer: call.macPeer,
        method: call.method,
        shape: call.shape ?? {},
        since: this.now(),
        timer: setTimeout(
          () => this.settleHeld(held, new Error(REFUSED_PAUSED), 'refused (timeout)'),
          Math.max(0, call.waitMs)
        ),
        send: send as (callId: string) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject
      }
      held.timer.unref()
      this.held.push(held)
      this.log(`thread=${call.sessionId}: ${call.method} held (paused)`)
      this.changed(call.sessionId, call.macPeer)
    })
  }

  private async dispatch<T>(call: GuardedCall, send: (callId: string) => Promise<T>): Promise<T> {
    const callId = PeerCalls.newCallId()
    this.inflight.set(callId, {
      callId,
      sessionId: call.sessionId,
      macPeer: call.macPeer,
      method: call.method
    })
    try {
      return await send(callId)
    } finally {
      this.inflight.delete(callId)
    }
  }

  private settleHeld(held: Held, outcome: Error | { value: unknown }, why: string): void {
    const at = this.held.indexOf(held)
    if (at < 0) return
    this.held.splice(at, 1)
    clearTimeout(held.timer)
    if (outcome instanceof Error) held.reject(outcome)
    else held.resolve(outcome.value)
    this.log(`thread=${held.sessionId}: held ${held.method} ${why}`)
    this.changed(held.sessionId, held.macPeer)
  }

  // ── the thread's status ────────────────────────────────────────────

  /**
   * A thread's status changed (index.ts, from the registry's meta): into
   * `paused` cancels its tree's Mac work and starts holding; out of it to a
   * live status releases what is held, in order; out of it to anything else
   * (Stop, an error) refuses it.
   */
  onStatus(sessionId: string, status: SessionMeta['status']): void {
    if (status === 'paused') {
      if (this.paused.has(sessionId)) return
      this.paused.add(sessionId)
      this.cancelTree(sessionId, 'paused')
      return
    }
    if (!this.paused.delete(sessionId)) return
    if (LIVE_STATUSES.has(status)) this.release(sessionId)
    else this.refuseTree(sessionId, CANCELLED_STOPPED)
  }

  /** Stop (session.interrupt): the whole root tree's calls and jobs go, held ones included. */
  stop(sessionId: string): void {
    const root = this.rootOf(sessionId)
    this.cancelTree(root, 'stopped')
    this.refuseTree(root, CANCELLED_STOPPED)
  }

  /** Threads that ended here (archived, deleted, moved away): nothing of theirs waits or is paused any more. */
  ended(ids: readonly string[]): void {
    for (const id of ids) {
      this.paused.delete(id)
      this.refuseTree(id, CANCELLED_STOPPED)
    }
  }

  /** Every call out on a Mac under `rootId` fails now, and each Mac hears one `mac.cancel` per thread (jobs too). */
  private cancelTree(rootId: string, reason: MacCancelArgs['reason']): void {
    const text = reason === 'paused' ? CANCELLED_PAUSED : CANCELLED_STOPPED
    const byThread = new Map<string, { sessionId: string; macPeer: string; callIds: string[] }>()
    const key = (sessionId: string, macPeer: string): string => `${macPeer}\0${sessionId}`
    for (const call of [...this.inflight.values()]) {
      if (!this.under(call.sessionId, rootId)) continue
      this.inflight.delete(call.callId)
      this.deps.calls.cancel(call.callId, text)
      const group = byThread.get(key(call.sessionId, call.macPeer)) ?? {
        sessionId: call.sessionId,
        macPeer: call.macPeer,
        callIds: []
      }
      group.callIds.push(call.callId)
      byThread.set(key(call.sessionId, call.macPeer), group)
    }
    // A thread with a job on a Mac and nothing out right now still has that job to end.
    for (const [sessionId, macPeer] of this.deps.jobThreads?.() ?? []) {
      if (!this.under(sessionId, rootId) || byThread.has(key(sessionId, macPeer))) continue
      byThread.set(key(sessionId, macPeer), { sessionId, macPeer, callIds: [] })
    }
    for (const group of byThread.values()) {
      this.log(
        `thread=${group.sessionId}: ${reason}, ${group.callIds.length} call(s) on ${group.macPeer} cancelled`
      )
      this.tell(group.macPeer, group.sessionId, 'mac.cancel', {
        callIds: group.callIds,
        jobs: true,
        reason
      })
    }
  }

  /** The hold lifts for every held call under `rootId` whose thread is no longer paused, in arrival order. */
  private release(rootId: string): void {
    const touched = new Map<string, [string, string]>()
    for (const held of [...this.held]) {
      if (!this.under(held.sessionId, rootId) || this.isPaused(held.sessionId)) continue
      const at = this.held.indexOf(held)
      if (at < 0) continue
      this.held.splice(at, 1)
      clearTimeout(held.timer)
      this.log(`thread=${held.sessionId}: held ${held.method} released`)
      void this.dispatch(
        { sessionId: held.sessionId, macPeer: held.macPeer, method: held.method, waitMs: 0 },
        held.send
      ).then(held.resolve, held.reject)
      touched.set(`${held.macPeer}\0${held.sessionId}`, [held.sessionId, held.macPeer])
    }
    for (const [sessionId, macPeer] of touched.values()) this.changed(sessionId, macPeer)
  }

  private refuseTree(rootId: string, reason: string): void {
    for (const held of [...this.held])
      if (this.under(held.sessionId, rootId)) this.settleHeld(held, new Error(reason), 'refused')
  }

  // ── what is held, and who hears of it ──────────────────────────────

  /** Held calls under a thread (itself and its descendants), oldest first. */
  heldUnder(rootId: string): MacHeldCall[] {
    return this.held
      .filter((h) => this.under(h.sessionId, rootId))
      .map((h) => ({ id: h.id, method: h.method as MacHeldCall['method'], since: h.since, ...h.shape }))
  }

  heldCount(rootId: string): number {
    return this.held.filter((h) => this.under(h.sessionId, rootId)).length
  }

  /** The thread's held set changed: the Mac lists it anew, the box's clients get the root's count. */
  private changed(sessionId: string, macPeer: string): void {
    const own = this.held
      .filter((h) => h.sessionId === sessionId && h.macPeer === macPeer)
      .map<MacHeldCall>((h) => ({
        id: h.id,
        method: h.method as MacHeldCall['method'],
        since: h.since,
        ...h.shape
      }))
    this.tell(macPeer, sessionId, 'mac.held', { held: own })
    const root = this.rootOf(sessionId)
    this.deps.heldChanged?.(root, this.heldCount(root))
  }

  /** One notice to a Mac, fire and forget: an offline Mac or a refusal changes nothing here. */
  private tell(
    macPeer: string,
    sessionId: string,
    method: 'mac.cancel' | 'mac.held',
    args: MacCancelArgs | { held: MacHeldCall[] }
  ): void {
    if (!this.deps.calls.online(macPeer, MAC_BRIDGE_OFFER)) return
    const title = this.deps.sessions.get(sessionId)?.title ?? ''
    this.deps.calls
      .call(macPeer, method, { thread: { id: sessionId, title }, args }, NOTICE_DEADLINE_MS)
      .catch((err: unknown) =>
        this.log(
          `thread=${sessionId}: ${method} to ${macPeer} failed (${err instanceof Error ? err.message : String(err)})`
        )
      )
  }

  /** Everything waiting fails; for the app's end. */
  close(): void {
    for (const held of [...this.held]) {
      clearTimeout(held.timer)
      held.reject(new Error('server closing'))
    }
    this.held = []
    this.inflight.clear()
    this.paused.clear()
  }
}
