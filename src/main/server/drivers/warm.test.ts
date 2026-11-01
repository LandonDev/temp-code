import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WARM_SHAPES, WarmPool, closeWarmPools, missField, setWarmMemoryFloor, shapeDiff, touchWarm, warmKey, warmStatuses, type WarmSpec } from './warm'

interface Fake {
  id: string
  killed: boolean
  exit: () => void
}

const spec = (over: Partial<WarmSpec> = {}): WarmSpec => ({
  command: 'claude',
  args: ['--model', 'claude-haiku-5-5', '--output-format', 'stream-json'],
  cwd: '/work/a',
  env: { PATH: '/bin', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=T1;a=work', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
  ...over
})

describe('WarmPool', () => {
  let spawned: Fake[]
  let failSpawn: Error | null
  let pool: WarmPool<Fake>
  const make = (over: Partial<ConstructorParameters<typeof WarmPool<Fake>>[0]> = {}): WarmPool<Fake> =>
    new WarmPool<Fake>({
      driver: 'claude',
      rebind: ['ANTHROPIC_BASE_URL'],
      log: () => {},
      spawn: async (id, _spec, onExit) => {
        if (failSpawn) throw failSpawn
        const fake: Fake = { id, killed: false, exit: onExit }
        spawned.push(fake)
        return fake
      },
      kill: (p) => {
        p.killed = true
      },
      ...over
    })

  beforeEach(() => {
    vi.useFakeTimers()
    spawned = []
    failSpawn = null
    pool = make()
  })
  afterEach(() => {
    pool.close()
    vi.useRealTimers()
  })

  it('the shape leaves the rebound env keys out and nothing else', () => {
    const a = spec()
    const b = spec({ env: { ...a.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~w=x' } })
    expect(warmKey(a, ['ANTHROPIC_BASE_URL'])).toBe(warmKey(b, ['ANTHROPIC_BASE_URL']))
    expect(warmKey(a)).not.toBe(warmKey(b))
    expect(warmKey(a, ['ANTHROPIC_BASE_URL'])).not.toBe(warmKey(spec({ cwd: '/work/b' }), ['ANTHROPIC_BASE_URL']))
    expect(warmKey(a, ['ANTHROPIC_BASE_URL'])).not.toBe(warmKey(spec({ args: [...a.args, '--allowedTools', 'Bash'] }), ['ANTHROPIC_BASE_URL']))
    expect(pool.envFor(a, { ANTHROPIC_BASE_URL: 'http://w' })).toEqual({ PATH: '/bin', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1', ANTHROPIC_BASE_URL: 'http://w' })
  })

  it('a cold start warms its shape after the replace delay, not before', async () => {
    pool.noteStart(spec())
    expect(spawned).toHaveLength(0)
    expect(pool.status().pending).toBe(true)
    await vi.advanceTimersByTimeAsync(2_999)
    expect(spawned).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2)
    expect(spawned).toHaveLength(1)
    expect(pool.status().warm).toHaveLength(1)
    expect(pool.status().pending).toBe(false)
  })

  it('a thread of the same shape adopts the warm process and a replacement follows', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    const warm = spawned[0]
    const adopted = pool.adopt(spec({ env: { ...spec().env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=T2;a=home' } }))
    expect(adopted?.proc).toBe(warm)
    expect(adopted?.id).toBe(warm.id)
    expect(pool.status().warm).toEqual([])
    expect(pool.status().adopted).toBe(1)
    expect(warm.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(2)
    expect(pool.status().warm[0]?.id).toBe(spawned[1].id)
  })

  it('a thread of another shape boots cold and is kept warm beside the first', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    const old = spawned[0]
    const other = spec({ args: ['--model', 'claude-opus-5-5'] })
    expect(pool.adopt(other)).toBeNull()
    expect(old.killed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(2)
    expect(pool.status().warm.map((w) => w.id)).toEqual([spawned[1].id, old.id])
    expect(pool.adopt(other)?.proc).toBe(spawned[1])
    expect(pool.adopt(spec())?.proc).toBe(old)
  })

  it('holds three shapes at once; a fourth retires the shape that started longest ago', async () => {
    expect(WARM_SHAPES).toBe(3)
    const shapes = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1'].map((m) => spec({ args: ['--model', m] }))
    for (const s of shapes.slice(0, 3)) {
      pool.noteStart(s)
      await vi.advanceTimersByTimeAsync(3_100)
    }
    expect(pool.status().warm).toHaveLength(3)
    // A start of the first shape makes it the newest again: the second is now the oldest.
    expect(pool.adopt(shapes[0])?.proc).toBe(spawned[0])
    await vi.advanceTimersByTimeAsync(3_100)
    pool.noteStart(shapes[3])
    expect(spawned[1].killed).toBe(true)
    expect(spawned[2].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(3_100)
    expect(pool.status().warm).toHaveLength(3)
    expect(spawned.filter((f) => !f.killed && f !== spawned[0])).toHaveLength(3)
  })

  it('a burst refills at once: a shape started twice inside a minute', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    // Three starts of one shape a second apart: each adopts.
    for (let i = 0; i < 3; i++) {
      expect(pool.adopt(spec())).not.toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
    }
    expect(pool.status().adopted).toBe(3)
    expect(spawned).toHaveLength(4)
    // Past the window, a lone start waits for the replace delay again.
    await vi.advanceTimersByTimeAsync(61_000)
    expect(pool.adopt(spec())).not.toBeNull()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(spawned).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(2_100)
    expect(spawned).toHaveLength(5)
  })

  it('each shape retires on its own, ten minutes after its last start', async () => {
    const a = spec()
    const b = spec({ cwd: '/work/b' })
    pool.noteStart(a)
    await vi.advanceTimersByTimeAsync(3_100)
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    pool.noteStart(b)
    await vi.advanceTimersByTimeAsync(3_100)
    // a started at 0, b at 303.1 s; now 306.2 s. a is alive at 590 s, gone past 600 s.
    await vi.advanceTimersByTimeAsync(283_800)
    expect(spawned[0].killed).toBe(false)
    await vi.advanceTimersByTimeAsync(10_100)
    expect(spawned[0].killed).toBe(true)
    expect(spawned[1].killed).toBe(false)
    expect(pool.status().warm.map((w) => w.cwd)).toEqual(['/work/b'])
    // b retires at 903.1 s.
    await vi.advanceTimersByTimeAsync(303_100)
    expect(spawned[1].killed).toBe(true)
    expect(pool.status().warm).toEqual([])
  })

  it("a draft in a folder keeps that folder's shapes another retire period, and no other", async () => {
    pool.noteStart(spec())
    pool.noteStart(spec({ cwd: '/work/b' }))
    await vi.advanceTimersByTimeAsync(3_100)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    touchWarm('/work/a')
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(pool.status().warm.map((w) => w.cwd)).toEqual(['/work/a'])
    expect(pool.touchCwd('/nowhere')).toBe(0)
  })

  it('nothing warms while memory is under the floor', async () => {
    let low = true
    const lines: string[] = []
    pool.close()
    pool = make({ log: (l) => lines.push(l) })
    setWarmMemoryFloor(() => low)
    try {
      pool.noteStart(spec())
      await vi.advanceTimersByTimeAsync(3_100)
      expect(spawned).toHaveLength(0)
      expect(pool.adopt(spec())).toBeNull()
      expect(pool.status().misses).toEqual({ memory: 1 })
      expect(lines.filter((l) => l.includes('memory is under the floor'))).toHaveLength(1)
      low = false
      pool.noteStart(spec())
      await vi.advanceTimersByTimeAsync(3_100)
      expect(spawned).toHaveLength(1)
    } finally {
      setWarmMemoryFloor(() => false)
    }
  })

  it('a miss names the first field it differs on from the nearest warm process', () => {
    const base = spec({ args: ['--model', 'm', '--effort', 'low', '--permission-mode', 'default', '--allowedTools', 'Read', '--settings', '{}'] })
    const flag = (name: string, value: string): WarmSpec => {
      const args = [...base.args]
      args[args.indexOf(name) + 1] = value
      return { ...base, args }
    }
    expect(missField(base, [])).toBe('empty')
    expect(missField(flag('--model', 'n'), [base])).toBe('model')
    expect(missField(flag('--effort', 'high'), [base])).toBe('effort')
    expect(missField(flag('--allowedTools', 'Read,Bash'), [base])).toBe('tools')
    expect(missField({ ...base, args: [...base.args, '--disallowedTools', 'Edit'] }, [base])).toBe('tools')
    expect(missField(flag('--permission-mode', 'bypassPermissions'), [base])).toBe('permission')
    expect(missField(flag('--settings', '{"fastMode":true}'), [base])).toBe('settings')
    expect(missField({ ...base, cwd: '/elsewhere' }, [base])).toBe('cwd')
    expect(missField({ ...base, args: [...base.args, '--resume', 'abc'] }, [base])).toBe('resume')
    // The nearest warm process decides: one field off beats three.
    const far = flag('--model', 'x')
    far.cwd = '/x'
    expect(missField(flag('--effort', 'max'), [far, base])).toBe('effort')
    expect(shapeDiff({ ...base, cwd: '/x' }, flag('--model', 'z'))).toEqual(['model', 'cwd'])
  })

  it('status lists every warm process and counts misses by field', async () => {
    const lines: string[] = []
    pool.close()
    pool = make({ log: (l) => lines.push(l) })
    expect(pool.adopt(spec())).toBeNull()
    pool.noteStart(spec({ cwd: '/work/b' }))
    await vi.advanceTimersByTimeAsync(3_100)
    expect(pool.adopt(spec({ args: ['--model', 'other'] }))).toBeNull()
    expect(pool.adopt(spec({ args: ['--model', 'other'] }))).toBeNull()
    await vi.advanceTimersByTimeAsync(3_100)
    const status = pool.status()
    expect(status.warm.map((w) => w.cwd)).toEqual(['/work/a', '/work/b', '/work/a'].slice(0, status.warm.length))
    expect(status.warm.every((w) => w.retiresInMs !== null && w.retiresInMs > 0)).toBe(true)
    expect(status.misses).toEqual({ empty: 1, model: 1, refilling: 1 })
    expect(lines).toContain('[warm] claude: miss (empty) 0 warm')
    expect(lines.some((l) => /miss \(model\) \d warm/.test(l))).toBe(true)
  })

  it('retires after ten minutes without a thread start; a start pushes it out', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(spawned[0].killed).toBe(false)
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(spawned[0].killed).toBe(false)
    expect(pool.status().retiresInMs).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(60_000 + 3_100)
    expect(spawned[0].killed).toBe(true)
    expect(pool.status().warm).toEqual([])
    expect(pool.status().retiresInMs).toBeNull()
    // Nothing respawns on its own; the next thread start does.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(spawned).toHaveLength(1)
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(2)
  })

  it('a warm process that dies on its own is forgotten; the next start spawns again', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    spawned[0].exit()
    expect(pool.status().warm).toEqual([])
    expect(pool.adopt(spec())).toBeNull()
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(2)
  })

  it('a failed spawn is logged and left until the next thread start', async () => {
    const lines: string[] = []
    pool.close()
    pool = make({ log: (l) => lines.push(l) })
    failSpawn = new Error('ENOENT')
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(0)
    expect(lines.some((l) => l.includes('spawn failed: ENOENT'))).toBe(true)
    expect(pool.status().pending).toBe(false)
    failSpawn = null
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(1)
  })

  it('a spawn that lands after the pool stopped wanting it is killed at once', async () => {
    let release: ((f: Fake) => void) | null = null
    pool.close()
    pool = make({
      spawn: (id) =>
        new Promise<Fake>((ok) => {
          release = (f) => ok(f)
          void id
        })
    })
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    pool.retire()
    const late: Fake = { id: 'late', killed: false, exit: () => {} }
    release!(late)
    await vi.advanceTimersByTimeAsync(1)
    expect(late.killed).toBe(true)
    expect(pool.status().warm).toEqual([])
  })

  it('does not warm when disabled, and close kills what is warm', async () => {
    let on = false
    pool.close()
    pool = make({ enabled: () => on })
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(0)
    on = true
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(1)
    expect(warmStatuses().some((s) => s.driver === 'claude' && s.warm.length === 1)).toBe(true)
    closeWarmPools()
    expect(spawned[0].killed).toBe(true)
    expect(warmStatuses()).toEqual([])
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(1)
  })
})
