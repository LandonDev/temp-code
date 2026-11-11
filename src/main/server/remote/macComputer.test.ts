import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComputerSessionRow } from '@shared/contract-computer'
import { MAC_APPROVAL_WAIT_MS, type MacBridgePush, type MacBridgeRequest } from '@shared/contract-macbridge'
import {
  COMPUTER_HOLD_EXPIRED,
  COMPUTER_HOLD_STOPPED,
  COMPUTER_LIVE_IDLE_MS,
  COMPUTER_SESSION_WAIT_MS,
  COMPUTER_SWITCH_OFF,
  COMPUTER_SWITCH_PREFIX,
  MAX_COMPUTER_PREFIX,
  computerUnavailableOnMac,
  type ComputerPeerAnswer
} from '@shared/contract-maccomputer'
import type { ComputerToolCall } from '@shared/computer/tools'
import { needsApproval } from '@shared/computer/words'
import type { PermissionPolicy } from '@shared/events'
import { MAC_AWAY_REFUSAL } from '../awayPrompts'
import type { ComputerToolOutcome, LandedShot } from '../computer/result'
import type { ComputerToolContext } from '../computer/run'
import { MacBridge, POLICY_PREFIX } from './macBridge'
import { bridgedLanding, type MacComputerSessions } from './macComputer'

const ENV = 'env_box'
const KEY = (thread = 's1'): string => `${ENV}:${thread}`
const BIG_DEADLINE = 60 * 60_000

interface Run {
  ctx: ComputerToolContext
  tool: string
  args: Record<string, unknown>
}

/** A computer host that answers what each test scripts, with the sessions flow's card rule. */
function fakeHost() {
  const runs: Run[] = []
  const rows = new Map<string, ComputerSessionRow>()
  const listeners = new Set<(rows: ComputerSessionRow[]) => void>()
  const turns: string[] = []
  let away = false
  let behave: (r: Run) => Promise<ComputerToolOutcome> = async () => ({ steps: [], shots: [], body: 'TextEdit "Untitled"', isError: false })
  const emit = (): void => {
    for (const fn of listeners) fn([...rows.values()])
  }
  const sessions: MacComputerSessions = {
    run: async (ctx, tool, raw) => {
      const args = raw as Record<string, unknown>
      const r = { ctx, tool, args }
      runs.push(r)
      const now = Date.now()
      rows.set(ctx.threadId, {
        threadId: ctx.threadId,
        since: rows.get(ctx.threadId)?.since ?? now,
        lastCallAt: now,
        apps: [{ name: String(args.app ?? ''), bundleId: 'com.apple.TextEdit', window: (args.window as string) ?? 'Untitled' }],
        running: { tool, words: `Using ${String(args.app)}`, startedAt: now },
        tier: null
      })
      emit()
      const permission = ctx.permission?.() ?? 'safe'
      if (needsApproval(tool as ComputerToolCall['tool'], args as Parameters<typeof needsApproval>[1], permission).ask) {
        const ok = await ctx.approve!({
          toolName: `mcp__app__${tool}`,
          input: { app: String(args.app), window: (args.window as string) ?? null, actions: ['click button "Save"'] },
          title: `Click button "Save" in ${String(args.app)}`,
          signal: ctx.signal
        })
        if (!ok) return { steps: [], shots: [], body: away ? 'denied: the person is away' : 'denied: the person did not allow it', isError: true }
      }
      try {
        return await behave(r)
      } finally {
        const row = rows.get(ctx.threadId)
        if (row) rows.set(ctx.threadId, { ...row, running: null })
      }
    },
    rowOf: (id) => rows.get(id) ?? null,
    onRows: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    beginTurn: (id) => void turns.push(`begin ${id}`),
    settleTurn: (id) => {
      turns.push(`settle ${id}`)
      rows.delete(id)
    },
    stop: vi.fn(async (id: string) => {
      turns.push(`stop ${id}`)
      for (const r of runs) if (r.ctx.threadId === id) (r.ctx.signal as AbortSignal & { stopFor?: () => void }).stopFor?.()
      return true
    }),
    end: vi.fn(async (ids: string[]) => {
      turns.push(`end ${ids.join(',')}`)
      for (const id of ids) rows.delete(id)
    })
  }
  return {
    host: { sessions },
    runs,
    rows,
    turns,
    setAway: (on: boolean) => (away = on),
    behave: (fn: (r: Run) => Promise<ComputerToolOutcome>) => (behave = fn)
  }
}

/** Wait on the call's signal; answer cancelled with its reason. */
const untilAborted = (r: Run): Promise<ComputerToolOutcome> =>
  new Promise((resolve) => {
    const done = (): void => resolve({ steps: ['1. left_click · ax · changed'], shots: [], body: `aborted: ${String(r.ctx.signal?.reason)}`, isError: true })
    if (r.ctx.signal?.aborted) return done()
    r.ctx.signal?.addEventListener('abort', done, { once: true })
  })

function setup(opts: { unavailable?: string | null; away?: { on: boolean }; policy?: string; computer?: boolean; maxComputer?: number; dataDir?: string } = {}) {
  const settings = new Map<string, string>([[`${POLICY_PREFIX}${ENV}`, opts.policy ?? 'read']])
  if (opts.computer !== false) settings.set(`${COMPUTER_SWITCH_PREFIX}${ENV}`, 'on')
  if (opts.maxComputer) settings.set(`${MAX_COMPUTER_PREFIX}${ENV}`, String(opts.maxComputer))
  const fake = fakeHost()
  const pushes: MacBridgePush[] = []
  const lines: string[] = []
  const away = opts.away ?? { on: false }
  const mb = new MacBridge({
    environmentId: 'env_mac',
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    managedRoots: () => [],
    environments: () => [{ id: ENV, name: 'box' }],
    link: () => null,
    home: tmpdir(),
    log: (l) => lines.push(l),
    load: { sample: () => ({ load: 0, cores: 8 }), intervalMs: 0 },
    away: () => away.on,
    computerHost: () => fake.host,
    computerUnavailable: () => (opts.unavailable === undefined ? null : opts.unavailable),
    ...(opts.dataDir ? { computerLanding: (key: string) => bridgedLanding(opts.dataDir!, key) } : {})
  })
  mb.subscribe((p) => pushes.push(p))
  const progress: { thread: string; row: ComputerSessionRow }[] = []
  let callSeq = 0
  const call = (
    args: { tool?: ComputerToolCall['tool']; args?: Record<string, unknown>; permission?: PermissionPolicy; turn?: string; thread?: string; deadlineMs?: number; callId?: string } = {}
  ): Promise<ComputerPeerAnswer> => {
    const thread = args.thread ?? 's1'
    const callId = args.callId ?? `c${++callSeq}`
    return mb.handle(
      'mac.computer',
      {
        thread: { id: thread, title: `thread ${thread}` },
        args: {
          call: { tool: args.tool ?? 'computer_observe', args: args.args ?? { app: 'TextEdit' }, threadId: thread, permission: args.permission ?? 'auto' },
          turn: args.turn ?? 'boot:1',
          rootId: thread
        }
      } as never,
      {
        from: ENV,
        deadlineAt: Date.now() + (args.deadlineMs ?? BIG_DEADLINE),
        callId,
        progress: (chunk) => progress.push({ thread, row: (JSON.parse(chunk) as { row: ComputerSessionRow }).row })
      }
    ) as Promise<ComputerPeerAnswer>
  }
  const end = (reason: 'settled' | 'stopped' | 'ended', thread = 's1'): Promise<unknown> =>
    mb.handle('mac.computerEnd', { thread: { id: thread, title: '' }, args: { reason } } as never, { from: ENV, deadlineAt: Date.now() + 15_000 })
  const cancel = (callIds: string[], thread = 's1'): Promise<unknown> =>
    mb.handle('mac.cancel', { thread: { id: thread, title: '' }, args: { callIds, reason: 'paused' } } as never, { from: ENV, deadlineAt: Date.now() + 15_000 })
  const requests = (): MacBridgeRequest[] => mb.pending()
  const cards = (): MacBridgeRequest[] => requests().filter((r) => r.status === 'pending')
  const lives = (): MacBridgeRequest[] => requests().filter((r) => r.kind === 'computer' && r.status !== 'pending')
  const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })
    )
  return { mb, fake, settings, pushes, lines, progress, call, end, cancel, requests, cards, lives, settle, away }
}

const until = async (pred: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 400; i++) {
    if (pred()) return
    await new Promise((ok) => setTimeout(ok, 5))
  }
  throw new Error(`timed out: ${label}`)
}

afterEach(() => vi.useRealTimers())

describe('MacComputer: what refuses a call', () => {
  it('policy Off, the switch off and computer use unavailable refuse with their lines and run nothing', async () => {
    const off = setup({ policy: 'off' })
    expect(await off.settle(off.call())).toEqual({ ok: false, error: "the Mac bridge is off for this host: turn it on in the Mac's Settings → Hosts" })
    const switched = setup({ computer: false })
    expect(await switched.settle(switched.call())).toEqual({ ok: false, error: COMPUTER_SWITCH_OFF })
    const missing = setup({ unavailable: 'this Mac has no tc-computer' })
    expect(await missing.settle(missing.call())).toEqual({ ok: false, error: computerUnavailableOnMac('this Mac has no tc-computer') })
    for (const s of [off, switched, missing]) {
      expect(s.fake.runs).toHaveLength(0)
      expect(s.requests()).toHaveLength(0)
    }
  })

  it('a call naming another thread is refused', async () => {
    const s = setup()
    const wrong = s.mb.handle(
      'mac.computer',
      { thread: { id: 's1', title: '' }, args: { call: { tool: 'computer_apps', args: {}, threadId: 's2', permission: 'auto' }, turn: 't', rootId: 's1' } } as never,
      { from: ENV, deadlineAt: Date.now() + BIG_DEADLINE }
    )
    expect(await s.settle(wrong)).toEqual({ ok: false, error: 'refused: the call names another thread' })
  })

  it('Away refuses a call flagged pay or subscribe before anything waits; every other call goes through', async () => {
    const s = setup({ away: { on: true } })
    const click = { tool: 'computer_act' as const, args: { app: 'TextEdit', action: 'left_click', coordinate: [5, 5] }, permission: 'safe' as const }
    for (const kind of ['pay', 'subscribe']) {
      const flagged = { ...click, permission: 'auto' as const, args: { ...click.args, confirm: { kind, what: 'Buy the plan' } } }
      expect(await s.settle(s.call(flagged))).toEqual({ ok: false, error: MAC_AWAY_REFUSAL })
    }
    expect(s.requests()).toHaveLength(0)
    expect(s.fake.runs).toHaveLength(0)
    expect((await s.call({ permission: 'safe' })).isError).toBe(false)
    expect(await s.call(click)).toMatchObject({ isError: false, away: true })
    expect((await s.call({ ...click, permission: 'auto', args: { ...click.args, confirm: { kind: 'delete', what: 'Delete the draft' } } })).away).toBe(true)
    expect(s.cards()).toHaveLength(0)
    expect(s.lines.some((l) => l.includes('card allowed (away)'))).toBe(true)
  })
})

describe('MacComputer: the card', () => {
  const click = { tool: 'computer_act' as const, args: { app: 'TextEdit', action: 'left_click', coordinate: [5, 5] }, permission: 'safe' as const }

  it('full access never asks', async () => {
    const s = setup()
    expect((await s.call({ ...click, permission: 'auto' })).isError).toBe(false)
    expect(s.pushes.some((p) => p.push === 'macBridge.request' && p.request.status === 'pending')).toBe(false)
  })

  it("safe asks a card of kind computer naming the approval's app, window and steps; its row carries asking; a denial answers denied", async () => {
    const s = setup()
    const p = s.call(click)
    await until(() => s.cards().length === 1, 'the card')
    const card = s.cards()[0]
    expect(card).toMatchObject({ kind: 'computer', method: 'mac.computer', sessionId: 's1', computer: { app: 'TextEdit', window: null, actions: ['click button "Save"'] } })
    await until(() => s.progress.some((x) => x.row.asking), 'the asking row')
    expect(s.progress.find((x) => x.row.asking)?.row.asking).toEqual({ line: 'Click button "Save" in TextEdit?' })
    s.mb.decide(card.id, false, 'thread')
    expect(await p).toMatchObject({ isError: true, body: 'denied: the person did not allow it' })
    expect(s.cards()).toHaveLength(0)
  })

  it('an Allow runs the call and finishes the card, so the next card is the first pending one', async () => {
    const s = setup()
    s.fake.behave(async () => ({ steps: ['1. left_click · ax · changed'], shots: [], body: 'ok', isError: false }))
    const p = s.call(click)
    await until(() => s.cards().length === 1, 'the card')
    s.mb.decide(s.cards()[0].id, true, 'thread')
    expect(await p).toMatchObject({ isError: false, steps: ['1. left_click · ax · changed'] })
    expect(s.cards()).toHaveLength(0)
    const resolved = s.pushes.filter((x) => x.push === 'macBridge.resolved')
    expect(resolved.some((x) => x.push === 'macBridge.resolved' && x.outcome === 'allowed')).toBe(true)
    const again = s.call(click)
    await until(() => s.cards().length === 1, 'the second card')
    s.mb.decide(s.cards()[0].id, false)
    await again
  })

  it('the card is denied when the call is cancelled from the box', async () => {
    const s = setup()
    const p = s.call({ ...click, callId: 'cx' })
    await until(() => s.cards().length === 1, 'the card')
    await s.cancel(['cx'])
    expect(await p).toMatchObject({ isError: true })
    expect(s.cards()).toHaveLength(0)
  })

  it('Away turning on while a call waits in line allows its card, and the answer says away', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const p = s.call({ ...click, thread: 's1' })
    await until(() => s.lives().some((r) => r.sessionId === 's1' && r.status === 'held'), 'in line')
    s.away.on = true
    await s.end('settled', 's0')
    expect(await p).toMatchObject({ isError: false, away: true })
    expect(s.cards()).toHaveLength(0)
  })

  it('a pay call that passed with Away off is refused at its card when Away turned on while it waited in line', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const p = s.settle(s.call({ ...click, permission: 'auto', thread: 's1', args: { ...click.args, confirm: { kind: 'pay', what: 'Buy' } } }))
    await until(() => s.lives().some((r) => r.sessionId === 's1' && r.status === 'held'), 'in line')
    s.away.on = true
    await s.end('settled', 's0')
    expect(await p).toEqual({ ok: false, error: MAC_AWAY_REFUSAL })
    expect(s.cards()).toHaveLength(0)
  })

  it('Away turning on decides a card already waiting: allowed and marked, or denied for a pay act', async () => {
    const s = setup()
    const p = s.call(click)
    const paid = s.settle(s.call({ ...click, permission: 'auto', thread: 's2', args: { ...click.args, confirm: { kind: 'pay', what: 'Buy' } } }))
    await until(() => s.cards().length === 2, 'both cards')
    s.away.on = true
    s.mb.awayChanged(true)
    expect(await p).toMatchObject({ isError: false, away: true })
    expect(await paid).toEqual({ ok: false, error: MAC_AWAY_REFUSAL })
    expect(s.cards()).toHaveLength(0)
  })

  it("the session tier's card is Run now while away, and denied in a pay call", async () => {
    for (const confirm of [undefined, { kind: 'pay', what: 'Buy' }]) {
      const s = setup()
      s.fake.behave(async (r) => {
        s.away.on = true
        const ok = await r.ctx.approve!({ toolName: 'computer_session', input: {}, title: 'Use the pointer?', choices: 'run-skip', signal: r.ctx.signal })
        return { steps: [], shots: [], body: ok ? 'ran' : 'skipped', isError: !ok }
      })
      const p = s.settle(s.call({ ...click, args: { ...click.args, ...(confirm ? { confirm } : {}) } }))
      await until(() => s.cards().length === 1, 'the call card')
      s.mb.decide(s.cards()[0].id, true)
      const out = await p
      if (confirm) expect(out).toEqual({ ok: false, error: MAC_AWAY_REFUSAL })
      else expect(out).toMatchObject({ ok: true, value: { body: 'ran', away: true } })
    }
  })
})

describe('MacComputer: the live session and the guard', () => {
  it('one live request per session, reused within the turn; a new turn calls beginTurn', async () => {
    const s = setup()
    await s.call()
    await s.call()
    expect(s.lives()).toHaveLength(1)
    expect(s.lives()[0]).toMatchObject({ status: 'running', kind: 'computer', computer: { app: 'TextEdit', window: 'Untitled' } })
    await s.call({ turn: 'boot:2' })
    expect(s.fake.turns.filter((t) => t.startsWith('begin'))).toEqual([`begin ${KEY()}`, `begin ${KEY()}`])
    expect(s.mb.hosts()[0]).toMatchObject({ computer: true, computerLive: 1, maxComputer: 2, computerUnavailable: null })
  })

  it("passes the box's root and the permission it read, and keys the session by box and thread", async () => {
    const s = setup()
    await s.call({ permission: 'edits', thread: 's7' })
    expect(s.fake.runs[0].ctx).toMatchObject({ threadId: KEY('s7'), rootId: KEY('s7') })
    expect(s.fake.runs[0].ctx.permission?.()).toBe('edits')
  })

  it('a first call held at the cap sends a provisional row worded by the guard and runs once admitted', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const p = s.call({ thread: 's1', args: { app: 'Notes' } })
    await until(() => s.progress.some((x) => x.thread === 's1'), 'the held row')
    const held = s.progress.find((x) => x.thread === 's1')!.row
    expect(held).toMatchObject({ threadId: KEY('s1'), apps: [{ name: 'Notes', bundleId: null }], running: { tool: 'computer_observe', words: 'Waiting for the Mac, 1 of 1 computer sessions, 1st in line', held: true } })
    expect(s.fake.runs.filter((r) => r.ctx.threadId === KEY('s1'))).toHaveLength(0)
    // Once admitted the row names the action, with no hold mark.
    const ran = () => s.progress.filter((x) => x.thread === 's1' && x.row.running?.words === 'Using Notes')
    s.fake.behave(async () => {
      await until(() => ran().length > 0, 'the running row')
      return { steps: [], shots: [], body: 'Notes', isError: false }
    })
    await s.end('settled', 's0')
    expect((await p).isError).toBe(false)
    expect(s.fake.runs.filter((r) => r.ctx.threadId === KEY('s1'))).toHaveLength(1)
    expect(ran().every((x) => x.row.running?.held === undefined)).toBe(true)
  })

  it('a call cancelled while held leaves the line and never runs when a slot opens', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const p = s.call({ thread: 's1', callId: 'held' })
    await until(() => s.lives().some((r) => r.sessionId === 's1' && r.status === 'held'), 'in line')
    await s.cancel(['held'], 's1')
    expect(await s.settle(p)).toEqual({ ok: false, error: 'cancelled: the thread was paused' })
    await s.end('settled', 's0')
    await new Promise((ok) => setTimeout(ok, 20))
    expect(s.fake.runs.filter((r) => r.ctx.threadId === KEY('s1'))).toHaveLength(0)
    expect(s.mb.guard.heldCount(ENV)).toBe(0)
  })

  it('a hold that runs out of time and one stopped on the Mac throw their lines', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const short = MAC_APPROVAL_WAIT_MS + COMPUTER_SESSION_WAIT_MS + 60_000 + 3_000 + 50
    expect(await s.settle(s.call({ thread: 's1', deadlineMs: short }))).toEqual({ ok: false, error: COMPUTER_HOLD_EXPIRED })
    const p = s.call({ thread: 's2' })
    await until(() => s.lives().some((r) => r.sessionId === 's2' && r.status === 'held'), 'in line')
    s.mb.decide(s.lives().find((r) => r.sessionId === 's2')!.id, false)
    expect(await s.settle(p)).toEqual({ ok: false, error: COMPUTER_HOLD_STOPPED })
  })

  it("a Stop from the box while the session waits in line answers stopped, takes it out of the line and never runs it", async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const p = s.call({ thread: 's1' })
    await until(() => s.lives().some((r) => r.sessionId === 's1' && r.status === 'held'), 'in line')
    expect(await s.end('stopped', 's1')).toEqual({ ended: true })
    expect(await s.settle(p)).toEqual({ ok: false, error: 'stopped by the person; no more computer use this turn' })
    expect(s.mb.guard.heldCount(ENV)).toBe(0)
    await s.end('settled', 's0')
    await new Promise((ok) => setTimeout(ok, 20))
    expect(s.fake.runs.filter((r) => r.ctx.threadId === KEY('s1'))).toHaveLength(0)
    expect([s.mb.guard.runningCount(ENV), s.mb.guard.computerCount(ENV)]).toEqual([0, 0])
  })

  it('mac.cancel aborts only the named calls', async () => {
    const s = setup()
    s.fake.behave(untilAborted)
    const a = s.call({ thread: 's1', callId: 'a' })
    const b = s.call({ thread: 's2', callId: 'b' })
    await until(() => s.fake.runs.length === 2, 'both out')
    await s.cancel(['a'], 's1')
    expect((await a).body).toBe('aborted: paused')
    expect(await Promise.race([b.then(() => 'answered'), new Promise((ok) => setTimeout(() => ok('open'), 30))])).toBe('open')
    await s.cancel(['b'], 's2')
    await b
  })

  it('mac.computerEnd settled, stopped and ended call settleTurn, stop and end, and free the slot', async () => {
    const s = setup()
    await s.call()
    expect(await s.end('settled')).toEqual({ ended: true })
    expect(s.fake.turns).toContain(`settle ${KEY()}`)
    expect(s.lives()).toHaveLength(0)
    await s.call()
    expect(await s.end('stopped')).toEqual({ ended: true })
    expect(s.fake.host.sessions.stop).toHaveBeenCalledWith(KEY())
    expect(s.lives()).toHaveLength(0)
    await s.call()
    expect(await s.end('ended')).toEqual({ ended: true })
    expect(s.fake.host.sessions.end).toHaveBeenCalledWith([KEY()])
    expect(s.lives()).toHaveLength(0)
    expect(s.mb.guard.runningCount(ENV)).toBe(0)
    expect(await s.end('settled')).toEqual({ ended: false })
  })

  it('Stop on the Mac row stops the session', async () => {
    const s = setup()
    await s.call()
    s.mb.decide(s.lives()[0].id, false)
    await until(() => s.fake.turns.includes(`stop ${KEY()}`), 'the stop')
    expect(s.lives()).toHaveLength(0)
  })

  it('three idle minutes give the slot back; the next call takes one again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const s = setup()
    await s.call()
    expect(s.mb.guard.computerCount(ENV)).toBe(1)
    await vi.advanceTimersByTimeAsync(COMPUTER_LIVE_IDLE_MS + 10)
    expect(s.mb.guard.computerCount(ENV)).toBe(0)
    expect(s.lives()).toHaveLength(0)
    await s.call()
    expect(s.mb.guard.computerCount(ENV)).toBe(1)
  })

  it('a card that waits longer than three minutes keeps its slot', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const s = setup()
    await s.call()
    const p = s.call({ tool: 'computer_act', args: { app: 'TextEdit', action: 'left_click', coordinate: [1, 1] }, permission: 'safe' })
    await until(() => s.cards().length === 1, 'the card')
    await vi.advanceTimersByTimeAsync(COMPUTER_LIVE_IDLE_MS + 60_000)
    expect(s.mb.guard.computerCount(ENV)).toBe(1)
    s.mb.decide(s.cards()[0].id, true)
    expect((await p).isError).toBe(false)
  })

  it('a link that drops aborts its calls and frees its slots', async () => {
    const s = setup()
    s.fake.behave(untilAborted)
    const p = s.call()
    await until(() => s.fake.runs.length === 1, 'out')
    s.mb.linkDown(ENV)
    expect((await p).body).toBe('aborted: ended')
    expect(s.mb.guard.computerCount(ENV)).toBe(0)
    expect(s.fake.turns).toContain(`settle ${KEY()}`)
  })

  it('the switch going off ends the live sessions; the next call is refused', async () => {
    const s = setup()
    await s.call()
    s.mb.setComputer(ENV, false)
    expect(s.lives()).toHaveLength(0)
    expect(s.fake.host.sessions.end).toHaveBeenCalledWith([KEY()])
    expect(await s.settle(s.call())).toEqual({ ok: false, error: COMPUTER_SWITCH_OFF })
  })
})

describe('MacComputer: the answer', () => {
  it("carries the outcome's pictures byte for byte, in order, and removes them here once read", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tc-mac-computer-'))
    const s = setup({ dataDir })
    const dir = bridgedLanding(dataDir, KEY())
    mkdirSync(dir, { recursive: true })
    const a = join(dir, '0001.jpg')
    const b = join(dir, '0002.png')
    writeFileSync(a, Buffer.from([0xff, 0xd8, 1, 2, 3]))
    writeFileSync(b, Buffer.from([0x89, 0x50, 4, 5]))
    const shots: LandedShot[] = [
      { label: 'step 1', where: 1, path: a, mimeType: 'image/jpeg', width: 10, height: 20 },
      { label: 'observation', where: 'observation', path: b, mimeType: 'image/png', width: 30, height: 40 }
    ]
    const bytes = [readFileSync(a), readFileSync(b)]
    s.fake.behave(async () => ({ steps: ['1. screenshot · ax'], shots, body: 'TextEdit', isError: false }))
    const answer = await s.call()
    expect(answer.images).toEqual([
      { label: 'step 1', data: bytes[0].toString('base64'), mimeType: 'image/jpeg', width: 10, height: 20 },
      { label: 'observation', data: bytes[1].toString('base64'), mimeType: 'image/png', width: 30, height: 40 }
    ])
    expect(answer.steps).toEqual(['1. screenshot · ax'])
    expect(answer.body).toBe('TextEdit')
    expect(answer.row).toMatchObject({ threadId: KEY() })
    expect(existsSync(a) || existsSync(b)).toBe(false)
    await s.end('ended')
    expect(existsSync(dir)).toBe(false)
  })

  it("carries the Mac's timing: the run's tally, the legs in order and the pictures' length", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tc-mac-computer-'))
    const s = setup({ dataDir })
    const dir = bridgedLanding(dataDir, KEY())
    mkdirSync(dir, { recursive: true })
    const path = join(dir, '0001.jpg')
    writeFileSync(path, Buffer.from([0xff, 0xd8, 1, 2, 3, 4]))
    const shot: LandedShot = { label: 'observation', where: 'observation', path, mimeType: 'image/jpeg', width: 10, height: 20 }
    s.fake.behave(async (r) => {
      r.ctx.timing?.addService(30)
      r.ctx.timing?.addService(12)
      r.ctx.timing?.addWaited(120)
      await new Promise((ok) => setTimeout(ok, 15))
      return { steps: [], shots: [shot], body: 'TextEdit', isError: false }
    })
    const answer = await s.call()
    const t = answer.timing!
    expect(t).toMatchObject({ serviceMs: 42, waitedMs: 120, shotChars: answer.images[0]!.data.length })
    expect(t.shotChars).toBe(8)
    expect(t.runMs).toBeGreaterThanOrEqual(14)
    expect(t.macMs).toBeGreaterThanOrEqual(t.checksMs + t.guardMs + t.runMs + t.shotsMs)
    await s.end('ended')
  })

  it('a refusal before the run sends no answer, so no timing', async () => {
    const s = setup({ computer: false })
    expect(await s.settle(s.call())).toEqual({ ok: false, error: COMPUTER_SWITCH_OFF })
    expect(s.fake.runs).toHaveLength(0)
  })

  it("the bridged landing is under the data dir by the session's service id", () => {
    expect(bridgedLanding('/d', KEY('t1'))).toMatch(/^\/d\/computer\/bridged\/t_[0-9a-f]{40}$/)
  })
})

describe("MacComputer: the box's reader (mac.computerReader)", () => {
  const click = { tool: 'computer_act' as const, args: { app: 'TextEdit', action: 'left_click', coordinate: [5, 5] }, permission: 'safe' as const }
  const reading = (s: ReturnType<typeof setup>, callIds: string[], on: boolean, thread = 's1'): Promise<unknown> =>
    s.mb.handle('mac.computerReader', { thread: { id: thread, title: '' }, args: { callIds, reading: on } } as never, { from: ENV, deadlineAt: Date.now() + 15_000 })
  /** The fake's act goes through the reader's gate as the real run's service requests do; `sent` counts what reached the service. */
  const gatedAct = (s: ReturnType<typeof setup>) => {
    const sent: string[] = []
    s.fake.behave(async (r) =>
      r.ctx.reader!.request(r.ctx.signal!, async () => {
        sent.push(r.ctx.threadId)
        return { steps: ['1. left_click · ax · changed'], shots: [], body: 'ok', isError: false }
      })
    )
    return sent
  }
  const quiet = (): Promise<void> => new Promise((ok) => setTimeout(ok, 30))

  it('false while the call waits at its card answers held: true; once allowed nothing reaches the service until true', async () => {
    const s = setup()
    const sent = gatedAct(s)
    const p = s.call({ ...click, callId: 'cx' })
    await until(() => s.cards().length === 1, 'the card')
    expect(await reading(s, ['cx'], false)).toEqual({ held: true })
    s.mb.decide(s.cards()[0].id, true, 'thread')
    await quiet()
    expect(sent).toEqual([])
    expect(await reading(s, ['cx'], true)).toEqual({ held: false })
    expect(await p).toMatchObject({ isError: false, steps: ['1. left_click · ax · changed'] })
    expect(sent).toEqual([KEY()])
  })

  it('false while the call waits for the cap answers held: true; once admitted nothing reaches the service until true', async () => {
    const s = setup({ maxComputer: 1 })
    await s.call({ thread: 's0' })
    const sent = gatedAct(s)
    const p = s.call({ ...click, permission: 'auto', thread: 's1', callId: 'cap' })
    await until(() => s.lives().some((r) => r.sessionId === 's1' && r.status === 'held'), 'in line')
    expect(await reading(s, ['cap'], false, 's1')).toEqual({ held: true })
    await s.end('settled', 's0')
    await until(() => s.fake.runs.some((r) => r.ctx.threadId === KEY('s1')), 'admitted')
    await quiet()
    expect(sent).toEqual([])
    await reading(s, ['cap'], true, 's1')
    expect((await p).isError).toBe(false)
    expect(sent).toEqual([KEY('s1')])
  })

  it('a cancel while the call is held unread sends no input', async () => {
    const s = setup()
    const sent = gatedAct(s)
    const p = s.settle(s.call({ ...click, callId: 'cx' }))
    await until(() => s.cards().length === 1, 'the card')
    expect(await reading(s, ['cx'], false)).toEqual({ held: true })
    s.mb.decide(s.cards()[0].id, true, 'thread')
    await quiet()
    await s.cancel(['cx'])
    const out = await p
    expect(out.ok ? out.value.isError : true).toBe(true)
    await reading(s, ['cx'], true)
    await quiet()
    expect(sent).toEqual([])
  })

  it('false while a request is out answers held: false and leaves the flag true: the call finishes without waiting', async () => {
    const s = setup()
    let open: () => void = () => {}
    const gate = new Promise<void>((ok) => (open = ok))
    let inside = false
    const sent: number[] = []
    s.fake.behave(async (r) => {
      await r.ctx.reader!.request(r.ctx.signal!, async () => {
        inside = true
        sent.push(1)
        await gate
      })
      await r.ctx.reader!.request(r.ctx.signal!, async () => void sent.push(2))
      return { steps: ['1. key a · ax · changed', '2. key b · ax · changed'], shots: [], body: 'ok', isError: false }
    })
    const p = s.call({ ...click, permission: 'auto', callId: 'cx' })
    await until(() => inside, 'the request out')
    expect(await reading(s, ['cx'], false)).toEqual({ held: false })
    open()
    expect(await p).toMatchObject({ isError: false })
    expect(sent).toEqual([1, 2])
  })

  it('a call this Mac does not hold answers held: false', async () => {
    const s = setup()
    expect(await reading(s, ['nobody'], false)).toEqual({ held: false })
  })
})
