import { afterEach, describe, expect, it } from 'vitest'
import type { ActionResult, BatchResult, ClipboardActivity, ComputerAction, ComputerNotification, SessionChange, SessionRestore, StepResult, Tier } from '@shared/computer/protocol'
import type { MacPresence } from '@shared/contract-relay'
import type { OwnSpan } from '../../personIdle'
import type { ApprovalRequest } from '../drivers/types'
import { SessionScheduler, SessionSlot, type ScheduleClock } from './schedule'
import { settle } from './testFake'
import { READER_WAIT_WORDS } from '@shared/computer/heldCalls'
import type { TierGateContext, TierGateRequest, TierGateRun } from './tierGate'

const T0 = 1_800_000_000_000

/** A clock whose sleeps resolve only when the test moves it. */
class FakeClock implements ScheduleClock {
  t = T0
  private sleepers: { at: number; resolve: () => void }[] = []
  now = (): number => this.t
  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve()
      const s = { at: this.t + ms, resolve }
      this.sleepers.push(s)
      signal?.addEventListener(
        'abort',
        () => {
          this.sleepers = this.sleepers.filter((x) => x !== s)
          resolve()
        },
        { once: true }
      )
    })
  async advance(ms: number): Promise<void> {
    const until = this.t + ms
    for (;;) {
      this.sleepers.sort((a, b) => a.at - b.at)
      const due = this.sleepers[0]
      if (!due || due.at > until) break
      this.sleepers.shift()
      this.t = due.at
      due.resolve()
      await settle()
    }
    this.t = until
    await settle()
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
}
const deferred = <T,>(): Deferred<T> => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

function world() {
  const clock = new FakeClock()
  /** the person's last input, epoch ms */
  let lastInput = T0 - 300_000
  const ends: OwnSpan[][] = []
  const idle = {
    getSystemIdleTime: () => Math.floor((clock.now() - lastInput) / 1000),
    beginOwn: () => ({ end: (spans: OwnSpan[]) => void ends.push(spans) })
  }
  let presence: MacPresence = { screen: 'unlocked', power: 'awake', at: 0 }
  let away = false
  const settings = new Map<string, string>()
  const lines: [string, string | null][] = []
  const logs: string[] = []
  const restores: (Record<string, unknown> | undefined)[] = []
  let restoreHold: Deferred<void> | null = null
  let restoreThrows = false
  let clipboard: ClipboardActivity = { changeCount: 1, foreignChangeAt: null, watchingSince: T0 - 60_000 }
  const notes = new Set<(n: ComputerNotification) => void>()
  const service = {
    request: async (method: string, params?: unknown): Promise<never> => {
      if (method === 'input.restoreSession') {
        restores.push(params as Record<string, unknown>)
        if (restoreHold) await restoreHold.promise
        if (restoreThrows) throw new Error('the service is gone')
        return { frontmost: 'restored', pointer: 'restored', held: null } satisfies SessionRestore as never
      }
      if (method === 'clipboard.state') return { ...clipboard } as never
      throw new Error(`unexpected ${method}`)
    },
    onNotification: (fn: (n: ComputerNotification) => void) => {
      notes.add(fn)
      return () => notes.delete(fn)
    }
  }
  const cards: { req: ApprovalRequest; decide: (allow: boolean) => void }[] = []
  const approve = (req: ApprovalRequest): Promise<boolean> =>
    new Promise((resolve) => {
      // the registry allows a card while away (sessions.ts requestApproval): Run now
      if (away) return resolve(true)
      cards.push({ req, decide: resolve })
      req.signal?.addEventListener('abort', () => resolve(false), { once: true })
    })
  const opts: { askAfterMs?: number } = {}
  const make = (o: { askAfterMs?: number } = opts): SessionScheduler =>
    new SessionScheduler({
      service: service as never,
      idle,
      presence: { snapshot: () => presence, onChange: () => () => {} },
      awayOn: () => away,
      getSetting: (k) => settings.get(k) ?? null,
      held: (t, l) => void lines.push([t, l]),
      threadOf: (s) => s,
      clock,
      log: (l) => void logs.push(l),
      ...o
    })
  return {
    clock,
    ends,
    lines,
    logs,
    restores,
    cards,
    approve,
    settings,
    make,
    /** the person touches the Mac now */
    input: () => (lastInput = clock.now()),
    idleFor: (ms: number) => (lastInput = clock.now() - ms),
    setPresence: (p: Partial<MacPresence>) => (presence = { ...presence, ...p }),
    setAway: (on: boolean) => (away = on),
    holdRestore: () => (restoreHold = deferred<void>()),
    releaseRestore: () => {
      restoreHold?.resolve()
      restoreHold = null
    },
    failRestores: () => (restoreThrows = true),
    setClipboard: (c: Partial<ClipboardActivity>) => (clipboard = { ...clipboard, ...c }),
    interrupt: (session: string) => {
      for (const fn of notes) fn({ method: 'session/interrupted', params: { session, by: 'person', at: clock.now() } })
    }
  }
}
type World = ReturnType<typeof world>

const scheds: SessionScheduler[] = []
afterEach(() => {
  for (const s of scheds.splice(0)) s.dispose()
})
const setup = (o?: { askAfterMs?: number }) => {
  const w = world()
  const s = w.make(o)
  scheds.push(s)
  return { w, s }
}

const ctxOf = (w: World, threadId = 't1', patch: Partial<TierGateContext> = {}): TierGateContext => ({
  threadId,
  rootId: threadId,
  permission: 'auto',
  app: { pid: 16800, bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
  window: { id: 1581, title: 'Untitled' },
  classes: ['click'],
  serviceSession: threadId,
  callId: 'toolu_1',
  approve: w.approve,
  ...patch
})
const reqOf = (w: World, threadId = 't1', patch: Partial<TierGateRequest> = {}): TierGateRequest => ({
  ...ctxOf(w, threadId),
  step: 0,
  action: { action: 'left_click', element: 14 },
  words: 'click button "Save"',
  call: `${threadId}:1`,
  signal: new AbortController().signal,
  ...patch
})
const runOf = (w: World, threadId: string, tiers: Tier[], actions: ComputerAction[], signal = new AbortController().signal): TierGateRun => ({
  ...ctxOf(w, threadId),
  tiers,
  actions,
  signal
})
const change = (span = true): SessionChange => ({
  frontmost: {},
  pointer: { before: [1, 1], after: [2, 2] },
  restorable: true,
  ...(span ? { armedAt: T0 + 1, idleAtArmMs: 130_000, lastInputAt: T0 + 2 } : {})
})
const ok = (action: ComputerAction['action'], tier: Tier, index = 0): StepResult =>
  ({ index, action, status: 'ok', tier, effect: 'changed', ...(tier === 'session' ? { session: change() } : {}) }) as StepResult
const single = (step: StepResult): ActionResult => ({ step })
const batch = (steps: StepResult[]): BatchResult => ({ steps, waited: { waitedMs: 0, settled: true, busy: false, reason: 'quiet' } })
const linesOf = (w: World, threadId = 't1') => w.lines.filter(([t]) => t === threadId).map(([, l]) => l)
/** The person types every second for ms: the Mac never reads as free. */
async function typing(w: World, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 1_000) {
    w.input()
    await w.clock.advance(Math.min(1_000, left))
  }
}

describe('admission', () => {
  it('admits at once while the person is away, with no held line and no card; a new setting counts at the next look', async () => {
    const { w, s } = setup()
    w.idleFor(130_000)
    expect(await s.request(reqOf(w))).toEqual({ admit: true, via: 'away', waitedMs: 0 })
    expect(w.lines).toEqual([])
    expect(w.cards).toEqual([])
    w.idleFor(30_000)
    const held = s.request(reqOf(w))
    await w.clock.advance(1_000)
    expect(linesOf(w)).toEqual(['Waiting for the Mac to be free'])
    w.settings.set('computer.sessionIdleMs', '20000')
    await w.clock.advance(1_000)
    expect(await held).toEqual({ admit: true, via: 'away', waitedMs: 2_000 })
    expect(linesOf(w).at(-1)).toBeNull()
  })

  it('takes the Away switch after ten seconds of quiet, and holds before', async () => {
    const { w, s } = setup()
    w.setAway(true)
    w.idleFor(12_000)
    expect(await s.request(reqOf(w))).toMatchObject({ admit: true, via: 'switch' })
    w.idleFor(3_000)
    const held = s.request(reqOf(w))
    await w.clock.advance(5_000)
    expect(linesOf(w)).toContain('Waiting for the Mac to be free')
    await w.clock.advance(3_000)
    expect(await held).toMatchObject({ admit: true, via: 'switch', waitedMs: 7_000 })
  })

  it('holds a present person in full access, says so, and admits once they go away', async () => {
    const { w, s } = setup()
    w.input()
    const held = s.request(reqOf(w))
    await settle()
    expect(linesOf(w)).toEqual(['Waiting for the Mac to be free'])
    await w.clock.advance(119_000)
    expect(await Promise.race([held, Promise.resolve('waiting')])).toBe('waiting')
    await w.clock.advance(2_000)
    expect(await held).toEqual({ admit: true, via: 'away', waitedMs: 120_000 })
    expect(linesOf(w)).toEqual(['Waiting for the Mac to be free', null])
    expect(w.cards).toEqual([])
  })

  it('is admitted up front only while the thread holds a session-tier button down', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    expect(s.admitted(ctxOf(w))).toBe(false)
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    expect(s.admitted(ctxOf(w))).toBe(true)
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'left_mouse_up' }]), async () => single(ok('left_mouse_up', 'session')))
    expect(s.admitted(ctxOf(w))).toBe(false)
  })

  it('refuses at once on a locked screen or a sleeping Mac, and when a lock arrives mid-hold', async () => {
    const { w, s } = setup()
    w.idleFor(500_000)
    w.setPresence({ screen: 'locked' })
    expect(await s.request(reqOf(w))).toMatchObject({ admit: false, reason: 'screen-locked', message: "the Mac's screen is locked" })
    w.setPresence({ screen: 'unlocked', power: 'asleep' })
    expect(await s.request(reqOf(w))).toMatchObject({ admit: false, reason: 'asleep', message: 'the Mac is asleep' })
    w.setPresence({ power: 'awake' })
    w.input()
    const held = s.request(reqOf(w))
    await w.clock.advance(3_000)
    w.setPresence({ screen: 'locked' })
    await w.clock.advance(1_000)
    expect(await held).toMatchObject({ admit: false, reason: 'screen-locked' })
    expect(w.cards).toEqual([])
    expect(linesOf(w).at(-1)).toBeNull()
  })

  it('an abort while held refuses cancelled at once, with the line cleared and no card', async () => {
    const { w, s } = setup()
    w.input()
    const abort = new AbortController()
    const held = s.request(reqOf(w, 't1', { signal: abort.signal }))
    await w.clock.advance(2_000)
    abort.abort('paused')
    expect(await held).toMatchObject({ admit: false, reason: 'cancelled' })
    expect(linesOf(w).at(-1)).toBeNull()
    expect(w.cards).toEqual([])
  })
})

describe('the card', () => {
  it('asks once after three minutes, Run now leases until the next input, Skip is remembered for that app this turn', async () => {
    const { w, s } = setup()
    w.input()
    const held = s.request(reqOf(w))
    await typing(w, 179_000)
    expect(w.cards).toHaveLength(0)
    await typing(w, 1_000)
    expect(w.cards).toHaveLength(1)
    expect(w.cards[0].req).toMatchObject({
      toolName: 'computer_session',
      choices: 'run-skip',
      callId: 'toolu_1',
      title: 'Use your pointer and keyboard to click button "Save" in TextEdit, window "Untitled"',
      input: { app: 'TextEdit', window: 'Untitled', actions: ['click button "Save"'] }
    })
    expect(linesOf(w).at(-1)).toBeNull()
    w.input() // the click on Run now
    w.cards[0].decide(true)
    expect(await held).toEqual({ admit: true, via: 'allowed', waitedMs: 180_000 })
    // leased: the next step runs at once, no card
    await w.clock.advance(1_000)
    expect(await s.request(reqOf(w))).toMatchObject({ admit: true, via: 'allowed' })
    // the person's next input ends the lease
    await w.clock.advance(2_000)
    w.input()
    const next = s.request(reqOf(w))
    await typing(w, 180_000)
    expect(w.cards).toHaveLength(2)
    w.cards[1].decide(false)
    expect(await next).toMatchObject({ admit: false, reason: 'skipped', message: 'the person did not choose Run now' })
    expect(await s.request(reqOf(w))).toMatchObject({
      admit: false,
      reason: 'skipped-earlier',
      message: 'the person did not choose Run now for TextEdit earlier in this turn'
    })
    expect(w.cards).toHaveLength(2)
    // another app still asks
    const other = s.request({ ...reqOf(w), app: { pid: 2, bundleId: 'com.apple.Mail', name: 'Mail' } })
    await typing(w, 180_000)
    expect(w.cards).toHaveLength(3)
    w.cards[2].decide(false)
    await other
    // a new turn asks again
    await s.settle('t1', 'turn-end')
    const again = s.request(reqOf(w))
    await typing(w, 180_000)
    expect(w.cards).toHaveLength(4)
    w.cards[3].decide(false)
    await again
  })

  it('a card while Away is on is answered Run now and leases the tier, at the moment it would ask', async () => {
    const { w, s } = setup()
    w.input()
    w.setAway(true)
    const first = s.request(reqOf(w))
    await typing(w, 180_000)
    expect(await first).toMatchObject({ admit: true, via: 'allowed' })
    w.setAway(false)
    expect(await s.request(reqOf(w))).toMatchObject({ admit: true, via: 'allowed', waitedMs: 0 })
    expect(w.cards).toHaveLength(0)
  })

  it('a card cancelled by a pause is not remembered as a Skip', async () => {
    const { w, s } = setup()
    w.input()
    const abort = new AbortController()
    const second = s.request(reqOf(w, 't1', { signal: abort.signal }))
    await typing(w, 180_000)
    expect(w.cards).toHaveLength(1)
    abort.abort('paused')
    expect(await second).toMatchObject({ admit: false, reason: 'cancelled' })
    await s.settle('t1', 'paused')
    const third = s.request(reqOf(w))
    await typing(w, 180_000)
    expect(w.cards).toHaveLength(2)
    w.cards[1].decide(false)
    expect(await third).toMatchObject({ reason: 'skipped' })
  })

  it('asks at once in safe and edits, and the call\'s own card naming the session leases it', async () => {
    const { w, s } = setup()
    w.input()
    for (const permission of ['safe', 'edits'] as const) {
      const asked = s.request({ ...reqOf(w), permission })
      await settle()
      expect(w.cards.at(-1)?.req.choices).toBe('run-skip')
      w.cards.at(-1)!.decide(true)
      expect(await asked).toMatchObject({ admit: true, via: 'allowed', waitedMs: 0 })
      await s.settle('t1', 'turn-end')
    }
    w.clock.t += 10_000
    w.input()
    s.cardAllowed(ctxOf(w), w.clock.now())
    expect(await s.request({ ...reqOf(w), permission: 'safe' })).toMatchObject({ admit: true, via: 'allowed' })
    expect(w.cards).toHaveLength(2)
  })

  it('the proof seam shortens the ask', async () => {
    const { w, s } = setup({ askAfterMs: 5_000 })
    w.input()
    s.request(reqOf(w))
    await w.clock.advance(5_000)
    expect(w.cards).toHaveLength(1)
  })
})

describe('the slot', () => {
  it('one session call at a time: a second thread waits in line and goes when the first ends; the holder enters again', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    const first = deferred<ActionResult>()
    const sent: string[] = []
    const a = s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'key', text: 'a' }]), (tiers) => (sent.push(`t1 ${tiers}`), first.promise))
    await settle()
    const b = s.run(runOf(w, 't2', ['ax', 'process', 'session'], [{ action: 'key', text: 'b' }]), async (tiers) => (sent.push(`t2 ${tiers}`), single(ok('key', 'session'))))
    await settle()
    expect(sent).toEqual(['t1 ax,process,session'])
    expect(linesOf(w, 't2')).toEqual(['Waiting for the Mac to be free, 2nd in line'])
    first.resolve(single(ok('key', 'session')))
    await a
    await b
    expect(sent).toEqual(['t1 ax,process,session', 't2 ax,process,session'])
    expect(linesOf(w, 't2').at(-1)).toBeNull()
    const slot = new SessionSlot()
    await slot.acquire('x', new AbortController().signal, () => {})
    await slot.acquire('x', new AbortController().signal, () => {})
    expect(slot.holder()).toBe('x')
    expect(slot.free('y')).toBe(false)
  })

  it('a thread whose person came back while it waited for the slot is sent without the session tier', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    const first = deferred<ActionResult>()
    const a = s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'key', text: 'a' }]), () => first.promise)
    await settle()
    const sent: Tier[][] = []
    const b = s.run(runOf(w, 't2', ['ax', 'process', 'session'], [{ action: 'key', text: 'b' }]), async (tiers) => (sent.push(tiers), single(ok('key', 'process'))))
    w.input()
    first.resolve(single(ok('key', 'session')))
    await a
    await b
    expect(sent).toEqual([['ax', 'process']])
  })

  it('a step whose reader left while it waited takes the slot, gives it to the next thread, sends nothing, and runs once read and admitted again', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    const first = deferred<ActionResult>()
    const sent: string[] = []
    const a = s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'key', text: 'a' }]), () => first.promise)
    await settle()
    let present = true
    let back: (() => void) | null = null
    const reader = {
      present: () => present,
      whenPresent: () => (present ? Promise.resolve() : new Promise<void>((r) => (back = r)))
    }
    const b = s.run({ ...runOf(w, 't2', ['ax', 'process', 'session'], [{ action: 'key', text: 'b' }]), reader }, async (tiers) => (sent.push(`t2 ${tiers}`), single(ok('key', 'session'))))
    await settle()
    const c = s.run(runOf(w, 't3', ['ax', 'process', 'session'], [{ action: 'key', text: 'c' }]), async (tiers) => (sent.push(`t3 ${tiers}`), single(ok('key', 'session'))))
    await settle()
    // nobody reads t2's call now
    present = false
    first.resolve(single(ok('key', 'session')))
    await a
    await c
    expect(sent).toEqual(['t3 ax,process,session'])
    expect(linesOf(w, 't2').at(-1)).toBe(READER_WAIT_WORDS)
    present = true
    back!()
    await b
    expect(sent).toEqual(['t3 ax,process,session', 't2 ax,process,session'])
    expect(linesOf(w, 't2').at(-1)).toBeNull()
  })

  it('a waiter that is given up leaves the line', async () => {
    const slot = new SessionSlot()
    await slot.acquire('a', new AbortController().signal, () => {})
    const places: [string, number][] = []
    const abort = new AbortController()
    const b = slot.acquire('b', abort.signal, (p) => places.push(['b', p]))
    const c = slot.acquire('c', new AbortController().signal, (p) => places.push(['c', p]))
    abort.abort()
    await expect(b).rejects.toThrow()
    expect(places.at(-1)).toEqual(['c', 2])
    slot.release('a')
    await c
    expect(slot.holder()).toBe('c')
  })
})

describe('restore', () => {
  it('after a call with a session step, not after one without', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['ax', 'process'], [{ action: 'key', text: 'a' }]), async () => single(ok('key', 'process')))
    expect(w.restores).toEqual([])
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'key', text: 'a' }]), async () => single(ok('key', 'process')))
    expect(w.restores).toEqual([])
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'key', text: 'a' }]), async () => single(ok('key', 'session')))
    expect(w.restores).toEqual([{}])
    expect(w.logs.some((l) => l.includes('restore t1 frontmost=restored pointer=restored'))).toBe(true)
  })

  it('none while a session button is held down, then one after its up', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    expect(w.restores).toEqual([])
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'mouse_move', coordinate: [5, 5] }]), async () => single(ok('mouse_move', 'session')))
    expect(w.restores).toEqual([])
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'left_mouse_up' }]), async () => single(ok('left_mouse_up', 'session')))
    expect(w.restores).toEqual([{}])
  })

  it('a Stop with a button held restores and lets the slot go', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['ax', 'process', 'session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    const sent: string[] = []
    const other = s.run(runOf(w, 't2', ['session'], [{ action: 'key', text: 'b' }]), async () => (sent.push('t2'), single(ok('key', 'session'))))
    await settle()
    expect(sent).toEqual([])
    await s.settle('t1', 'stopped')
    await other
    expect(sent).toEqual(['t2'])
    expect(w.restores.slice(0, 1)).toEqual([{}])
  })

  it('a restore that throws is logged and the result stands', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    w.failRestores()
    const r = await s.run(runOf(w, 't1', ['session'], [{ action: 'key', text: 'a' }]), async () => single(ok('key', 'session')))
    expect(r.step).toMatchObject({ status: 'ok' })
    expect(w.logs.some((l) => l.includes('restore t1 failed: the service is gone'))).toBe(true)
  })

  it("a call cut short with the session among its tiers restores, since it may have changed the Mac", async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await expect(s.run(runOf(w, 't1', ['session'], [{ action: 'key', text: 'a' }]), async () => Promise.reject(new Error('the service restarted')))).rejects.toThrow()
    expect(w.restores).toEqual([{}])
  })
})

describe("the person's touch", () => {
  it('restores at once on the notice, before the reply, and the call restores nothing more', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    const reply = deferred<ActionResult>()
    const call = s.run(runOf(w, 't1', ['session'], [{ action: 'hold_key', text: 'shift', duration: 4 }]), () => reply.promise)
    await settle()
    w.interrupt('t1')
    await settle()
    expect(w.restores).toEqual([{ afterInterrupt: true }])
    await w.clock.advance(3_000)
    reply.resolve(single({ index: 0, action: 'hold_key', status: 'failed', error: { kind: 'interrupted', message: 'The person took over.', by: 'person', session: change() } }))
    await call
    expect(w.restores).toEqual([{ afterInterrupt: true }])
    expect(w.ends).toEqual([[]])
  })

  it('with a fast reply and a slow restore, the slot goes only once the restore settled', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    w.holdRestore()
    const call = s.run(runOf(w, 't1', ['session'], [{ action: 'key', text: 'a' }]), async () => {
      w.interrupt('t1')
      return single({ index: 0, action: 'key', status: 'failed', error: { kind: 'interrupted', message: 'm', by: 'person' } })
    })
    await settle()
    const sent: string[] = []
    const other = s.run(runOf(w, 't2', ['session'], [{ action: 'key', text: 'b' }]), async () => (sent.push('t2'), single(ok('key', 'session'))))
    await settle()
    expect(sent).toEqual([])
    w.releaseRestore()
    await call
    await other
    expect(sent).toEqual(['t2'])
  })

  it('with a button held across calls and no call in flight, restores and then lets the slot go', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    const sent: string[] = []
    const other = s.run(runOf(w, 't2', ['session'], [{ action: 'key', text: 'b' }]), async () => (sent.push('t2'), single(ok('key', 'session'))))
    await settle()
    expect(sent).toEqual([])
    w.interrupt('t1')
    await other
    expect(w.restores[0]).toEqual({ afterInterrupt: true })
    expect(sent).toEqual(['t2'])
    expect(s.admitted(ctxOf(w))).toBe(false)
  })
})

describe('a pause during a call', () => {
  it('lets go of a button pressed while the reply was out, restores and frees the slot', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    const abort = new AbortController()
    const reply = deferred<ActionResult>()
    const call = s.run(runOf(w, 't1', ['session'], [{ action: 'left_mouse_down' }], abort.signal), () => reply.promise)
    await settle()
    abort.abort('paused')
    await s.settle('t1', 'paused')
    reply.resolve(single(ok('left_mouse_down', 'session')))
    await call
    expect(s.admitted(ctxOf(w))).toBe(false)
    expect(w.restores).toEqual([{}])
    const sent: string[] = []
    await s.run(runOf(w, 't2', ['session'], [{ action: 'key', text: 'b' }]), async () => (sent.push('t2'), single(ok('key', 'session'))))
    expect(sent).toEqual(['t2'])
  })
})

describe('a held button the service let go', () => {
  it('32 s after a down with no up, restores and lets the slot go to the thread queued behind', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    const sent: string[] = []
    const other = s.run(runOf(w, 't2', ['session'], [{ action: 'key', text: 'b' }]), async () => (sent.push('t2'), single(ok('key', 'session'))))
    await w.clock.advance(31_000)
    expect(sent).toEqual([])
    await w.clock.advance(1_000)
    await other
    expect(sent).toEqual(['t2'])
    expect(w.restores[0]).toEqual({})
  })

  it('an expiry during a call in flight is handled in that call', async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['session'], [{ action: 'left_mouse_down' }]), async () => single(ok('left_mouse_down', 'session')))
    const slow = deferred<ActionResult>()
    const call = s.run(runOf(w, 't1', ['session'], [{ action: 'mouse_move', coordinate: [1, 1] }]), () => slow.promise)
    await w.clock.advance(33_000)
    expect(w.restores).toEqual([])
    slow.resolve(single(ok('mouse_move', 'session')))
    await call
    expect(w.restores).toEqual([{}])
    expect(s.admitted(ctxOf(w))).toBe(false)
  })
})

describe('own input', () => {
  it("ends each call's window with its ok session steps' spans, and none for an interrupted call", async () => {
    const { w, s } = setup()
    w.idleFor(200_000)
    await s.run(runOf(w, 't1', ['session'], [{ action: 'key', text: 'a' }, { action: 'key', text: 'b' }]), async () => batch([ok('key', 'session', 0), ok('key', 'process', 1)]))
    expect(w.ends).toEqual([[{ armedAt: T0 + 1, idleAtArmMs: 130_000, lastInputAt: T0 + 2 }]])
    await s.run(runOf(w, 't1', ['session'], [{ action: 'key', text: 'a' }, { action: 'key', text: 'b' }]), async () =>
      batch([ok('key', 'session', 0), { index: 1, action: 'key', status: 'failed', error: { kind: 'interrupted', message: 'm', by: 'person' } }])
    )
    expect(w.ends.at(-1)).toEqual([])
    await s.run(runOf(w, 't1', ['ax', 'process'], [{ action: 'key', text: 'a' }]), async () => single(ok('key', 'process')))
    expect(w.ends).toHaveLength(2)
  })
})

describe('the clipboard', () => {
  const pasteReq = (w: World, abort = new AbortController()) => reqOf(w, 't1', { action: { action: 'paste', text: 'x' }, words: 'paste "x"', step: 1, signal: abort.signal })

  it('waits for five quiet seconds after a copy, saying so, and answers how long', async () => {
    const { w, s } = setup()
    expect(s.pasteQuietMs).toBe(5_000)
    w.setClipboard({ foreignChangeAt: T0 - 2_000 })
    const wait = s.clipboard(pasteReq(w))
    await settle()
    expect(linesOf(w)).toEqual(['Waiting for the clipboard'])
    await w.clock.advance(3_000)
    expect(await wait).toEqual({ ok: true, waitedMs: 3_000 })
    expect(linesOf(w).at(-1)).toBeNull()
  })

  it('counts the watch starting as a copy', async () => {
    const { w, s } = setup()
    w.setClipboard({ watchingSince: T0 - 1_000 })
    const wait = s.clipboard(pasteReq(w))
    await w.clock.advance(4_000)
    expect(await wait).toEqual({ ok: true, waitedMs: 4_000 })
  })

  it('a person who keeps copying ends the paste at ten seconds, refused again or not', async () => {
    const { w, s } = setup()
    w.setClipboard({ foreignChangeAt: T0 })
    const wait = s.clipboard(pasteReq(w))
    for (let i = 0; i < 10; i++) {
      await w.clock.advance(1_000)
      w.setClipboard({ foreignChangeAt: w.clock.now() })
    }
    expect(await wait).toEqual({ ok: false, message: 'the person copied something just now and a paste would swap their clipboard; try again in a minute' })
  })

  it('a step refused again after a quiet spell keeps its first deadline', async () => {
    const { w, s } = setup()
    w.setClipboard({ foreignChangeAt: T0 - 1_000 })
    const first = s.clipboard(pasteReq(w))
    await w.clock.advance(4_000)
    expect(await first).toEqual({ ok: true, waitedMs: 4_000 })
    // the person copies again as the paste re-runs, and keeps copying: the step ends at ten seconds from its first refusal
    w.setClipboard({ foreignChangeAt: w.clock.now() })
    const second = s.clipboard(pasteReq(w))
    let ended: unknown = null
    void second.then((d) => (ended = { d, at: w.clock.now() - T0 }))
    for (let i = 0; i < 8 && !ended; i++) {
      await w.clock.advance(1_000)
      w.setClipboard({ foreignChangeAt: w.clock.now() })
    }
    expect(ended).toMatchObject({ d: { ok: false }, at: 10_000 })
  })

  it('a quiet clipboard past the deadline still ends the paste', async () => {
    const { w, s } = setup()
    w.setClipboard({ foreignChangeAt: T0 - 1_000 })
    const first = s.clipboard(pasteReq(w))
    await w.clock.advance(4_000)
    expect(await first).toEqual({ ok: true, waitedMs: 4_000 })
    await w.clock.advance(7_000)
    expect(await s.clipboard(pasteReq(w))).toMatchObject({ ok: false })
  })

  it('an abort answers cancelled', async () => {
    const { w, s } = setup()
    w.setClipboard({ foreignChangeAt: T0 })
    const abort = new AbortController()
    const wait = s.clipboard(pasteReq(w, abort))
    await w.clock.advance(1_000)
    abort.abort('stopped')
    expect(await wait).toMatchObject({ ok: false, cancelled: true })
  })
})
