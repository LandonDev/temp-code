import {
  HELD_TIMINGS,
  cancelledAfterStepsLine,
  cancelledPendingLine,
  endedUnreadLine,
  heldAnswerLine,
  stillHeldLine,
  unknownHeldLine,
  type HeldTimings
} from '@shared/computer/heldCalls'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { refusal, type ComputerToolOutcome } from './result'

/**
 * A bridged computer call that is held answers in time (docs/computer-protocol.md
 * §17 "A held call on the bridge"). One store per bridge socket. Every call it
 * starts gets an id (`c1`, `c2`…) and one reader, its own request. A call held
 * `answerMs` after it began (a card, the session tier, the clipboard, the
 * Mac's admission: whatever `holdWords` says, with no service request out)
 * answers anyway with its id and stays here as a pending call; `computer_result`
 * reads it again or cancels it. Nothing runs unread: every service request the
 * call makes goes through `CallReader.request`, which waits for a reader. A
 * pending call nobody reads for `unreadMs` is cancelled, and the thread's next
 * other computer call cancels it first and opens its answer with what happened.
 */

export interface CallReader {
  /** Someone will read this call's answer. */
  present(): boolean
  /** Resolves once someone reads, at once when someone does, or when the signal aborts. */
  whenPresent(signal: AbortSignal): Promise<void>
  /** A service request: waits for a reader, then counts as out until it ends. Throws when the signal aborts first. */
  request<T>(signal: AbortSignal, send: () => Promise<T>): Promise<T>
  /** Hears each change of present(). */
  onChange(fn: (present: boolean) => void): () => void
  /**
   * Who decides whether the last reader may leave: by default no request is
   * out here; the box's bridge asks the Mac, which holds the call's requests.
   * Resolves true once nothing can pass the gate unread.
   */
  releaseBy(fn: () => Promise<boolean>): void
}

export interface PendingClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const REAL_CLOCK: PendingClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
}

export interface PendingCallsOptions {
  timings?: HeldTimings
  clock?: PendingClock
  /** A thread's pending call lost its last reader, or got one back: the status line's hold follows it. */
  readerChanged?: (threadId: string) => void
}

export interface StartSpec {
  threadId: string
  /** the call in a few words, for the lines that say it was cancelled */
  what: string | null
  /** what holds the call now, or null while nothing does (its row's held line) */
  holdWords: () => string | null
  run: (ctx: { signal: AbortSignal; reader: CallReader }) => Promise<ComputerToolOutcome>
}

/** Why a call was cancelled softly: the box waits for the Mac to say what ran (bridge.ts). */
export const SOFT_CANCELS = ['unread', 'superseded', 'cancel'] as const
export type SoftCancel = (typeof SOFT_CANCELS)[number]
export const isSoftCancel = (reason: unknown): reason is SoftCancel => (SOFT_CANCELS as readonly unknown[]).includes(reason)

interface Entry {
  id: string
  threadId: string
  what: string | null
  startedAt: number
  holdWords: () => string | null
  abort: AbortController
  done: ComputerToolOutcome | null
  finished: Promise<ComputerToolOutcome>
  readers: number
  /** service requests out */
  out: number
  /** answered early: it lives here until read, cancelled or dropped */
  pending: boolean
  unreadTimer: unknown
  presence: Set<(present: boolean) => void>
  /** woken on any change: a hold, a reader, a request, the end */
  wakers: Set<() => void>
  release: () => Promise<boolean>
}

export class PendingCalls {
  private readonly entries = new Map<string, Entry>()
  /** lines the thread's next computer answer opens with, once */
  private readonly told = new Map<string, string[]>()
  private readonly timings: HeldTimings
  private readonly clock: PendingClock
  private next = 0

  constructor(private readonly opts: PendingCallsOptions = {}) {
    this.timings = opts.timings ?? HELD_TIMINGS
    this.clock = opts.clock ?? REAL_CLOCK
  }

  /**
   * One call with its own request as its reader. Answers its result, or held
   * with its id once `answerMs` passed while it waits on a hold. The signal is
   * the request's own: a cancel of it cancels the call while it still reads.
   */
  start(spec: StartSpec, signal: AbortSignal): Promise<ComputerToolOutcome> {
    const e: Entry = {
      id: `c${++this.next}`,
      threadId: spec.threadId,
      what: spec.what,
      startedAt: this.clock.now(),
      holdWords: spec.holdWords,
      abort: new AbortController(),
      done: null,
      finished: Promise.resolve(refusal(hostErrorLine('cancelled'))),
      readers: 1,
      out: 0,
      pending: false,
      unreadTimer: null,
      presence: new Set(),
      wakers: new Set(),
      release: () => Promise.resolve(e.out === 0)
    }
    this.entries.set(e.id, e)
    e.finished = spec
      .run({ signal: e.abort.signal, reader: this.readerOf(e) })
      .catch((err: unknown) => refusal(`the computer call failed: ${err instanceof Error ? err.message : String(err)}`))
      .then((o) => {
        e.done = o
        this.disarmUnread(e)
        this.wake(e)
        return o
      })
    return this.read(e, e.startedAt + this.timings.answerMs, 'held', signal)
  }

  /** `computer_result`: the call's result, still held after `waitMs`, or with `cancel` cancelled and what ran. */
  async result(threadId: string, id: string, cancel: boolean, signal: AbortSignal): Promise<ComputerToolOutcome> {
    const e = this.entries.get(id)
    if (!e || e.threadId !== threadId || !e.pending) return refusal(unknownHeldLine(id))
    if (cancel) {
      this.forget(e)
      return { steps: await this.cancelledLines(e, 'cancel'), shots: [], body: null, isError: false }
    }
    this.attach(e)
    return await this.read(e, this.clock.now() + this.timings.waitMs, 'still', signal)
  }

  /** Another computer call on the thread: its pending calls are cancelled first; the lines its answer opens with. */
  async supersede(threadId: string): Promise<string[]> {
    const lines: string[] = []
    for (const e of [...this.entries.values()]) {
      if (e.threadId !== threadId || !e.pending || e.readers > 0) continue
      this.forget(e)
      lines.push(...(await this.cancelledLines(e, 'superseded')))
    }
    return [...this.take(threadId), ...lines]
  }

  /** The lines an answer of the thread opens with, once. */
  take(threadId: string): string[] {
    const lines = this.told.get(threadId) ?? []
    this.told.delete(threadId)
    return lines
  }

  /** A hold may have changed (the rows moved): every waiting reader looks again. */
  poke(): void {
    for (const e of this.entries.values()) this.wake(e)
  }

  /** The thread's turn settled or paused: its calls here are cancelled and forgotten. */
  settle(threadId: string, why: 'settled' | 'paused'): void {
    for (const e of [...this.entries.values()]) {
      if (e.threadId !== threadId) continue
      this.forget(e)
      e.abort.abort(why)
    }
    this.told.delete(threadId)
  }

  /** The bridge socket closed: every call goes. */
  closeAll(): void {
    for (const e of [...this.entries.values()]) {
      this.forget(e)
      e.abort.abort('ended')
    }
    this.told.clear()
  }

  /** A call of the thread answered early and nobody reads it now: its hold is no longer the thread's status. */
  unread(threadId: string): boolean {
    for (const e of this.entries.values()) if (e.threadId === threadId && e.pending && !e.done && e.readers === 0) return true
    return false
  }

  // ── inside ─────────────────────────────────────────────────────────

  /** One reader waiting on the call: its result, or held past `deadline`, or its own request cancelled. */
  private async read(e: Entry, deadline: number, kind: 'held' | 'still', signal: AbortSignal): Promise<ComputerToolOutcome> {
    let releasing = false
    for (;;) {
      if (e.done) {
        this.forget(e)
        return e.done
      }
      if (signal.aborted) return await this.leave(e, kind, signal)
      if (!releasing && this.clock.now() >= deadline && e.out === 0) {
        const line = e.holdWords()
        if (line !== null) {
          if (e.readers > 1) {
            this.detach(e)
            return this.heldOutcome(e, kind, line)
          }
          releasing = true
          // the last reader: it leaves only once nothing can pass the gate unread (local: no request out; the box: the Mac's word)
          const ok = await e.release().catch(() => false)
          releasing = false
          if (e.done) continue
          if (ok && !signal.aborted) {
            this.detach(e)
            // another reader came while the gate was being shut: it is read again
            if (e.readers > 0) for (const fn of [...e.presence]) fn(true)
            return this.heldOutcome(e, kind, e.holdWords() ?? line)
          }
          if (ok) continue
        }
      }
      await this.waitChange(e, Math.max(0, deadline - this.clock.now()), signal)
    }
  }

  /** A reader's own request was cancelled. The call's own request cancels the call; a `computer_result` only ends its read, unless the call was running for it. */
  private async leave(e: Entry, kind: 'held' | 'still', signal: AbortSignal): Promise<ComputerToolOutcome> {
    const line = abortedWords(signal)
    if (kind === 'held') {
      this.forget(e)
      e.abort.abort(signal.reason ?? 'given-up')
      return refusal(line)
    }
    if (e.readers > 1) {
      this.detach(e)
      return refusal(line)
    }
    const ok = await e.release().catch(() => false)
    this.detach(e)
    if (!ok && !e.done) e.abort.abort('unread')
    return refusal(line)
  }

  private heldOutcome(e: Entry, kind: 'held' | 'still', line: string): ComputerToolOutcome {
    const waited = this.clock.now() - e.startedAt
    return { steps: [], shots: [], body: kind === 'held' ? heldAnswerLine(e.id, waited, line) : stillHeldLine(waited, line), isError: false }
  }

  /** The lines that say what became of a cancelled (or ended, unread) call. */
  private async cancelledLines(e: Entry, why: SoftCancel): Promise<string[]> {
    const ended = e.done
    if (!ended) e.abort.abort(why)
    const o = await e.finished
    if (ended) return [...o.steps, endedUnreadLine(e.id, e.what, o.body)]
    return o.steps.length ? [cancelledAfterStepsLine(e.id, e.what), ...o.steps] : [cancelledPendingLine(e.id, e.what)]
  }

  private attach(e: Entry): void {
    e.readers++
    this.disarmUnread(e)
    if (e.readers === 1) this.presenceChanged(e, true)
  }

  /** A reader leaves: the call is pending now; with nobody left, the unread rule's clock starts. */
  private detach(e: Entry): void {
    e.readers = Math.max(0, e.readers - 1)
    e.pending = true
    if (e.readers > 0) return
    this.presenceChanged(e, false)
    this.disarmUnread(e)
    if (e.done) return
    e.unreadTimer = this.clock.setTimeout(() => {
      e.unreadTimer = null
      if (e.readers > 0 || e.done || this.entries.get(e.id) !== e) return
      this.forget(e)
      void this.cancelledLines(e, 'unread').then((lines) => this.told.set(e.threadId, [...(this.told.get(e.threadId) ?? []), ...lines]))
    }, this.timings.unreadMs)
  }

  private forget(e: Entry): void {
    if (this.entries.get(e.id) !== e) return
    this.entries.delete(e.id)
    this.disarmUnread(e)
    // a call forgotten while unread is no longer anyone's to read: its status line says its hold again
    if (e.pending && e.readers === 0) this.opts.readerChanged?.(e.threadId)
  }

  private disarmUnread(e: Entry): void {
    if (e.unreadTimer === null) return
    this.clock.clearTimeout(e.unreadTimer)
    e.unreadTimer = null
  }

  private presenceChanged(e: Entry, present: boolean): void {
    for (const fn of [...e.presence]) fn(present)
    this.wake(e)
    if (e.pending) this.opts.readerChanged?.(e.threadId)
  }

  private wake(e: Entry): void {
    for (const fn of [...e.wakers]) fn()
  }

  /** Until anything about the call changes, `ms` pass, or the signal aborts. */
  private waitChange(e: Entry, ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        e.wakers.delete(done)
        signal.removeEventListener('abort', done)
        if (timer !== null) this.clock.clearTimeout(timer)
        resolve()
      }
      const timer = ms > 0 ? this.clock.setTimeout(done, ms) : null
      e.wakers.add(done)
      signal.addEventListener('abort', done, { once: true })
    })
  }

  private readerOf(e: Entry): CallReader {
    const present = (): boolean => e.readers > 0
    const whenPresent = (signal: AbortSignal): Promise<void> =>
      present() || signal.aborted
        ? Promise.resolve()
        : new Promise((resolve) => {
            const done = (): void => {
              e.presence.delete(on)
              signal.removeEventListener('abort', done)
              resolve()
            }
            const on = (p: boolean): void => {
              if (p) done()
            }
            e.presence.add(on)
            signal.addEventListener('abort', done, { once: true })
          })
    return {
      present,
      whenPresent,
      request: async (signal, send) => {
        // the check and the count in one step: a reader leaves only with nothing out
        while (!present()) {
          if (signal.aborted) throw new Error(abortedWords(signal))
          await whenPresent(signal)
        }
        if (signal.aborted) throw new Error(abortedWords(signal))
        e.out++
        try {
          return await send()
        } finally {
          e.out--
          this.wake(e)
        }
      },
      onChange: (fn) => {
        e.presence.add(fn)
        return () => e.presence.delete(fn)
      },
      releaseBy: (fn) => {
        e.release = fn
      }
    }
  }
}

const abortedWords = (signal: AbortSignal): string =>
  typeof signal.reason === 'string' && signal.reason.startsWith('cancelled') ? signal.reason : hostErrorLine('cancelled')
