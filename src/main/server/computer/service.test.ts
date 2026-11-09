import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ComputerServiceState } from '@shared/contract-computer'
import { ComputerHostError } from './connection'
import { CRASHES_TO_DOWN, ComputerService, DOWN_FOR_MS, IDLE_SHUTDOWN_MS, PING_DEADLINE_MS, PING_EVERY_MS, SPAWN_BACKOFF_MS, type Clock } from './service'
import { fakeServiceBin } from './testFake'

/** The supervisor's own timers on a hand-turned clock; the connection's deadlines stay real. */
class ManualClock implements Clock {
  t = 1_000_000
  private timers: { at: number; fn: () => void; id: number }[] = []
  private next = 0
  now = (): number => this.t
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.next
    this.timers.push({ at: this.t + ms, fn, id })
    return id
  }
  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== id)
  }
  async advance(ms: number): Promise<void> {
    const until = this.t + ms
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at)
      const due = this.timers[0]
      if (!due || due.at > until) break
      this.timers.shift()
      this.t = due.at
      due.fn()
      await settle()
    }
    this.t = until
    await settle()
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}
const until = async (pred: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

const services: ComputerService[] = []
afterEach(async () => {
  for (const s of services.splice(0)) await s.close()
})

function make(env: Record<string, string> = {}, over: { bin?: () => string; unavailable?: () => string | null } = {}) {
  const clock = new ManualClock()
  const states: ComputerServiceState[] = []
  const epochs: string[] = []
  const log = join(mkdtempSync(join(tmpdir(), 'tc-computer-svc-')), 'requests.log')
  let spawns = 0
  const bin = over.bin ?? (() => fakeServiceBin())
  const service = new ComputerService({
    dataDir: mkdtempSync(join(tmpdir(), 'tc-computer-data-')),
    env: { ...process.env, FAKE_LOG: log, ...env },
    clock,
    log: () => undefined,
    bin: () => (spawns++, bin()),
    unavailable: over.unavailable
  })
  service.onState((s) => states.push(s))
  service.onEpoch((e) => epochs.push(e))
  services.push(service)
  return { service, clock, states, epochs, log, spawns: () => spawns }
}
const crash = async (service: ComputerService): Promise<unknown> => {
  await service.request('session.open', { session: 's1' })
  return service.request('action.run', { session: 's1', app: { app: 'Crashy' }, action: { action: 'key', text: 'a' }, tiers: ['process'] }).catch((e) => e)
}

describe('ComputerService', () => {
  it('spawns nothing until the first call, and two first calls share one spawn', async () => {
    const { service, spawns, states } = make()
    expect(service.state().state).toBe('off')
    expect(spawns()).toBe(0)
    const [a, b] = await Promise.all([service.request('permissions.get', {}), service.request('permissions.get', {})])
    expect(a).toEqual(b)
    expect(spawns()).toBe(1)
    expect(states.map((s) => s.state)).toEqual(['starting', 'up'])
    expect(service.state()).toMatchObject({ state: 'up', restarts: 0, permissions: { accessibility: true, screenRecording: true } })
  })

  it('a crash rejects the call in flight and the next spawn waits its backoff', async () => {
    const { service, clock, spawns, epochs } = make()
    const err = await crash(service)
    expect((err as ComputerHostError).kind).toBe('service_restarted')
    await until(() => service.state().restarts === 1, 'the crash')
    let done = false
    const next = service.request('permissions.get', {}).then(() => (done = true))
    await settle()
    expect(spawns()).toBe(1)
    await clock.advance(SPAWN_BACKOFF_MS[0])
    await next
    expect(done).toBe(true)
    expect(spawns()).toBe(2)
    expect(epochs).toHaveLength(2)
    expect(epochs[0]).not.toBe(epochs[1])
  })

  it('five crashes in two minutes put it down for five minutes with the stderr line', async () => {
    const { service, clock } = make()
    for (let i = 0; i < CRASHES_TO_DOWN; i++) {
      const pending = crash(service)
      await clock.advance(SPAWN_BACKOFF_MS[Math.max(0, i - 1)] ?? 0)
      await pending
      await until(() => service.state().restarts === i + 1, `crash ${i + 1}`)
    }
    expect(service.state()).toMatchObject({ state: 'down' })
    expect(service.state().reason).toContain('fake crash')
    const refused = await service.request('permissions.get', {}).catch((e) => e)
    expect((refused as ComputerHostError).kind).toBe('service_unavailable')
    expect((refused as Error).message).toContain('crashed 5 times')
    await clock.advance(DOWN_FOR_MS)
    const up = service.request('permissions.get', {})
    await clock.advance(1)
    await expect(up).resolves.toMatchObject({ accessibility: true })
  })

  it('exit 75 respawns with no wait', async () => {
    const { service, spawns } = make({ FAKE_EXIT_75_AFTER: '2' })
    await service.request('permissions.get', {})
    await until(() => service.state().state === 'idle', 'the grant restart')
    await service.request('permissions.get', {})
    expect(spawns()).toBe(2)
    expect(service.state().restarts).toBe(1)
  })

  it('exit 75 with live sessions respawns at once', async () => {
    const { service, spawns } = make({ FAKE_EXIT_75_AFTER: '2' })
    service.setBusy(true)
    await service.request('permissions.get', {})
    await until(() => spawns() === 2 && service.state().state === 'up', 'the respawn')
  })

  it('a bad command line makes it unavailable for good', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-computer-bad-'))
    const bin = join(dir, 'tc-computer')
    writeFileSync(bin, '#!/bin/sh\necho "unknown flag" >&2\nexit 64\n')
    chmodSync(bin, 0o755)
    const { service, spawns } = make({}, { bin: () => bin })
    const err = await service.request('permissions.get', {}).catch((e) => e)
    expect((err as ComputerHostError).kind).toBe('service_unavailable')
    expect(service.state()).toMatchObject({ state: 'unavailable' })
    expect(service.state().reason).toContain('unknown flag')
    await service.request('permissions.get', {}).catch(() => undefined)
    expect(spawns()).toBe(1)
  })

  it('answers service_unavailable with the host reason, and asks again at every call', async () => {
    let why: string | null = 'tc-computer is not built'
    const { service, spawns } = make({}, { unavailable: () => why })
    const err = await service.request('permissions.get', {}).catch((e) => e)
    expect((err as Error).message).toBe('computer use is off on this host: tc-computer is not built; do the work another way')
    expect(spawns()).toBe(0)
    why = null
    await service.request('permissions.get', {})
    expect(spawns()).toBe(1)
  })

  it('the ping kills a process that misses twice while a request runs long', async () => {
    const { service, clock } = make({ FAKE_NO_PONG: '1' })
    await service.request('session.open', { session: 's1' })
    const slow = service.request('state.get', { session: 's1', app: { app: 'Slow' } }).catch((e) => e)
    await settle()
    await clock.advance(PING_EVERY_MS)
    await clock.advance(PING_DEADLINE_MS)
    expect(service.state().state).toBe('up')
    await clock.advance(PING_EVERY_MS - PING_DEADLINE_MS)
    await clock.advance(PING_DEADLINE_MS)
    expect(((await slow) as ComputerHostError).kind).toBe('service_restarted')
    await until(() => service.state().restarts === 1, 'the kill')
  })

  it('shuts down after ten idle minutes, and never while a session is live', async () => {
    const { service, clock, log } = make()
    service.setBusy(true)
    await service.request('permissions.get', {})
    await clock.advance(IDLE_SHUTDOWN_MS * 2)
    expect(service.state().state).toBe('up')
    service.setBusy(false)
    await clock.advance(IDLE_SHUTDOWN_MS - 1)
    expect(service.state().state).toBe('up')
    await clock.advance(1)
    await until(() => service.state().state === 'idle', 'the idle shutdown')
    expect(readFileSync(log, 'utf8')).toContain('"shutdown"')
    await service.request('permissions.get', {})
    expect(service.state().state).toBe('up')
  })

  it('keeps the permissions from initialize and every permissions/changed', async () => {
    const { service, states } = make({ FAKE_PERMISSIONS_CHANGE_MS: '20' })
    await service.request('permissions.get', {})
    expect(service.permissions()).toEqual({ accessibility: true, screenRecording: true })
    await until(() => service.permissions()?.screenRecording === false, 'the change')
    expect(states.at(-1)?.permissions?.screenRecording).toBe(false)
  })
})
