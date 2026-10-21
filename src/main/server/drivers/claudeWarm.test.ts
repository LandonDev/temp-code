import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { gateway, startGateway, type Gateway } from '../gateway'
import { claudeWarm, spawnOrAdoptClaude } from './claudeWarm'
import type { WarmSpec } from './warm'

/** A stand-in CLI: stays up reading stdin until killed, like a CLI waiting for `initialize`. */
const spec = (over: Partial<WarmSpec> = {}): WarmSpec => ({
  command: 'cat',
  args: [],
  cwd: '/tmp',
  env: { PATH: process.env.PATH, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=T1;a=work', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
  ...over
})

const exited = (proc: { once: (ev: 'exit', fn: () => void) => unknown; exitCode: number | null }): Promise<void> =>
  proc.exitCode !== null ? Promise.resolve() : new Promise((ok) => proc.once('exit', () => ok()))

describe('the warm Claude process', () => {
  let gw: Gateway
  let dataDir: string
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tc-claude-warm-'))
    gw = await startGateway({ claimShim: false, tls: null, dataDir })
  })
  afterEach(() => {
    claudeWarm.retire()
  })
  afterAll(async () => {
    claudeWarm.close()
    await gw.stop()
    await rm(dataDir, { recursive: true, force: true })
  })

  it('a cold start becomes the shape to keep warm; the same shape adopts it under the thread\'s scope', async () => {
    const scope = { thread: 'T1', account: 'work', pin: false }
    const cold = spawnOrAdoptClaude(spec(), undefined, { thread: 'T1', scope, warmable: true })
    expect(cold.warmId).toBeNull()
    expect(cold.proc.pid).toBeGreaterThan(0)
    cold.proc.kill('SIGTERM')
    await exited(cold.proc)

    await claudeWarm.settled()
    const status = claudeWarm.status()
    expect(status.warm).toHaveLength(1)
    const warmId = status.warm[0].id
    // The warm process carries the warm URL, nothing of T1, and the gateway knows the id as unadopted.
    expect(gw.warmIds()).toEqual([{ id: warmId, thread: null }])
    expect(gateway()?.warmClaudeUrl(warmId)).toBe(`${gw.url('claude')}/~w=${warmId}`)

    const next = { thread: 'T2', account: 'home', pin: true }
    const adopted = spawnOrAdoptClaude(spec({ env: { ...spec().env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/claude/~t=T2;a=home;pin=1' } }), undefined, { thread: 'T2', scope: next, warmable: true })
    expect(adopted.warmId).toBe(warmId)
    expect(claudeWarm.status().warm).toEqual([])
    expect(gw.warmIds()).toEqual([{ id: warmId, thread: 'T2' }])

    // Its exit releases the id at the gateway.
    adopted.proc.kill('SIGTERM')
    await exited(adopted.proc)
    await new Promise((ok) => setTimeout(ok, 20))
    expect(gw.warmIds()).toEqual([])
  })

  it('a thread the shim routes elsewhere, or a resumed one, spawns cold and warms nothing', async () => {
    const cold = spawnOrAdoptClaude(spec(), undefined, { thread: 'T3', scope: null, warmable: false })
    expect(cold.warmId).toBeNull()
    expect(claudeWarm.status().pending).toBe(false)
    expect(claudeWarm.status().warm).toEqual([])
    cold.proc.kill('SIGTERM')
    await exited(cold.proc)
  })

  it('another shape boots cold and the warm process is replaced', async () => {
    spawnOrAdoptClaude(spec(), undefined, { thread: 'T4', scope: null, warmable: true }).proc.kill('SIGTERM')
    await claudeWarm.settled()
    const first = claudeWarm.status().warm[0]?.id
    expect(first).toBeDefined()
    const other = spawnOrAdoptClaude(spec({ args: ['-u'] }), undefined, { thread: 'T5', scope: null, warmable: true })
    expect(other.warmId).toBeNull()
    other.proc.kill('SIGTERM')
    await exited(other.proc)
    await claudeWarm.settled()
    const second = claudeWarm.status().warm[0]?.id
    expect(second).toBeDefined()
    expect(second).not.toBe(first)
    await new Promise((ok) => setTimeout(ok, 20))
    expect(gw.warmIds().map((w) => w.id)).toEqual([second])
  })

  it('the abort signal of an adopting thread kills the adopted process', async () => {
    spawnOrAdoptClaude(spec(), undefined, { thread: 'T6', scope: null, warmable: true }).proc.kill('SIGTERM')
    await claudeWarm.settled()
    const abort = new AbortController()
    const adopted = spawnOrAdoptClaude(spec(), abort.signal, { thread: 'T7', scope: null, warmable: true })
    expect(adopted.warmId).not.toBeNull()
    abort.abort()
    await exited(adopted.proc)
    expect(adopted.proc.exitCode === null || adopted.proc.signalCode === 'SIGTERM').toBe(true)
  })
})
