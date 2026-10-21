import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WarmPool, closeWarmPools, warmKey, warmStatuses, type WarmSpec } from './warm'

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

  it('a thread of another shape boots cold; the pool retires the old warm process and re-shapes', async () => {
    pool.noteStart(spec())
    await vi.advanceTimersByTimeAsync(3_100)
    const old = spawned[0]
    const other = spec({ args: ['--model', 'claude-opus-5-5'] })
    expect(pool.adopt(other)).toBeNull()
    expect(old.killed).toBe(true)
    expect(pool.status().warm).toEqual([])
    await vi.advanceTimersByTimeAsync(3_100)
    expect(spawned).toHaveLength(2)
    expect(pool.adopt(other)?.proc).toBe(spawned[1])
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
