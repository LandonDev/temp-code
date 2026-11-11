import { SERVICE, type ActionResult, type BatchResult, type ComputerNotification, type StepResult, type Tier } from '@shared/computer/protocol'
import {
  ACTIVE_APP_SETTING,
  SCHEDULE,
  SESSION_IDLE_SETTING,
  activeApp,
  askAfter,
  clipboardQuiet,
  freedom,
  frontFreedom,
  sessionIdleMs,
  sessionRefusalWords,
  touchedSession,
  type Freedom,
  type SessionTierRefusal
} from '@shared/computer/scheduleRules'
import { hostErrorLine } from '@shared/computer/hostErrors'
import { COMPUTER_SESSION_TOOL, computerSessionAskTitle } from '@shared/computer/words'
import { CLIPBOARD_WAIT_WORDS, macFreeWords } from '@shared/statusWords'
import { READER_WAIT_WORDS } from '@shared/computer/heldCalls'
import type { OwnInputWindow, OwnSpan, PersonIdleSource } from '../../personIdle'
import type { PresenceSource } from '../../presence'
import type { ComputerService } from './service'
import type { ClipboardDecision, SessionTierGate, TierDecision, TierGateContext, TierGateRequest, TierGateRun } from './tierGate'

/**
 * The tier scheduler (docs/computer-protocol.md "Tier scheduling"): when a
 * step may use the `session` tier, the person's own pointer and keyboard.
 * It runs at once while the person is away (no input for
 * `computer.sessionIdleMs`, or the Away switch with ten seconds of quiet)
 * and waits otherwise, the thread saying "Waiting for the Mac to be free";
 * in full access it asks once after three minutes, with Run now and Skip
 * (in safe and edits at once). One session call runs at a time on the host,
 * and after every call that touched the session the person's front app and
 * pointer go back. The service stops a step the moment the person touches
 * the Mac; the restore then runs on its `session/interrupted` notice, before
 * the call's reply. A paste the service held off for the person's copy
 * waits here until the clipboard has been quiet for five seconds, at most
 * ten.
 */

export interface ScheduleClock {
  now(): number
  /** resolves after ms, or at once when the signal aborts */
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

const REAL_CLOCK: ScheduleClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(done, ms)
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
}

export interface SessionSchedulerOptions {
  service: Pick<ComputerService, 'request' | 'onNotification'>
  idle: PersonIdleSource
  presence: PresenceSource
  /** the Away switch (registry.awayOn) */
  awayOn: () => boolean
  /** `computer.sessionIdleMs`, read at every check */
  getSetting: (key: string) => string | null
  /** A thread's held line, or null when it ends: the registry's status detail and the computer row's words. */
  held: (threadId: string, line: string | null) => void
  /** The thread behind a service session id, for `session/interrupted`. */
  threadOf: (serviceSession: string) => string | null
  clock?: ScheduleClock
  /** Test and proof seams for SCHEDULE's numbers; the server sets none of them. */
  askAfterMs?: number
  recentCopyMs?: number
  pasteWaitMaxMs?: number
  pollMs?: number
  clipboardPollMs?: number
  log?: (line: string) => void
}

/** One session call at a time on the host, first come first served; the holder may enter again. */
export class SessionSlot {
  private held: string | null = null
  private readonly queue: { threadId: string; resolve: () => void; onPlace: (place: number) => void }[] = []

  /** Resolves once the thread holds the slot; `onPlace` hears its place in line (2 is next, behind the holder). Rejects on abort. */
  acquire(threadId: string, signal: AbortSignal, onPlace: (place: number) => void): Promise<void> {
    if (this.held === null || this.held === threadId) {
      this.held = threadId
      return Promise.resolve()
    }
    if (signal.aborted) return Promise.reject(new Error('the call was given up'))
    return new Promise((resolve, reject) => {
      const waiter = { threadId, resolve, onPlace }
      this.queue.push(waiter)
      signal.addEventListener(
        'abort',
        () => {
          const at = this.queue.indexOf(waiter)
          if (at < 0) return
          this.queue.splice(at, 1)
          this.announce()
          reject(new Error('the call was given up'))
        },
        { once: true }
      )
      this.announce()
    })
  }

  release(threadId: string): void {
    if (this.held !== threadId) return
    const next = this.queue.shift()
    this.held = next?.threadId ?? null
    next?.resolve()
    this.announce()
  }

  holder(): string | null {
    return this.held
  }

  /** Nobody holds it, or this thread does. */
  free(threadId: string): boolean {
    return this.held === null || this.held === threadId
  }

  private announce(): void {
    this.queue.forEach((w, i) => w.onPlace(i + 2))
  }
}

interface ThreadState {
  /** Run now, or the call's own card naming the session: valid until the person's next input */
  leaseFrom: number | null
  /** apps whose card was Skipped (or timed out) this turn */
  skipped: Set<string>
  /** a session-tier left_mouse_down ran with no up yet: the thread keeps the slot */
  heldDown: boolean
  /** the service lets go of a held button by itself SERVICE.heldInputReleaseMs after its down */
  heldExpiresAt: number
  heldTimer: AbortController | null
  inCall: boolean
  interruptedInCall: boolean
  /** a restore started by the person's touch */
  restoring: Promise<void> | null
  line: string | null
}

/** The app as a Skip remembers it. */
const appKeyOf = (app: TierGateContext['app']): string => (app.bundleId ?? app.name).toLowerCase()

/** how long a paste's first refusal is remembered: far past its deadline, so a later refusal of the same step never starts it again */
const PASTE_WAIT_KEEP_MS = 600_000

const stepsOf = (r: ActionResult | BatchResult | undefined): StepResult[] => (!r ? [] : 'steps' in r ? r.steps : [r.step])

export class SessionScheduler implements SessionTierGate {
  readonly pasteQuietMs: number
  private readonly slot = new SessionSlot()
  private readonly threads = new Map<string, ThreadState>()
  /** a paste's wait, by call and step: one deadline across its re-runs */
  private readonly pastes = new Map<string, { threadId: string; since: number }>()
  private readonly clock: ScheduleClock
  private readonly offNote: () => void

  constructor(private readonly opts: SessionSchedulerOptions) {
    this.clock = opts.clock ?? REAL_CLOCK
    this.pasteQuietMs = opts.recentCopyMs ?? SCHEDULE.recentCopyMs
    this.offNote = opts.service.onNotification((n) => this.onNotification(n))
  }

  admitted(ctx: TierGateContext): boolean {
    return this.threads.get(ctx.threadId)?.heldDown === true
  }

  /**
   * `front` (§26.6): at once under `computer.activeApp` `brief` (the default) or with Away on, never
   * locked or asleep; under `away` only while the session tier would be. The service's own keyboard-quiet
   * wait runs as each hold starts.
   */
  frontAdmitted(ctx: TierGateContext): boolean {
    return this.frontFreedom(this.state(ctx.threadId)).free
  }

  personIdleMs(): number {
    return this.opts.idle.getSystemIdleTime() * 1000
  }

  async request(ctx: TierGateRequest): Promise<TierDecision> {
    const st = this.state(ctx.threadId)
    const app = appKeyOf(ctx.app)
    const front = ctx.needed === 'front'
    // a front step admitted now needs no wait: the service brought the setting's answer back as needs_tier only because the call left it out
    if (front) {
      const f = this.frontFreedom(st)
      if (f.free) return { admit: true, via: f.via, waitedMs: 0 }
    }
    if (st.skipped.has(app)) return this.refuse('skipped-earlier', ctx)
    const started = this.clock.now()
    const ask = askAfter(ctx.permission, this.opts.askAfterMs ?? SCHEDULE.askAfterMs)
    let rechecked = false
    try {
      for (;;) {
        if (ctx.signal.aborted) return this.refuse('cancelled', ctx)
        const f = this.freedom(st)
        if (f.free) return { admit: true, via: f.via, waitedMs: this.clock.now() - started }
        if (front && this.frontFreedom(st).free) return { admit: true, via: 'away', waitedMs: this.clock.now() - started }
        // a locked or dark reading is checked again from the Mac's own facts before it refuses (a saver read as a lock, a stale picture)
        if ((f.why === 'locked' || f.why === 'asleep') && !rechecked) {
          rechecked = true
          await this.uncover(true)
          continue
        }
        if (f.why === 'locked') return this.refuse('screen-locked', ctx)
        if (f.why === 'asleep') return this.refuse('asleep', ctx)
        if (this.clock.now() - started >= ask) {
          this.setHeld(ctx.threadId, null)
          return await this.ask(ctx, st, app, started)
        }
        this.setHeld(ctx.threadId, macFreeWords())
        await this.clock.sleep(this.opts.pollMs ?? SCHEDULE.pollMs, ctx.signal)
      }
    } finally {
      this.setHeld(ctx.threadId, null)
    }
  }

  async run<T extends ActionResult | BatchResult>(ctx: TierGateRun, send: (tiers: Tier[]) => Promise<T>): Promise<T> {
    const st = this.state(ctx.threadId)
    // a passwordless screen saver goes before any step acts: the desktop comes back as at a key press
    if (this.opts.presence.snapshot().saver) await this.uncover(false)
    let tiers = ctx.tiers
    while (tiers.includes('session')) {
      try {
        await this.slot.acquire(ctx.threadId, ctx.signal, (place) => this.setHeld(ctx.threadId, macFreeWords(place)))
      } finally {
        this.setHeld(ctx.threadId, null)
      }
      // the person may have come back while the thread waited its turn: a held button's up still uses the tier its down did
      if (!st.heldDown && !this.freedom(st).free) {
        tiers = tiers.filter((t) => t !== 'session')
        this.slot.release(ctx.threadId)
        break
      }
      // a bridged call nobody reads now never sits on the person's Mac: the slot goes to the next thread, and it is admitted again from the top
      const reader = ctx.reader
      if (!reader || reader.present() || st.heldDown || ctx.signal.aborted) break
      this.slot.release(ctx.threadId)
      this.setHeld(ctx.threadId, READER_WAIT_WORDS)
      try {
        await reader.whenPresent(ctx.signal)
      } finally {
        this.setHeld(ctx.threadId, null)
      }
      const f = this.freedom(st)
      if (ctx.signal.aborted || !f.free) {
        tiers = tiers.filter((t) => t !== 'session')
        break
      }
    }
    const session = tiers.includes('session')
    // a front hold posts events to the app's pid: they move the system's idle time as a session step's do (§26.4)
    const own = session || tiers.includes('front') ? this.opts.idle.beginOwn() : null
    st.inCall = true
    st.interruptedInCall = false
    let result: T | undefined
    try {
      result = await send(tiers)
      return result
    } finally {
      await this.afterCall(ctx, st, session, result, own)
    }
  }

  async clipboard(ctx: TierGateRequest): Promise<ClipboardDecision> {
    const key = `${ctx.call}:${ctx.step}`
    const now = this.clock.now()
    for (const [k, p] of this.pastes) if (now - p.since > PASTE_WAIT_KEEP_MS) this.pastes.delete(k)
    const wait = this.pastes.get(key) ?? { threadId: ctx.threadId, since: now }
    this.pastes.set(key, wait)
    const deadline = wait.since + this.pasteWaitMaxMs()
    const cancelled = (): ClipboardDecision => ({ ok: false, cancelled: true, message: hostErrorLine('cancelled') })
    try {
      for (;;) {
        if (ctx.signal.aborted) return cancelled()
        let state
        try {
          state = await this.opts.service.request('clipboard.state', {}, { signal: ctx.signal })
        } catch (e) {
          if (ctx.signal.aborted) return cancelled()
          this.log(`clipboard.state failed: ${(e as Error).message}`)
          return { ok: false, message: hostErrorLine('clipboard_recent') }
        }
        const at = this.clock.now()
        if (at >= deadline) return { ok: false, message: hostErrorLine('clipboard_recent') }
        if (clipboardQuiet(state, at, this.pasteQuietMs)) return { ok: true, waitedMs: at - wait.since }
        this.setHeld(ctx.threadId, CLIPBOARD_WAIT_WORDS)
        await this.clock.sleep(Math.min(this.opts.clipboardPollMs ?? SCHEDULE.clipboardPollMs, deadline - at), ctx.signal)
      }
    } finally {
      this.setHeld(ctx.threadId, null)
    }
  }

  cardAllowed(ctx: TierGateContext, at: number): void {
    this.state(ctx.threadId).leaseFrom = at
  }

  async settle(threadId: string, why: 'turn-end' | 'stopped' | 'paused' | 'ended'): Promise<void> {
    const st = this.threads.get(threadId)
    if (!st) return
    st.leaseFrom = null
    if (why !== 'paused') st.skipped.clear()
    for (const [k, p] of this.pastes) if (p.threadId === threadId) this.pastes.delete(k)
    if (st.heldDown) {
      this.letGo(st)
      await this.restore(threadId, false)
    }
    if (!st.inCall) this.slot.release(threadId)
    this.setHeld(threadId, null)
    if (why === 'ended' && !st.inCall) this.threads.delete(threadId)
  }

  dispose(): void {
    this.offNote()
    for (const st of this.threads.values()) st.heldTimer?.abort()
  }

  private pasteWaitMaxMs(): number {
    return this.opts.pasteWaitMaxMs ?? SCHEDULE.pasteWaitMaxMs
  }

  private state(threadId: string): ThreadState {
    let st = this.threads.get(threadId)
    if (!st) {
      st = { leaseFrom: null, skipped: new Set(), heldDown: false, heldExpiresAt: 0, heldTimer: null, inCall: false, interruptedInCall: false, restoring: null, line: null }
      this.threads.set(threadId, st)
    }
    return st
  }

  private freedom(st: ThreadState): Freedom {
    const { screen, power } = this.opts.presence.snapshot()
    return freedom({
      now: this.clock.now(),
      idleS: this.opts.idle.getSystemIdleTime(),
      presence: { screen, power },
      awaySwitch: this.opts.awayOn(),
      sessionIdleMs: sessionIdleMs(this.opts.getSetting(SESSION_IDLE_SETTING)),
      leaseFrom: st.leaseFrom
    })
  }

  private frontFreedom(st: ThreadState): Freedom {
    const { screen, power } = this.opts.presence.snapshot()
    return frontFreedom({
      presence: { screen, power },
      awaySwitch: this.opts.awayOn(),
      mode: activeApp(this.opts.getSetting(ACTIVE_APP_SETTING)),
      session: this.freedom(st)
    })
  }

  /** Reads the screen again (`fresh`) and dismisses a passwordless saver; a real lock is left alone. */
  private async uncover(fresh: boolean): Promise<void> {
    const presence = this.opts.presence
    try {
      const p = fresh && presence.refresh ? await presence.refresh() : presence.snapshot()
      if (p.saver && presence.dismissSaver) await presence.dismissSaver()
    } catch (err) {
      this.opts.log?.(`[computer] screen re-check failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private refuse(reason: SessionTierRefusal, ctx: TierGateContext): TierDecision {
    return { admit: false, reason, message: sessionRefusalWords(reason, ctx.app.name) }
  }

  /** The one card: Run now leases the session tier until the person's next input; anything else refuses, and only a Skip is remembered. */
  private async ask(ctx: TierGateRequest, st: ThreadState, app: string, started: number): Promise<TierDecision> {
    if (!ctx.approve) {
      st.skipped.add(app)
      return this.refuse('skipped', ctx)
    }
    const where = { appName: ctx.app.name, window: ctx.window?.title ?? null }
    const allowed = await ctx.approve({
      toolName: COMPUTER_SESSION_TOOL,
      input: { app: where.appName, window: where.window, actions: [ctx.words] },
      title: computerSessionAskTitle(ctx.words, where, { front: ctx.needed === 'front' }),
      choices: 'run-skip',
      callId: ctx.callId,
      signal: ctx.signal
    })
    if (allowed) {
      st.leaseFrom = this.clock.now()
      this.log(`Run now for ${ctx.app.name} in ${ctx.threadId}`)
      return { admit: true, via: 'allowed', waitedMs: this.clock.now() - started }
    }
    if (ctx.signal.aborted) return this.refuse('cancelled', ctx)
    st.skipped.add(app)
    return this.refuse('skipped', ctx)
  }

  /** After every acting call, whatever happened: the held button, the spans, the restore, the slot. */
  private async afterCall(ctx: TierGateRun, st: ThreadState, session: boolean, result: ActionResult | BatchResult | undefined, own: OwnInputWindow | null): Promise<void> {
    const steps = stepsOf(result)
    const interrupted = st.interruptedInCall || steps.some((s) => s.status === 'failed' && s.error.kind === 'interrupted')
    // a call that ended without its answer (a Stop, the service gone) may have changed the Mac before it did
    let touched = touchedSession(steps)
    if (session && (!result || ctx.signal.aborted)) touched = true
    for (const s of steps) {
      const action = ctx.actions[s.index]?.action
      if (s.status !== 'ok' || s.tier !== 'session') continue
      if (action === 'left_mouse_down' && !interrupted) this.holdDown(ctx.threadId, st)
      if (action === 'left_mouse_up') this.letGo(st)
    }
    // a touch, a cut-short call or a cancel (pause, Stop) lets go of held input: the service did, or will on the cancel
    if (interrupted || !result || ctx.signal.aborted) this.letGo(st)
    const spans: OwnSpan[] = []
    for (const s of steps) {
      for (const c of s.status === 'ok' ? [s.session, s.front] : s.status === 'failed' ? [s.error.front] : [])
        if (c?.armedAt !== undefined && c.lastInputAt !== undefined && c.idleAtArmMs !== undefined)
          spans.push({ armedAt: c.armedAt, lastInputAt: c.lastInputAt, idleAtArmMs: c.idleAtArmMs })
    }
    own?.end(interrupted ? [] : spans)
    if (st.restoring) await st.restoring
    else if (st.heldDown && this.clock.now() >= st.heldExpiresAt) {
      // the service let go of the button during this call
      this.letGo(st)
      await this.restore(ctx.threadId, false)
    } else if (touched && !st.heldDown) await this.restore(ctx.threadId, interrupted)
    if (!st.heldDown) this.slot.release(ctx.threadId)
    st.inCall = false
    st.restoring = null
  }

  private holdDown(threadId: string, st: ThreadState): void {
    st.heldDown = true
    st.heldExpiresAt = this.clock.now() + SERVICE.heldInputReleaseMs + 2_000
    st.heldTimer?.abort()
    const timer = new AbortController()
    st.heldTimer = timer
    void this.clock.sleep(SERVICE.heldInputReleaseMs + 2_000, timer.signal).then(async () => {
      if (timer.signal.aborted || st.heldTimer !== timer) return
      st.heldTimer = null
      if (!st.heldDown || st.inCall) return
      st.heldDown = false
      await this.restore(threadId, false)
      if (!st.inCall && !st.heldDown) this.slot.release(threadId)
    })
  }

  private letGo(st: ThreadState): void {
    st.heldDown = false
    st.heldTimer?.abort()
    st.heldTimer = null
  }

  /** The person touched the Mac while the guard was on: their app comes back at once, before the call's reply. */
  private onNotification(n: ComputerNotification): void {
    if (n.method !== 'session/interrupted') return
    const threadId = this.opts.threadOf(n.params.session)
    if (!threadId) return
    const st = this.state(threadId)
    st.interruptedInCall = true
    st.leaseFrom = null
    this.opts.idle.markPerson(n.params.at)
    this.letGo(st)
    const restoring = this.restore(threadId, true)
    st.restoring = restoring
    if (st.inCall) return
    void restoring.then(() => {
      if (st.restoring === restoring) st.restoring = null
      if (!st.inCall && !st.heldDown) this.slot.release(threadId)
    })
  }

  /** Put the person's front app and pointer back; a failure is logged and never changes the call's result. */
  private async restore(threadId: string, afterInterrupt: boolean): Promise<void> {
    try {
      const r = await this.opts.service.request('input.restoreSession', afterInterrupt ? { afterInterrupt: true } : {})
      const g = r.personGuard
      this.log(`restore ${threadId} frontmost=${r.frontmost} pointer=${r.pointer}${afterInterrupt ? ' after-interrupt' : ''}${g ? ` guard=${g.mode} dropped=${g.dropped} replayed=${g.replayed} rearmed=${g.rearmed}` : ''}`)
    } catch (e) {
      this.log(`restore ${threadId} failed: ${(e as Error).message}`)
    }
  }

  private setHeld(threadId: string, line: string | null): void {
    const st = this.state(threadId)
    if (st.line === line) return
    st.line = line
    this.opts.held(threadId, line)
  }

  private log(line: string): void {
    ;(this.opts.log ?? console.log)(`[computer] schedule ${line}`)
  }
}
