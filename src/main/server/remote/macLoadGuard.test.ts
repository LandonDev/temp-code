import { describe, expect, it } from 'vitest'
import type { MacBridgeHeld } from '@shared/contract-macbridge'
import { MacLoadGuard, loadLimitFor, nextBusy, type HoldEnd } from './macLoadGuard'

function guard(
  opts: { load?: number; cores?: number; max?: Record<string, number>; computer?: Record<string, number>; limit?: number | null } = {}
) {
  const sample = { load: opts.load ?? 0, cores: opts.cores ?? 8 }
  const caps = opts.max ?? {}
  let pinned: number | null = opts.limit ?? null
  const changes: [string, MacBridgeHeld | null][] = []
  const lines: string[] = []
  let now = 1_000_000
  const g = new MacLoadGuard({
    maxRunning: (envId) => caps[envId] ?? 4,
    maxComputer: (envId) => opts.computer?.[envId] ?? 2,
    loadLimit: () => pinned,
    sample: () => ({ ...sample }),
    intervalMs: 0,
    now: () => now,
    onChange: (id, held) => changes.push([id, held]),
    log: (l) => lines.push(l)
  })
  return {
    g,
    sample,
    changes,
    lines,
    setLoad: (load: number) => (sample.load = load),
    pin: (limit: number | null) => (pinned = limit),
    tick: (ms: number) => (now += ms)
  }
}

/** The hold's end, or 'open' while it still waits. */
async function endOf(done: Promise<HoldEnd>): Promise<HoldEnd | 'open'> {
  return Promise.race([done, new Promise<'open'>((ok) => setTimeout(() => ok('open'), 20))])
}

describe('loadLimitFor and nextBusy', () => {
  it('the limit is 2 × cores unless pinned', () => {
    expect(loadLimitFor({ load: 0, cores: 8 }, null)).toBe(16)
    expect(loadLimitFor({ load: 0, cores: 8 }, 6)).toBe(6)
  })
  it('hysteresis: over the limit turns busy, and it stays busy until under three quarters of it', () => {
    expect(nextBusy(false, 16, 16)).toBe(false)
    expect(nextBusy(false, 16.1, 16)).toBe(true)
    expect(nextBusy(true, 15, 16)).toBe(true)
    expect(nextBusy(true, 12, 16)).toBe(true)
    expect(nextBusy(true, 11.9, 16)).toBe(false)
  })
})

describe('MacLoadGuard: the cap', () => {
  it('admits up to the host cap at once; the next waits its turn, in order, and goes when one ends', async () => {
    const { g, changes } = guard({ max: { box: 2 } })
    expect(g.acquire('box', 'a', Infinity)).toEqual({ admitted: true })
    expect(g.acquire('box', 'b', Infinity)).toEqual({ admitted: true })
    const c = g.acquire('box', 'c', Infinity)
    const d = g.acquire('box', 'd', Infinity)
    expect(c.admitted).toBe(false)
    expect(d.admitted).toBe(false)
    if (c.admitted || d.admitted) throw new Error('unreachable')
    expect(c.held).toEqual({
      reason: 'cap',
      position: 1,
      load: 0,
      limit: 16,
      cores: 8,
      maxRunning: 2,
      running: 2
    })
    expect(d.held.position).toBe(2)
    expect(g.runningCount('box')).toBe(2)
    expect(g.heldCount('box')).toBe(2)
    expect(await endOf(c.done)).toBe('open')
    // a ends: c goes (in order), d moves up to first.
    g.release('a')
    expect(await c.done).toBe('admitted')
    expect(await endOf(d.done)).toBe('open')
    expect(g.heldOf('d')).toMatchObject({ position: 1, running: 2 })
    expect(changes).toEqual([
      ['c', null],
      ['d', expect.objectContaining({ position: 1 })]
    ])
    g.release('b')
    expect(await d.done).toBe('admitted')
    expect(g.runningCount('box')).toBe(2)
    expect(g.heldCount('box')).toBe(0)
  })

  it('the cap is per host: another host has its own', () => {
    const { g } = guard({ max: { box: 1, other: 1 } })
    expect(g.acquire('box', 'a', Infinity).admitted).toBe(true)
    expect(g.acquire('other', 'b', Infinity).admitted).toBe(true)
    expect(g.acquire('box', 'c', Infinity).admitted).toBe(false)
    expect(g.heldCount('box')).toBe(1)
    expect(g.heldCount('other')).toBe(0)
  })

  it('a raised cap releases held calls at once (reconsider); a release of an id never admitted frees nothing', async () => {
    const caps = { box: 1 }
    const { g } = guard({ max: caps })
    g.acquire('box', 'a', Infinity)
    const b = g.acquire('box', 'b', Infinity)
    if (b.admitted) throw new Error('unreachable')
    g.release('never-admitted')
    expect(await endOf(b.done)).toBe('open')
    caps.box = 2
    g.reconsider()
    expect(await b.done).toBe('admitted')
  })

  it('Stop on a held call cancels it and the ones behind move up; the deadline expires it', async () => {
    const { g, changes, tick } = guard({ max: { box: 1 } })
    g.acquire('box', 'a', Infinity)
    const b = g.acquire('box', 'b', Infinity)
    const c = g.acquire('box', 'c', 1_000_000 + 50)
    if (b.admitted || c.admitted) throw new Error('unreachable')
    expect(g.cancel('b')).toBe(true)
    expect(g.cancel('b')).toBe(false)
    expect(await b.done).toBe('cancelled')
    expect(g.heldOf('c')?.position).toBe(1)
    expect(changes.at(-1)).toEqual(['c', expect.objectContaining({ position: 1 })])
    tick(60)
    expect(await c.done).toBe('expired')
    expect(g.heldCount('box')).toBe(0)
    // Running count untouched by the ones that never started.
    expect(g.runningCount('box')).toBe(1)
  })
})

describe('MacLoadGuard: computer sessions', () => {
  it('a session fits under both caps and counts toward the host cap', () => {
    const { g } = guard({ max: { box: 3 }, computer: { box: 2 } })
    expect(g.acquire('box', 's1', Infinity, 'computer')).toEqual({ admitted: true })
    expect(g.acquire('box', 'j1', Infinity)).toEqual({ admitted: true })
    expect(g.runningCount('box')).toBe(2)
    expect(g.computerCount('box')).toBe(1)
    expect(g.acquire('box', 's2', Infinity, 'computer')).toEqual({ admitted: true })
    const j2 = g.acquire('box', 'j2', Infinity)
    expect(j2.admitted).toBe(false)
    if (!j2.admitted) expect(j2.held.reason).toBe('cap')
  })

  it('the computer cap holds a session with reason computer and its counts; a command behind it still starts', async () => {
    const { g, changes } = guard({ max: { box: 4 }, computer: { box: 1 } })
    g.acquire('box', 's1', Infinity, 'computer')
    const s2 = g.acquire('box', 's2', Infinity, 'computer')
    expect(s2.admitted).toBe(false)
    if (s2.admitted) throw new Error('unreachable')
    expect(s2.held).toEqual({ reason: 'computer', position: 1, load: 0, limit: 16, cores: 8, maxRunning: 4, running: 1, computer: 1, maxComputer: 1 })
    expect(g.acquire('box', 'j1', Infinity)).toEqual({ admitted: true })
    expect(g.runningCount('box')).toBe(2)
    const s3 = g.acquire('box', 's3', Infinity, 'computer')
    if (s3.admitted) throw new Error('unreachable')
    expect(s3.held.position).toBe(2)
    g.release('s1')
    expect(await endOf(s2.done)).toBe('admitted')
    expect(g.computerCount('box')).toBe(1)
    expect(changes.filter(([id]) => id === 's3').at(-1)?.[1]).toMatchObject({ reason: 'computer', position: 1 })
  })

  it('a command held by the host cap behind a session held by the computer cap: positions count per cap', async () => {
    const { g } = guard({ max: { box: 2 }, computer: { box: 1 } })
    g.acquire('box', 's1', Infinity, 'computer')
    g.acquire('box', 'j1', Infinity)
    const s2 = g.acquire('box', 's2', Infinity, 'computer')
    const j2 = g.acquire('box', 'j2', Infinity)
    if (s2.admitted || j2.admitted) throw new Error('unreachable')
    expect(s2.held).toMatchObject({ reason: 'computer', position: 1 })
    expect(j2.held).toMatchObject({ reason: 'cap', position: 1 })
    g.release('j1')
    expect(await endOf(j2.done)).toBe('admitted')
    expect(await endOf(s2.done)).toBe('open')
    g.release('s1')
    expect(await endOf(s2.done)).toBe('admitted')
    expect([g.runningCount('box'), g.computerCount('box')]).toEqual([2, 1])
  })

  it('release frees both counts; a busy Mac holds both kinds with reason load', () => {
    const { g, setLoad } = guard({ computer: { box: 2 } })
    g.acquire('box', 's1', Infinity, 'computer')
    g.release('s1')
    expect(g.runningCount('box')).toBe(0)
    expect(g.computerCount('box')).toBe(0)
    setLoad(100)
    g.sample()
    const s = g.acquire('box', 's2', Infinity, 'computer')
    const j = g.acquire('box', 'j', Infinity)
    if (s.admitted || j.admitted) throw new Error('unreachable')
    expect([s.held.reason, s.held.position, j.held.reason, j.held.position]).toEqual(['load', 1, 'load', 2])
  })
})

describe('MacLoadGuard: the load watch', () => {
  it('over the limit holds every new call, whatever its host; under three quarters of it they go, in order', async () => {
    const { g, setLoad, changes } = guard({ cores: 4 })
    expect(g.status()).toMatchObject({
      load: 0,
      cores: 4,
      limit: 8,
      resumeBelow: 6,
      busy: false,
      pinned: false
    })
    setLoad(8.5)
    expect(g.sample().busy).toBe(true)
    const a = g.acquire('box', 'a', Infinity)
    const b = g.acquire('other', 'b', Infinity)
    if (a.admitted || b.admitted) throw new Error('unreachable')
    expect(a.held).toMatchObject({
      reason: 'load',
      position: 1,
      load: 8.5,
      limit: 8,
      cores: 4,
      running: 0
    })
    expect(b.held).toMatchObject({ reason: 'load', position: 1 })
    // Back under the limit but not under the resume line: still held, the figure updated.
    setLoad(7)
    expect(g.sample().busy).toBe(true)
    expect(await endOf(a.done)).toBe('open')
    expect(g.heldOf('a')).toMatchObject({ reason: 'load', load: 7 })
    expect(changes.at(-2)).toEqual(['a', expect.objectContaining({ load: 7 })])
    setLoad(5.9)
    expect(g.sample().busy).toBe(false)
    expect(await a.done).toBe('admitted')
    expect(await b.done).toBe('admitted')
    expect(g.runningCount('box')).toBe(1)
    expect(g.runningCount('other')).toBe(1)
  })

  it('load and cap together: the load holds first; once calm, the cap still queues the rest', async () => {
    const { g, setLoad } = guard({ cores: 4, max: { box: 1 } })
    setLoad(9)
    g.sample()
    const a = g.acquire('box', 'a', Infinity)
    const b = g.acquire('box', 'b', Infinity)
    if (a.admitted || b.admitted) throw new Error('unreachable')
    expect([a.held.reason, b.held.reason]).toEqual(['load', 'load'])
    setLoad(1)
    g.sample()
    expect(await a.done).toBe('admitted')
    expect(await endOf(b.done)).toBe('open')
    expect(g.heldOf('b')).toMatchObject({ reason: 'cap', position: 1, running: 1, maxRunning: 1 })
  })

  it('a pinned limit replaces 2 × cores, and pinning it under the load holds at once', async () => {
    const { g, setLoad, pin } = guard({ cores: 8, load: 5 })
    expect(g.acquire('box', 'a', Infinity).admitted).toBe(true)
    pin(4)
    g.reconsider()
    expect(g.status()).toMatchObject({ limit: 4, pinned: true, resumeBelow: 3, busy: true })
    const b = g.acquire('box', 'b', Infinity)
    if (b.admitted) throw new Error('unreachable')
    expect(b.held).toMatchObject({ reason: 'load', limit: 4 })
    pin(null)
    g.reconsider()
    expect(g.status()).toMatchObject({ limit: 16, pinned: false, busy: false })
    expect(await b.done).toBe('admitted')
    setLoad(0)
    expect(g.sample().busy).toBe(false)
  })

  it('close ends every hold as cancelled', async () => {
    const { g } = guard({ max: { box: 1 } })
    g.acquire('box', 'a', Infinity)
    const b = g.acquire('box', 'b', Infinity)
    if (b.admitted) throw new Error('unreachable')
    g.close()
    expect(await b.done).toBe('cancelled')
  })
})
