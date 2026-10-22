import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { FacadeContext } from './facade'
import { HostRelay, type LaneSocket } from './relay'
import { startLoopbackHosts } from './relayLoopback'

const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}
const T0 = Date.UTC(2026, 2, 4, 9, 14)
const AVAILABLE = 'env_loopAvailable00000000'
const LOCKED = 'env_loopLocked00000000000'
const ASLEEP = 'env_loopAsleep00000000000'
const DOWN = 'env_loopDown0000000000000'

class Ws implements LaneSocket {
  readonly OPEN = 1
  readyState = 1
  sent: ServerFrame[] = []
  closed: { code: number; reason: string } | null = null
  private handlers = new Map<string, ((...a: unknown[]) => void)[]>()
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerFrame)
  }
  close(code: number, reason: string): void {
    this.closed ??= { code, reason }
    this.readyState = 3
  }
  on(event: string, l: (...a: unknown[]) => void): unknown {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), l])
    return this
  }
  request(id: string, method: string, params: unknown = {}): void {
    for (const h of this.handlers.get('message') ?? []) h(JSON.stringify({ id, method, params }))
  }
  answer(id: string): ServerFrame | undefined {
    return this.sent.find((f) => 'id' in f && f.id === id)
  }
}

function setup() {
  const store = new Map<string, string>()
  const relay = new HostRelay({
    environmentId: 'env_carrier0000000000000',
    transport: { online: () => false, open: async () => ({ ok: true, contract: 1 }), frame: async () => {}, close: async () => {}, facade: async () => ({ ok: true, result: null }) },
    calls: { onRegister: () => () => {}, onDrop: () => () => {}, info: () => null, registeredIds: () => [] },
    store: { getSetting: (k) => store.get(k) ?? null, setSetting: (k, v) => (v === null ? store.delete(k) : store.set(k, v)) },
    broadcast: () => {},
    pushLocal: async () => null,
    deliverNotice: async () => {},
    contract: 1,
    now: () => T0 + 60_000,
    timeZone: 'UTC',
    log: () => {}
  })
  const attached: string[] = []
  const row = { platform: 'darwin', link: 'up' as const, since: T0, screen: 'unlocked' as const, power: 'awake' as const, lastSeenAt: T0, build: null }
  const loop = startLoopbackHosts({
    carrierId: 'env_carrier0000000000000',
    carrierName: 'Test box',
    relay,
    // what the server's attach() does: its hello, then an answer per request
    attach: (socket, principal) => {
      attached.push(principal.name)
      socket.send(JSON.stringify({ push: 'hello', environmentId: 'carrier', contract: 1, caps: principal.caps }))
      socket.on('message', (d: Buffer | string) => {
        const req = JSON.parse(String(d)) as { id: string; method: string }
        socket.send(JSON.stringify({ id: req.id, ok: true, result: `served ${req.method}` }))
      })
    },
    facade: () => ({ registry: { listProjects: () => [], listWorkspaces: () => [] } as unknown as FacadeContext['registry'], origin: null }),
    hosts: [
      { environmentId: AVAILABLE, name: 'Studio Mac', row },
      { environmentId: LOCKED, name: 'Studio Mac (locked)', row: { ...row, screen: 'locked' } },
      { environmentId: ASLEEP, name: 'Studio Mac (asleep)', row: { ...row, power: 'asleep' } },
      { environmentId: DOWN, name: 'Studio Mac (unreachable)', row: { ...row, link: 'down', since: T0 - 5 * 60_000 } }
    ]
  })
  const principal = { kind: 'remote' as const, keyId: 'k1', name: 'Phone', audience: 'client' as const, caps: ['read' as const, 'operate' as const] }
  const lane = (envId: string): Ws => {
    const ws = new Ws()
    relay.attachRelayed(ws, principal, envId)
    return ws
  }
  return { relay, loop, lane, attached }
}

describe('the loopback relay (the iOS test server seed)', () => {
  it('lists the four hosts; the down one is not online', () => {
    const { relay, loop } = setup()
    expect(relay.hosts().map((h) => [h.name, h.link, h.screen, h.power])).toEqual(
      expect.arrayContaining([
        ['Studio Mac', 'up', 'unlocked', 'awake'],
        ['Studio Mac (locked)', 'up', 'locked', 'awake'],
        ['Studio Mac (asleep)', 'up', 'unlocked', 'asleep'],
        ['Studio Mac (unreachable)', 'down', 'unlocked', 'awake']
      ])
    )
    expect([AVAILABLE, LOCKED, ASLEEP, DOWN].map((id) => relay.online(id))).toEqual([true, true, true, false])
    loop.close()
  })

  it('carries a lane to the carrier own attach() under the fake host id', async () => {
    const { lane, attached, loop } = setup()
    const ws = lane(AVAILABLE)
    expect(ws.sent[0]).toMatchObject({ push: 'hello', environmentId: AVAILABLE, via: 'env_carrier0000000000000' })
    await tick()
    expect(attached).toEqual(['Phone via Test box'])
    ws.request('1', 'session.list')
    await tick()
    expect(ws.answer('1')).toEqual({ id: '1', ok: true, result: 'served session.list' })
    // the carrier's own hello is swallowed: only the composed one reached the phone
    expect(ws.sent.filter((f) => 'push' in f && f.push === 'hello')).toHaveLength(1)
    loop.close()
  })

  it('the locked host refuses only the screen method; the asleep one refuses everything; a flip is heard as presence', async () => {
    const { lane, loop, relay } = setup()
    const locked = lane(LOCKED)
    await tick()
    locked.request('1', 'host.device.openXcode', { udid: 'U' })
    locked.request('2', 'session.list')
    await tick()
    expect(locked.answer('1')).toEqual({ id: '1', ok: false, error: 'unavailable: the Mac is locked' })
    expect(locked.answer('2')).toMatchObject({ ok: true })
    const asleep = lane(ASLEEP)
    await tick()
    asleep.request('3', 'session.list')
    await tick()
    expect(asleep.answer('3')).toEqual({ id: '3', ok: false, error: 'unavailable: the Mac is asleep' })
    expect(asleep.closed).toBeNull()
    // the control route: the host wakes, the lane hears it and its next request runs
    expect(loop.setPresence(ASLEEP, { power: 'awake' })).toMatchObject({ power: 'awake' })
    await tick()
    expect(asleep.sent.some((f) => 'push' in f && f.push === 'presence')).toBe(true)
    asleep.request('4', 'session.list')
    await tick()
    expect(asleep.answer('4')).toMatchObject({ ok: true })
    expect(relay.presenceOf(ASLEEP)?.power).toBe('awake')
    loop.close()
  })

  it('a lane to the unreachable host closes 4010 with its since', () => {
    const { lane, loop } = setup()
    const ws = lane(DOWN)
    expect(ws.closed).toEqual({ code: 4010, reason: 'host unreachable' })
    loop.close()
  })
})
