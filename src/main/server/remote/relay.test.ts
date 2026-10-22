import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '@shared/capabilities'
import type { ServerFrame, ServerPush } from '@shared/contract'
import { RELAY_HOSTS_MAX, type HostPresence, type RelayFacadeResult, type RelayOpenResult, type RelayPrincipal } from '@shared/contract-relay'
import { PeerOfflineError, type PeerInfo } from './peerCalls'
import { HostRelay, type LaneSocket, type RelayTransport } from './relay'

const UTC = 'UTC'
const T0 = Date.UTC(2026, 2, 4, 9, 14)
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** A fake PeerCalls: registrations by hand, with the info a peer.register carries. */
class FakeCalls {
  private readonly registered = new Map<string, { offers: Set<string>; info: PeerInfo }>()
  private readonly onReg = new Set<(id: string, offers: ReadonlySet<string>) => void>()
  private readonly onDr = new Set<(id: string, offers: ReadonlySet<string>) => void>()
  onRegister(l: (id: string, offers: ReadonlySet<string>) => void): () => void {
    this.onReg.add(l)
    return () => this.onReg.delete(l)
  }
  onDrop(l: (id: string, offers: ReadonlySet<string>) => void): () => void {
    this.onDr.add(l)
    return () => this.onDr.delete(l)
  }
  info(id: string): PeerInfo | null {
    return this.registered.get(id)?.info ?? null
  }
  registeredIds(offer?: string): string[] {
    return [...this.registered.entries()].filter(([, r]) => !offer || r.offers.has(offer)).map(([id]) => id)
  }
  register(id: string, info: Partial<PeerInfo> = {}, offers = ['mac-bridge', 'relay'], at = T0): void {
    this.registered.set(id, { offers: new Set(offers), info: { name: null, build: null, presence: null, at, lastSeenAt: at, ...info } })
    for (const l of this.onReg) l(id, new Set(offers))
  }
  drop(id: string): void {
    const reg = this.registered.get(id)
    if (!reg) return
    this.registered.delete(id)
    for (const l of this.onDr) l(id, reg.offers)
  }
}

class FakeTransport implements RelayTransport {
  opens: { envId: string; socketId: string; principal: RelayPrincipal }[] = []
  frames: { envId: string; socketId: string; frame: unknown }[] = []
  closes: { envId: string; socketId: string; reason: string }[] = []
  facades: { envId: string; principal: RelayPrincipal; name: string; args: unknown }[] = []
  openAnswer: () => Promise<RelayOpenResult> = async () => ({ ok: true, contract: 1 })
  frameAnswer: (frame: unknown) => Promise<void> = async () => {}
  facadeAnswer: () => Promise<RelayFacadeResult> = async () => ({ ok: true, result: { fine: true } })
  constructor(private readonly calls: FakeCalls) {}
  online(envId: string): boolean {
    return this.calls.registeredIds('relay').includes(envId)
  }
  open(envId: string, socketId: string, principal: RelayPrincipal): Promise<RelayOpenResult> {
    this.opens.push({ envId, socketId, principal })
    return this.openAnswer()
  }
  frame(envId: string, socketId: string, frame: unknown): Promise<void> {
    this.frames.push({ envId, socketId, frame })
    return this.frameAnswer(frame)
  }
  async close(envId: string, socketId: string, reason: string): Promise<void> {
    this.closes.push({ envId, socketId, reason })
  }
  facade(envId: string, principal: RelayPrincipal, name: string, args: unknown): Promise<RelayFacadeResult> {
    this.facades.push({ envId, principal, name, args })
    return this.facadeAnswer()
  }
}

class FakeWs implements LaneSocket {
  readonly OPEN = 1
  readyState = 1
  sent: ServerFrame[] = []
  closed: { code: number; reason: string } | null = null
  private readonly handlers = new Map<string, ((...args: unknown[]) => void)[]>()
  send(text: string): void {
    this.sent.push(JSON.parse(text) as ServerFrame)
  }
  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = { code, reason }
    this.readyState = 3
    for (const h of this.handlers.get('close') ?? []) h()
  }
  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.handlers.get(event) ?? []
    list.push(listener)
    this.handlers.set(event, list)
    return this
  }
  /** The phone sends a request. */
  request(id: string, method: string, params: unknown = {}): void {
    for (const h of this.handlers.get('message') ?? []) h(JSON.stringify({ id, method, params }))
  }
  /** The phone hangs up. */
  hangUp(): void {
    this.readyState = 3
    for (const h of this.handlers.get('close') ?? []) h()
  }
  answers(): ServerFrame[] {
    return this.sent.filter((f) => 'id' in f)
  }
}

const principal = (caps: ('read' | 'operate' | 'approve' | 'admin')[] = ['read', 'operate']): Principal & { kind: 'remote' } => ({
  kind: 'remote',
  keyId: 'k1',
  name: 'Phone',
  audience: 'client',
  caps
})
const build = { release: 300, version: '1.0.300', sha: 'abc', platform: 'darwin' }

function make(opts: { store?: Map<string, string>; now?: { t: number } } = {}) {
  const now = opts.now ?? { t: T0 }
  const calls = new FakeCalls()
  const transport = new FakeTransport(calls)
  const store = opts.store ?? new Map<string, string>()
  const broadcasts: Extract<ServerPush, { push: 'presence' }>[] = []
  const pushLocal = vi.fn(async (req: { method: string }, p: Principal) => ({ answered: req.method, by: (p as { keyId: string }).keyId }))
  const delivered: { from: string; notice: unknown }[] = []
  const relay = new HostRelay({
    environmentId: 'env_box',
    transport,
    calls,
    store: { getSetting: (k) => store.get(k) ?? null, setSetting: (k, v) => (v === null ? store.delete(k) : store.set(k, v)) },
    broadcast: (push) => broadcasts.push(push),
    pushLocal: pushLocal as never,
    deliverNotice: async (from, notice) => {
      delivered.push({ from, notice })
    },
    contract: 1,
    now: () => now.t,
    timeZone: UTC,
    log: () => {}
  })
  return { relay, calls, transport, store, broadcasts, pushLocal, delivered, now }
}

afterEach(() => vi.useRealTimers())

describe('HostRelay presence rows', () => {
  it('a registration with the relay offer makes a row up; its drop makes it down with since; both broadcast', () => {
    const { relay, calls, broadcasts, now } = make()
    expect(relay.hosts()).toEqual([])
    calls.register('env_mac', { name: 'Studio', build, presence: { screen: 'unlocked', power: 'awake', at: T0 - 5 } })
    expect(relay.hosts()).toEqual([
      { environmentId: 'env_mac', name: 'Studio', platform: 'darwin', link: 'up', since: T0, screen: 'unlocked', power: 'awake', lastSeenAt: T0, build }
    ])
    expect(broadcasts).toHaveLength(1)
    // a registration without the relay offer is not a relayed host
    calls.register('env_old', {}, ['mac-bridge'])
    expect(relay.hosts().map((h) => h.environmentId)).toEqual(['env_mac'])
    now.t = T0 + 60_000
    calls.drop('env_mac')
    expect(relay.presenceOf('env_mac')).toMatchObject({ link: 'down', since: T0 + 60_000, name: 'Studio', build })
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1].hosts[0].link).toBe('down')
  })

  it('an older host that said nothing is "Mac" on an unknown platform, screen unknown, power awake', () => {
    const { relay, calls } = make()
    calls.register('env_mac')
    expect(relay.presenceOf('env_mac')).toMatchObject({ name: 'Mac', platform: 'unknown', screen: 'unknown', power: 'awake', build: null })
  })

  it('peer.presence updates screen, power and lastSeenAt, and broadcasts only on a change', () => {
    const { relay, calls, broadcasts, now } = make()
    calls.register('env_mac', { presence: { screen: 'unlocked', power: 'awake', at: T0 } })
    expect(broadcasts).toHaveLength(1)
    now.t = T0 + 1_000
    relay.onPeerPresence('env_mac', { screen: 'unlocked', power: 'awake', at: T0 + 900 })
    expect(relay.presenceOf('env_mac')).toMatchObject({ lastSeenAt: T0 + 1_000 })
    expect(broadcasts).toHaveLength(1)
    relay.onPeerPresence('env_mac', { screen: 'locked', power: 'awake', at: T0 + 950 })
    expect(broadcasts).toHaveLength(2)
    expect(broadcasts[1].hosts[0]).toMatchObject({ screen: 'locked', lastSeenAt: T0 + 1_000 })
    // a host with no row is ignored
    relay.onPeerPresence('env_nobody', { screen: 'locked', power: 'awake', at: 0 })
    expect(relay.hosts()).toHaveLength(1)
  })

  it('keeps the newest registration first and at most RELAY_HOSTS_MAX rows', () => {
    const { relay, calls } = make()
    for (let i = 0; i < RELAY_HOSTS_MAX + 3; i++) calls.register(`env_h${i}`)
    const ids = relay.hosts().map((h) => h.environmentId)
    expect(ids).toHaveLength(RELAY_HOSTS_MAX)
    expect(ids[0]).toBe(`env_h${RELAY_HOSTS_MAX + 2}`)
    expect(ids).not.toContain('env_h0')
  })

  it('persists the rows (debounced) and a new HostRelay on the same store lists a down host with its old since', () => {
    vi.useFakeTimers()
    const store = new Map<string, string>()
    const a = make({ store })
    a.calls.register('env_mac', { name: 'Studio', build, presence: { screen: 'locked', power: 'awake', at: T0 } })
    expect(store.has('relay.hosts')).toBe(false)
    vi.advanceTimersByTime(1_000)
    expect(store.has('relay.hosts')).toBe(true)
    a.now.t = T0 + 5_000
    a.calls.drop('env_mac')
    a.relay.close()
    const b = make({ store, now: { t: T0 + 3_600_000 } })
    expect(b.relay.hosts()).toEqual([
      { environmentId: 'env_mac', name: 'Studio', platform: 'darwin', link: 'down', since: T0 + 5_000, screen: 'locked', power: 'awake', lastSeenAt: T0, build }
    ])
    // a row that was up when persisted is down after a boot, until it registers again
    const c = make({ store })
    c.calls.register('env_mac', { name: 'Studio', build })
    vi.advanceTimersByTime(1_000)
    const d = make({ store })
    expect(d.relay.presenceOf('env_mac')?.link).toBe('down')
    expect(d.relay.presenceOf('env_mac')?.name).toBe('Studio')
    // a host already registered when the relay is built is up at once
    expect(c.relay.presenceOf('env_mac')?.link).toBe('up')
    const e = make({ store })
    expect(e.relay.presenceOf('env_mac')?.link).toBe('down')
  })

  it('a corrupt relay.hosts row starts empty', () => {
    const store = new Map<string, string>([['relay.hosts', '{nope']])
    expect(make({ store }).relay.hosts()).toEqual([])
  })
})

describe('HostRelay lanes', () => {
  function lane(opts: { caps?: ('read' | 'operate' | 'approve' | 'admin')[]; register?: boolean; presence?: Partial<HostPresence> } = {}) {
    const ctx = make()
    if (opts.register !== false)
      ctx.calls.register('env_mac', { name: 'Studio', build, presence: { screen: 'unlocked', power: 'awake', at: T0 } })
    if (opts.presence) ctx.relay.onPeerPresence('env_mac', { screen: opts.presence.screen ?? 'unlocked', power: opts.presence.power ?? 'awake', at: T0 })
    const ws = new FakeWs()
    ctx.relay.attachRelayed(ws, principal(opts.caps), 'env_mac')
    return { ...ctx, ws }
  }

  it('composes the hello under the Mac id with via, the key, its build and presence, then opens the lane on the Mac', async () => {
    const { ws, transport, relay } = lane()
    expect(ws.sent[0]).toEqual({
      push: 'hello',
      environmentId: 'env_mac',
      contract: 1,
      caps: ['read', 'operate'],
      key: { id: 'k1', name: 'Phone' },
      build,
      via: 'env_box',
      presence: { environmentId: 'env_mac', name: 'Studio', platform: 'darwin', link: 'up', since: T0, screen: 'unlocked', power: 'awake', lastSeenAt: T0, build }
    })
    await tick()
    expect(transport.opens).toHaveLength(1)
    expect(transport.opens[0]).toMatchObject({ envId: 'env_mac', principal: { keyId: 'k1', name: 'Phone', audience: 'client', caps: ['read', 'operate'] } })
    expect(relay.laneCount()).toBe(1)
  })

  it('a contract mismatch on open closes 4012; an open failure closes 4010 after failing what waited', async () => {
    const mismatch = make()
    mismatch.calls.register('env_mac')
    mismatch.transport.openAnswer = async () => ({ ok: true, contract: 2 })
    const ws1 = new FakeWs()
    mismatch.relay.attachRelayed(ws1, principal(), 'env_mac')
    await tick()
    expect(ws1.closed).toEqual({ code: 4012, reason: 'contract' })

    const failing = make()
    failing.calls.register('env_mac')
    failing.transport.openAnswer = () => Promise.reject(new PeerOfflineError('env_mac'))
    const ws2 = new FakeWs()
    failing.relay.attachRelayed(ws2, principal(), 'env_mac')
    ws2.request('1', 'session.list', {})
    await tick()
    expect(ws2.answers()).toEqual([{ id: '1', ok: false, error: 'linkDown: the Mac is unreachable since 09:14' }])
    expect(ws2.closed).toEqual({ code: 4010, reason: 'host unreachable' })
    expect(failing.relay.laneCount()).toBe(0)
  })

  it('requests before open answers queue in order and go after it', async () => {
    const ctx = make()
    ctx.calls.register('env_mac')
    let open: (r: RelayOpenResult) => void = () => {}
    ctx.transport.openAnswer = () => new Promise((r) => (open = r))
    const ws = new FakeWs()
    ctx.relay.attachRelayed(ws, principal(), 'env_mac')
    ws.request('1', 'session.list', {})
    ws.request('2', 'workspace.list', {})
    expect(ctx.transport.frames).toEqual([])
    open({ ok: true, contract: 1 })
    await tick()
    expect(ctx.transport.frames.map((f) => (f.frame as { id: string }).id)).toEqual(['1', '2'])
  })

  it("runs the box's gate first: local-only, a missing cap, and a method that does not relay", async () => {
    const { ws, transport } = lane({ caps: ['read'] })
    await tick()
    ws.request('1', 'app.listThreads', { sessionId: 's' })
    ws.request('2', 'session.send', { sessionId: 's', text: 'hi' })
    ws.request('3', 'doctor.get', {})
    ws.request('4', 'remote.keys.list', {})
    ws.request('5', 'nonsense.method', {})
    await tick()
    expect(ws.answers()).toEqual([
      { id: '1', ok: false, error: 'forbidden: app.listThreads is local-only' },
      { id: '2', ok: false, error: 'forbidden: session.send needs operate' },
      { id: '3', ok: false, error: 'forbidden: doctor.get does not relay to another host' },
      // the gate runs before the relay table: a cap the key lacks is named first
      { id: '4', ok: false, error: 'forbidden: remote.keys.list needs admin' },
      { id: '5', ok: false, error: expect.stringMatching(/^bad request: /) }
    ])
    expect(transport.frames).toEqual([])
  })

  it('answers the key\'s own remote.push.* rows on the box, and activity with null', async () => {
    const { ws, transport, pushLocal } = lane()
    await tick()
    ws.request('1', 'remote.push.status', {})
    ws.request('2', 'remote.push.activity', { sessionId: 's1', token: 'a'.repeat(64), bundleId: 'dev.landon.tempcode', environment: 'sandbox' })
    await tick()
    // the box's own answer waits on pushLocal; the null needs no call and lands first
    expect([...ws.answers()].sort((a, b) => (a as { id: string }).id.localeCompare((b as { id: string }).id))).toEqual([
      { id: '1', ok: true, result: { answered: 'remote.push.status', by: 'k1' } },
      { id: '2', ok: true, result: null }
    ])
    expect(pushLocal).toHaveBeenCalledTimes(1)
    expect(transport.frames).toEqual([])
  })

  it('a locked Mac refuses only the screen method; an asleep one refuses everything; awake again forwards', async () => {
    const { ws, transport, relay } = lane({ presence: { screen: 'locked' } })
    await tick()
    ws.request('1', 'host.device.openXcode', { udid: 'U' })
    ws.request('2', 'session.list', {})
    await tick()
    expect(ws.answers()).toEqual([{ id: '1', ok: false, error: 'unavailable: the Mac is locked' }])
    expect(transport.frames.map((f) => (f.frame as { id: string }).id)).toEqual(['2'])
    relay.onPeerPresence('env_mac', { screen: 'locked', power: 'asleep', at: T0 })
    // the lane itself hears the change, as the box's own frame
    expect(ws.sent.filter((f) => 'push' in f && f.push === 'presence').at(-1)).toMatchObject({ push: 'presence', hosts: [{ environmentId: 'env_mac', power: 'asleep' }] })
    ws.request('3', 'session.list', {})
    await tick()
    expect(ws.answers()[1]).toEqual({ id: '3', ok: false, error: 'unavailable: the Mac is asleep' })
    expect(ws.closed).toBeNull()
    relay.onPeerPresence('env_mac', { screen: 'unlocked', power: 'awake', at: T0 })
    ws.request('4', 'session.list', {})
    await tick()
    expect(transport.frames.map((f) => (f.frame as { id: string }).id)).toEqual(['2', '4'])
  })

  it('frames from the Mac go to the phone verbatim and clear pending; an unknown socket is refused', async () => {
    const { ws, transport, relay } = lane()
    await tick()
    ws.request('1', 'session.list', {})
    await tick()
    const socketId = transport.frames[0].socketId
    const page = { id: '1', ok: true, result: { sessions: [], cursor: null } }
    const push = { push: 'sessions', sessions: [{ id: 'x' }] }
    expect(relay.onFrames('env_mac', socketId, [push, page])).toEqual({ ok: true })
    expect(ws.sent.slice(1)).toEqual([push, page])
    expect(() => relay.onFrames('env_mac', 'nope', [page])).toThrow('unknown socket nope')
    expect(() => relay.onFrames('env_other', socketId, [page])).toThrow('unknown socket')
  })

  it('a frame the Mac refused to take answers with the error; the link gone mid-way answers linkDown', async () => {
    const { ws, transport, calls, now } = lane()
    await tick()
    transport.frameAnswer = () => Promise.reject(new Error('the Mac did not answer relay.frame within 30 s'))
    ws.request('1', 'session.list', {})
    await tick()
    expect(ws.answers()).toEqual([{ id: '1', ok: false, error: 'the Mac did not answer relay.frame within 30 s' }])
    transport.frameAnswer = async () => {
      now.t = T0 + 120_000
      calls.drop('env_mac')
      throw new PeerOfflineError('env_mac')
    }
    ws.request('2', 'session.list', {})
    await tick()
    // the drop closed the lane and failed the request first; the rejection finds nothing pending
    expect(ws.answers()[1]).toEqual({ id: '2', ok: false, error: 'linkDown: the Mac is unreachable since 09:16' })
    expect(ws.answers()).toHaveLength(2)
    expect(ws.closed).toEqual({ code: 4010, reason: 'host unreachable' })
  })

  it('a link drop fails every pending request with linkDown and closes every lane of that host with 4010', async () => {
    const { ws, calls, relay, now, transport } = lane()
    const other = new FakeWs()
    relay.attachRelayed(other, principal(), 'env_mac')
    await tick()
    ws.request('1', 'session.list', {})
    ws.request('2', 'workspace.list', {})
    other.request('9', 'session.list', {})
    await tick()
    // the drop is now, so `since` is today's clock
    now.t = Date.UTC(2026, 2, 5, 1, 0)
    calls.drop('env_mac')
    expect(ws.answers()).toEqual([
      { id: '1', ok: false, error: 'linkDown: the Mac is unreachable since 01:00' },
      { id: '2', ok: false, error: 'linkDown: the Mac is unreachable since 01:00' }
    ])
    expect(other.answers()).toEqual([{ id: '9', ok: false, error: 'linkDown: the Mac is unreachable since 01:00' }])
    expect(ws.closed).toEqual({ code: 4010, reason: 'host unreachable' })
    expect(other.closed).toEqual({ code: 4010, reason: 'host unreachable' })
    expect(relay.laneCount()).toBe(0)
    // nothing is asked of a host that is gone
    expect(transport.closes).toEqual([])
  })

  it('a lane to a host that is down closes 4010 at once; the Mac closing its end closes 4011; the phone hanging up closes the Mac side', async () => {
    const down = make()
    down.calls.register('env_mac')
    down.calls.drop('env_mac')
    const ws0 = new FakeWs()
    down.relay.attachRelayed(ws0, principal(), 'env_mac')
    expect(ws0.sent[0]).toMatchObject({ push: 'hello', presence: { link: 'down' } })
    expect(ws0.closed).toEqual({ code: 4010, reason: 'host unreachable' })
    expect(down.transport.opens).toEqual([])

    const { ws, transport, relay } = lane()
    await tick()
    const socketId = transport.opens[0].socketId
    expect(relay.onClosed('env_mac', socketId, 'backpressure')).toEqual({ ok: true })
    expect(ws.closed).toEqual({ code: 4011, reason: 'backpressure' })
    expect(transport.closes).toEqual([])

    const second = lane()
    await tick()
    second.ws.hangUp()
    expect(second.transport.closes).toEqual([{ envId: 'env_mac', socketId: second.transport.opens[0].socketId, reason: 'client closed' }])
    expect(second.relay.laneCount()).toBe(0)
  })

  it('a notice from a known host goes to the sinks under its id; an unknown host is ignored', async () => {
    const { relay, delivered } = lane()
    const notice = { event: 'needs_you' as const, threadId: 't1', title: 'T', body: 'B', ts: 5, seq: 9 }
    expect(relay.onNotice('env_mac', notice)).toEqual({ ok: true })
    expect(relay.onNotice('env_nobody', notice)).toEqual({ ok: true })
    await tick()
    expect(delivered).toEqual([{ from: 'env_mac', notice }])
  })
})

describe('HostRelay.facadeHosts', () => {
  const p: RelayPrincipal = { keyId: 'b1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] }

  it('lists the rows and calls the host when it is available', async () => {
    const { relay, calls, transport } = make()
    calls.register('env_mac', { name: 'Studio' })
    const hosts = relay.facadeHosts()
    expect(hosts.list().map((h) => h.name)).toEqual(['Studio'])
    expect(await hosts.call('env_mac', p, 'list_sessions', { limit: 5 })).toEqual({ ok: true, result: { fine: true } })
    expect(transport.facades).toEqual([{ envId: 'env_mac', principal: p, name: 'list_sessions', args: { limit: 5 } }])
  })

  it('applies the refusal first (asleep, unreachable), never for a locked host, and maps a drop mid-call', async () => {
    const { relay, calls, transport, now } = make()
    calls.register('env_mac', { presence: { screen: 'locked', power: 'awake', at: T0 } })
    const hosts = relay.facadeHosts()
    expect(await hosts.call('env_mac', p, 'get_session', { session: 'x' })).toEqual({ ok: true, result: { fine: true } })
    relay.onPeerPresence('env_mac', { screen: 'locked', power: 'asleep', at: T0 })
    expect(await hosts.call('env_mac', p, 'get_session', { session: 'x' })).toEqual({ ok: false, code: 'unavailable', message: 'unavailable: the Mac is asleep' })
    relay.onPeerPresence('env_mac', { screen: 'unlocked', power: 'awake', at: T0 })
    transport.facadeAnswer = () => {
      now.t = T0 + 60_000
      calls.drop('env_mac')
      return Promise.reject(new PeerOfflineError('env_mac'))
    }
    expect(await hosts.call('env_mac', p, 'get_session', { session: 'x' })).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'linkDown: the Mac is unreachable since 09:15'
    })
    expect(await hosts.call('env_mac', p, 'get_session', { session: 'x' })).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'unavailable: the Mac is unreachable since 09:15'
    })
    expect(await hosts.call('env_nobody', p, 'get_session', { session: 'x' })).toMatchObject({ ok: false, code: 'not_found' })
    transport.facadeAnswer = () => Promise.reject(new Error('the Mac did not answer relay.facade within 60 s'))
    calls.register('env_mac')
    expect(await hosts.call('env_mac', p, 'get_session', { session: 'x' })).toEqual({
      ok: false,
      code: 'unavailable',
      message: 'unavailable: the Mac did not answer relay.facade within 60 s'
    })
  })
})
