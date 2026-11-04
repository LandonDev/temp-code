import { describe, expect, it } from 'vitest'
import { EXITS_BEFORE_FALLBACK, ExecBroker, type BrokerChild, type BrokerOutcome, type ExecBrokerLink } from './execBroker'
import { runExecBrokerChild } from './execBrokerChild'
import { brokerPair, type BrokerSpawnOptions, type ChildMessage, type MainMessage } from './execBrokerWire'

/**
 * The exec broker over real children: the in-process pair (no spawner, as
 * the tests and proofs run it) for the semantics, and a fake spawner whose
 * "process" is the same child logic over a pair it can close, for the
 * respawn and the fallback.
 */

const NODE = process.execPath
const text = (bytes?: Uint8Array): string => Buffer.from(bytes ?? new Uint8Array()).toString('utf8')

function exec(broker: ExecBroker, file: string, args: string[], opts: Partial<BrokerSpawnOptions> = {}): { child: BrokerChild; done: Promise<BrokerOutcome> } {
  let child!: BrokerChild
  const done = new Promise<BrokerOutcome>((resolve) => {
    child = broker.run(file, args, 'exec', { stdin: false, ...opts }, resolve)
  })
  return { child, done }
}

/** A spawner whose child is the broker logic in this process over a pair; `die()` is the process going away. */
function fakeSpawner(opts: { ready?: boolean } = {}) {
  const links: { start(): void; die(): void }[] = []
  const spawner = (): ExecBrokerLink => {
    const [main, child] = brokerPair<MainMessage, ChildMessage>()
    let killAll: (() => void) | null = null
    const entry = {
      start: () => {
        killAll = runExecBrokerChild(child, { watchMainMs: 0 })
      },
      die: () => {
        killAll?.()
        child.close()
      }
    }
    links.push(entry)
    if (opts.ready !== false) entry.start()
    return { wire: main, kill: () => entry.die(), onExit: () => {} }
  }
  return { spawner, links }
}

describe('ExecBroker in this process', () => {
  const broker = new ExecBroker()

  it('runs a child and answers with both streams, the exit and the pid', async () => {
    const { child, done } = exec(broker, NODE, ['-e', "process.stdout.write('hi'); process.stderr.write('oops')"])
    const outcome = await done
    expect(text(outcome.stdout)).toBe('hi')
    expect(text(outcome.stderr)).toBe('oops')
    expect(outcome.code).toBe(0)
    expect(outcome.error).toBeUndefined()
    expect(child.pid).toBeGreaterThan(0)
    expect(child.exitCode).toBe(0)
    expect(broker.status().mode).toBe('in-process')
  })

  it('a non-zero exit is "Command failed" with the code and stderr', async () => {
    const outcome = await exec(broker, NODE, ['-e', "process.stderr.write('bad'); process.exit(3)"]).done
    expect(outcome.code).toBe(3)
    expect(outcome.error).toMatchObject({ code: 3, killed: false })
    expect(outcome.error?.message).toMatch(/^Command failed: .*\nbad$/)
  })

  it('a missing binary is ENOENT with no pid', async () => {
    const { child, done } = exec(broker, 'temp-code-no-such-binary-xyz', ['a'])
    const outcome = await done
    expect(outcome.error).toMatchObject({ code: 'ENOENT', syscall: expect.stringContaining('spawn') })
    expect(child.pid).toBeUndefined()
  })

  it('stdin reaches the child when asked for, and reads EOF otherwise', async () => {
    const piped = exec(broker, 'cat', [], { stdin: true })
    piped.child.stdin!.write('abc')
    piped.child.stdin!.end()
    expect(text((await piped.done).stdout)).toBe('abc')
    const closed = await exec(broker, 'cat', []).done
    expect(closed.code).toBe(0)
    expect(text(closed.stdout)).toBe('')
  })

  it('kill ends the child with the signal and marks it killed', async () => {
    const { child, done } = exec(broker, 'sleep', ['10'])
    await new Promise((r) => (child.pid ? r(null) : child.once('spawn', r)))
    expect(child.kill('SIGTERM')).toBe(true)
    const outcome = await done
    expect(outcome.signal).toBe('SIGTERM')
    expect(outcome.error).toMatchObject({ killed: true, signal: 'SIGTERM', code: null })
    expect(child.killed).toBe(true)
    expect(child.kill()).toBe(false)
  })

  it('a timeout kills with killSignal', async () => {
    const outcome = await exec(broker, 'sleep', ['10'], { timeout: 100 }).done
    expect(outcome.signal).toBe('SIGTERM')
    expect(outcome.error).toMatchObject({ killed: true })
  })

  it('output past maxBuffer kills the child and fails the ask', async () => {
    const outcome = await exec(broker, NODE, ['-e', "process.stdout.write('x'.repeat(200000)); setTimeout(() => {}, 5000)"], { maxBuffer: 1000 }).done
    expect(outcome.error).toMatchObject({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
    expect(text(outcome.stdout)).toHaveLength(1000)
  })

  it('spawn mode streams stdout and stderr and closes them at the end', async () => {
    const chunks: string[] = []
    const errs: string[] = []
    const child = broker.run(NODE, ['-e', "process.stdout.write('a'); process.stderr.write('b'); setTimeout(() => process.stdout.write('c'), 20)"], 'spawn', { stdin: false }, () => {})
    child.stdout!.on('data', (c: Buffer) => chunks.push(c.toString()))
    child.stderr!.on('data', (c: Buffer) => errs.push(c.toString()))
    const [code] = await new Promise<[number | null, string | null]>((r) => child.on('close', (c, s) => r([c, s])))
    expect(code).toBe(0)
    expect(chunks.join('')).toBe('ac')
    expect(errs.join('')).toBe('b')
    expect(child.stdout!.readableEnded).toBe(true)
  })

  it('honours cwd and env', async () => {
    const outcome = await exec(broker, NODE, ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.TC_BROKER_TEST)'], { cwd: '/', env: { ...process.env, TC_BROKER_TEST: 'yes' } }).done
    expect(text(outcome.stdout)).toBe('/|yes')
  })
})

describe('ExecBroker with a process of its own', () => {
  it('a kill asked before the broker is ready lands once the ask goes out', async () => {
    const fake = fakeSpawner({ ready: false })
    const broker = new ExecBroker({ log: () => {} })
    broker.install(fake.spawner)
    const { child, done } = exec(broker, 'sleep', ['10'])
    expect(child.kill()).toBe(true)
    fake.links[0].start()
    const outcome = await done
    expect(outcome.signal).toBe('SIGTERM')
  })

  it('respawns a broker that died, failing what it held with EBROKER', async () => {
    const fake = fakeSpawner()
    const log: string[] = []
    const broker = new ExecBroker({ log: (l) => log.push(l) })
    broker.install(fake.spawner)
    expect(broker.status()).toMatchObject({ mode: 'child', restarts: 0 })
    const held = exec(broker, 'sleep', ['10'])
    await new Promise((r) => (held.child.pid ? r(null) : held.child.once('spawn', r)))
    fake.links[0].die()
    const outcome = await held.done
    expect(outcome.error).toMatchObject({ code: 'EBROKER' })
    expect(fake.links).toHaveLength(2)
    expect(broker.status()).toMatchObject({ mode: 'child', restarts: 1 })
    expect(log[0]).toMatch(/the exec broker .*closed its port; respawning/)
    const again = await exec(broker, NODE, ['-e', "process.stdout.write('back')"]).done
    expect(text(again.stdout)).toBe('back')
  })

  it(`falls back into this process after ${EXITS_BEFORE_FALLBACK} deaths in a minute`, async () => {
    const fake = fakeSpawner()
    const log: string[] = []
    let now = 1_000_000
    const broker = new ExecBroker({ log: (l) => log.push(l), now: () => now })
    broker.install(fake.spawner)
    for (let i = 0; i < EXITS_BEFORE_FALLBACK; i++) {
      now += 1_000
      fake.links[i].die()
    }
    expect(fake.links).toHaveLength(EXITS_BEFORE_FALLBACK)
    expect(broker.status()).toMatchObject({ mode: 'in-process', pid: process.pid })
    expect(log.at(-1)).toMatch(/3 times in a minute: helpers run from the main process from here on/)
    const outcome = await exec(broker, NODE, ['-e', "process.stdout.write('local')"]).done
    expect(text(outcome.stdout)).toBe('local')
    expect(fake.links).toHaveLength(EXITS_BEFORE_FALLBACK)
  })

  it('deaths spread over more than a minute keep respawning', () => {
    const fake = fakeSpawner()
    let now = 0
    const broker = new ExecBroker({ log: () => {}, now: () => now })
    broker.install(fake.spawner)
    for (let i = 0; i < 5; i++) {
      now += 61_000
      fake.links[i].die()
    }
    expect(fake.links).toHaveLength(6)
    expect(broker.status()).toMatchObject({ mode: 'child', restarts: 5 })
  })

  it('a broker that never says ready is killed and counted', async () => {
    const fake = fakeSpawner({ ready: false })
    const log: string[] = []
    const broker = new ExecBroker({ log: (l) => log.push(l), readyTimeoutMs: 20 })
    broker.install(fake.spawner)
    await new Promise((r) => setTimeout(r, 60))
    expect(fake.links.length).toBeGreaterThanOrEqual(2)
    expect(log[0]).toMatch(/did not start in 20 ms; respawning/)
    broker.stop()
  })

  it('stop kills the broker and fails what it held', async () => {
    const fake = fakeSpawner()
    const broker = new ExecBroker({ log: () => {} })
    broker.install(fake.spawner)
    const held = exec(broker, 'sleep', ['10'])
    broker.stop()
    expect((await held.done).error).toMatchObject({ code: 'EBROKER' })
    expect(fake.links).toHaveLength(1)
  })
})
