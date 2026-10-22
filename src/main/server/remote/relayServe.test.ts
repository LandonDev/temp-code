import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Principal } from '@shared/capabilities'
import type { MacBridgePush } from '@shared/contract-macbridge'
import { CONTRACT_VERSION } from '@shared/capabilities'
import type { RelayCallParams } from '@shared/contract-relay'
import { MacPresenceWatcher } from '../../presence'
import type { FacadeContext } from './facade'
import { RelaySocket, RelayServer, relayOffers } from './relayServe'

type Call = Extract<MacBridgePush, { push: 'peer.call' }>
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

describe('RelaySocket', () => {
  function make(opts: { flush?: (frames: string[]) => Promise<void>; frameBytes?: number; maxBytes?: number; retryMs?: number } = {}) {
    const flushed: string[][] = []
    const overflow = vi.fn()
    const socket = new RelaySocket(
      's1',
      opts.flush ??
        (async (frames) => {
          flushed.push(frames)
        }),
      overflow,
      { frameBytes: opts.frameBytes, maxBytes: opts.maxBytes, retryMs: opts.retryMs ?? 0 }
    )
    return { socket, flushed, overflow }
  }

  it('looks open to attach(), swallows the hello and flushes the rest in order, one request in flight', async () => {
    const { socket, flushed } = make()
    expect(socket.readyState).toBe(socket.OPEN)
    socket.send(JSON.stringify({ push: 'hello', environmentId: 'env_mac', contract: 1, caps: [] }))
    expect(socket.bufferedAmount).toBe(0)
    const a = JSON.stringify({ id: '1', ok: true, result: null })
    const b = JSON.stringify({ push: 'sessions', sessions: [] })
    socket.send(a)
    socket.send(b)
    // the first frame went alone (nothing was queued when it arrived); b waits for its answer
    expect(flushed).toEqual([[a]])
    expect(socket.bufferedAmount).toBe(Buffer.byteLength(a) + Buffer.byteLength(b))
    await tick()
    expect(flushed).toEqual([[a], [b]])
    await tick()
    expect(socket.bufferedAmount).toBe(0)
  })

  it('keeps a first frame that is not a hello', async () => {
    const { socket, flushed } = make()
    socket.send('{"id":"1","ok":true,"result":1}')
    await tick()
    expect(flushed).toEqual([['{"id":"1","ok":true,"result":1}']])
  })

  it('batches queued frames under the byte limit; a single larger frame goes alone', async () => {
    let release: () => void = () => {}
    const flushed: string[][] = []
    const socket = new RelaySocket(
      's1',
      (frames) => {
        flushed.push(frames)
        return new Promise<void>((r) => (release = r))
      },
      () => {},
      { frameBytes: 25, retryMs: 0 }
    )
    socket.send('{"push":"hello"}')
    socket.send('a'.repeat(10)) // goes out alone, in flight
    socket.send('b'.repeat(10))
    socket.send('c'.repeat(10))
    socket.send('d'.repeat(10)) // b, c and d would be 30 bytes, past the 25 limit: d waits
    socket.send('e'.repeat(50)) // bigger than the limit: alone
    socket.send('f')
    expect(flushed.length).toBe(1)
    release()
    await tick()
    expect(flushed[1]).toEqual(['b'.repeat(10), 'c'.repeat(10)])
    release()
    await tick()
    expect(flushed[2]).toEqual(['d'.repeat(10)])
    release()
    await tick()
    expect(flushed[3]).toEqual(['e'.repeat(50)])
    release()
    await tick()
    expect(flushed[4]).toEqual(['f'])
  })

  it('closes itself past the buffer cap and tells the overflow hook', () => {
    const { socket, overflow } = make({ flush: () => new Promise(() => {}), maxBytes: 20 })
    const closed = vi.fn()
    socket.on('close', closed)
    socket.send('{"push":"hello"}')
    socket.send('x'.repeat(15))
    expect(overflow).not.toHaveBeenCalled()
    socket.send('y'.repeat(10))
    expect(overflow).toHaveBeenCalledTimes(1)
    expect(socket.readyState).toBe(3)
    expect(closed).toHaveBeenCalledTimes(1)
    expect(socket.bufferedAmount).toBe(0)
  })

  it('receive emits message with the frame text; close emits close once and drops later sends', () => {
    const { socket, flushed } = make()
    const got: string[] = []
    socket.on('message', (data: Buffer | string) => got.push(String(data)))
    socket.receive({ id: '7', method: 'session.list', params: {} })
    expect(got).toEqual(['{"id":"7","method":"session.list","params":{}}'])
    const closed = vi.fn()
    socket.on('close', closed)
    socket.close('client closed')
    socket.close('again')
    expect(closed).toHaveBeenCalledTimes(1)
    expect(closed.mock.calls[0][1].toString()).toBe('client closed')
    socket.send('{"id":"8","ok":true,"result":null}')
    socket.receive({ id: '9' })
    expect(flushed).toEqual([])
    expect(got.length).toBe(1)
  })

  it('an unknown-socket refusal closes the lane as carrier closed; another failure retries once, then closes', async () => {
    const unknown = make({ flush: async () => Promise.reject(new Error('unknown socket s1')) })
    const closedA = vi.fn()
    unknown.socket.on('close', closedA)
    unknown.socket.send('{"push":"hello"}')
    unknown.socket.send('{"id":"1","ok":true,"result":1}')
    await tick()
    expect(closedA).toHaveBeenCalledTimes(1)
    expect(closedA.mock.calls[0][1].toString()).toBe('carrier closed')

    let attempts = 0
    const flaky = make({
      flush: async (frames) => {
        attempts++
        if (attempts === 1) throw new Error('the Mac did not answer relay.frames within 30 s')
        expect(frames).toEqual(['{"id":"1","ok":true,"result":1}'])
      }
    })
    flaky.socket.send('{"push":"hello"}')
    flaky.socket.send('{"id":"1","ok":true,"result":1}')
    await tick()
    await tick()
    await tick()
    expect(attempts).toBe(2)
    expect(flaky.socket.readyState).toBe(1)

    const dead = make({ flush: async () => Promise.reject(new Error('timeout')) })
    const closedC = vi.fn()
    dead.socket.on('close', closedC)
    dead.socket.send('{"push":"hello"}')
    dead.socket.send('{"id":"1","ok":true,"result":1}')
    await tick()
    await tick()
    await tick()
    expect(closedC).toHaveBeenCalledTimes(1)
    expect(closedC.mock.calls[0][1].toString()).toBe('carrier failed')
  })
})

describe('RelayServer', () => {
  function make(opts: { deliversNotices?: boolean; heartbeatMs?: number; links?: string[] } = {}) {
    const presence = new MacPresenceWatcher({ initial: { screen: 'unlocked' }, now: () => 500 })
    const requests: { to: string; method: string; params: unknown }[] = []
    const answers = new Map<string, (params: unknown) => unknown>()
    const attached: { socket: RelaySocket; principal: Principal & { kind: 'remote' } }[] = []
    const up = new Set(opts.links ?? ['env_box'])
    const registry = {
      listProjects: () => [],
      listWorkspaces: () => [{ id: 'w1', name: 'repo', path: '/tmp/repo', githubRepo: null }]
    }
    const server = new RelayServer({
      environmentId: 'env_mac',
      attach: (socket, principal) => {
        attached.push({ socket, principal })
        // what attach() does first: its own hello
        socket.send(JSON.stringify({ push: 'hello', environmentId: 'env_mac', contract: CONTRACT_VERSION, caps: principal.caps }))
        socket.on('message', (data: Buffer | string) => {
          const req = JSON.parse(String(data)) as { id: string; method: string }
          socket.send(JSON.stringify({ id: req.id, ok: true, result: `answered ${req.method} as ${principal.name}` }))
        })
      },
      link: (envId) =>
        up.has(envId)
          ? async (method, params) => {
              requests.push({ to: envId, method, params })
              const answer = answers.get(method)
              if (answer) return answer(params)
              return { ok: true }
            }
          : null,
      environments: () => [{ id: 'env_box', name: 'The box' }, { id: 'env_other', name: 'Other' }],
      presence,
      facade: () => ({ registry: registry as unknown as FacadeContext['registry'], origin: null }),
      deliversNotices: () => opts.deliversNotices ?? false,
      build: { release: 300, version: '1.0.300', sha: 'abc', platform: 'darwin' },
      hostname: 'Studio',
      heartbeatMs: opts.heartbeatMs,
      retryMs: 0,
      log: () => {}
    })
    const principal = { keyId: 'k1', name: 'Phone', audience: 'client' as const, caps: ['read', 'operate'] as ('read' | 'operate')[] }
    const call = (method: Call['method'], args: unknown, from = 'env_box'): Promise<unknown> =>
      server.handle(method as never, { from, args } as RelayCallParams, { from })
    return { server, presence, requests, answers, attached, up, call, principal }
  }

  it('registration names the host, its build and its presence; the offer is relay', () => {
    const { server } = make()
    expect(server.registration()).toEqual({
      name: 'Studio',
      presence: { screen: 'unlocked', power: 'awake', at: 500 },
      build: { release: 300, version: '1.0.300', sha: 'abc', platform: 'darwin' }
    })
    expect(relayOffers()).toEqual(['relay'])
  })

  it('relay.open attaches a lane under the box key with a via name and answers the contract; a second open of the id is refused', async () => {
    const { server, call, attached, principal, requests } = make()
    expect(await call('relay.open', { socketId: 's1', principal })).toEqual({ ok: true, contract: CONTRACT_VERSION })
    expect(attached).toHaveLength(1)
    expect(attached[0].principal).toEqual({ kind: 'remote', keyId: 'k1', name: 'Phone via The box', audience: 'client', caps: ['read', 'operate'] })
    // attach()'s hello was swallowed: nothing went back yet
    await tick()
    expect(requests.filter((r) => r.method === 'relay.frames')).toEqual([])
    await expect(call('relay.open', { socketId: 's1', principal })).rejects.toThrow('socket s1 is already open')
    expect(server.laneCount()).toBe(1)
  })

  it('relay.frame hands the frame to attach() and the answer comes back as relay.frames; a missing socket is refused', async () => {
    const { call, principal, requests } = make()
    await call('relay.open', { socketId: 's1', principal })
    expect(await call('relay.frame', { socketId: 's1', frame: { id: '1', method: 'session.list', params: {} } })).toEqual({ ok: true })
    await tick()
    const frames = requests.filter((r) => r.method === 'relay.frames')
    expect(frames).toEqual([
      { to: 'env_box', method: 'relay.frames', params: { from: 'env_mac', socketId: 's1', frames: [{ id: '1', ok: true, result: 'answered session.list as Phone via The box' }] } }
    ])
    await expect(call('relay.frame', { socketId: 'nope', frame: {} })).rejects.toThrow('unknown socket nope')
  })

  it('relay.close closes the lane once (attach() hears close) and forgets it', async () => {
    const { server, call, principal, attached } = make()
    await call('relay.open', { socketId: 's1', principal })
    const closed = vi.fn()
    attached[0].socket.on('close', closed)
    expect(await call('relay.close', { socketId: 's1', reason: 'client closed' })).toEqual({ ok: true })
    expect(closed).toHaveBeenCalledTimes(1)
    expect(server.laneCount()).toBe(0)
    expect(await call('relay.close', { socketId: 's1', reason: 'again' })).toEqual({ ok: true })
    // the lane's id is free again
    expect(await call('relay.open', { socketId: 's1', principal })).toEqual({ ok: true, contract: CONTRACT_VERSION })
  })

  it('an overflow on a lane tells the box relay.closed backpressure', async () => {
    const { call, principal, attached, requests } = make()
    await call('relay.open', { socketId: 's1', principal })
    const socket = attached[0].socket as unknown as { opts: { maxBytes?: number } }
    socket.opts.maxBytes = 10
    attached[0].socket.send('x'.repeat(20))
    await tick()
    expect(requests.filter((r) => r.method === 'relay.closed')).toEqual([
      { to: 'env_box', method: 'relay.closed', params: { from: 'env_mac', socketId: 's1', reason: 'backpressure' } }
    ])
  })

  it('refuses a call from an unknown host or one that names another carrier', async () => {
    const { call, principal } = make()
    await expect(call('relay.open', { socketId: 's1', principal }, 'env_stranger')).rejects.toThrow('does not know that host')
    const { server } = make()
    await expect(server.handle('relay.open', { from: 'env_other', args: { socketId: 's1', principal } }, { from: 'env_box' })).rejects.toThrow('another host as its carrier')
  })

  it('linkDown closes the host of that link lanes only', async () => {
    const { server, call, principal, attached, up } = make({ links: ['env_box', 'env_other'] })
    await call('relay.open', { socketId: 's1', principal })
    await call('relay.open', { socketId: 's1', principal }, 'env_other')
    const closed = attached.map(() => vi.fn())
    attached.forEach((a, i) => a.socket.on('close', closed[i]))
    up.delete('env_box')
    server.linkDown('env_box')
    expect(closed[0]).toHaveBeenCalledTimes(1)
    expect(closed[0].mock.calls[0][1].toString()).toBe('link down')
    expect(closed[1]).not.toHaveBeenCalled()
    expect(server.laneCount()).toBe(1)
  })

  it('publishes presence on change and every heartbeat to each link that is up', async () => {
    vi.useFakeTimers()
    const { server, presence, requests } = make({ heartbeatMs: 1_000, links: ['env_box', 'env_other'] })
    server.linkUp('env_box')
    const presenceFrames = (): { to: string; params: unknown }[] => requests.filter((r) => r.method === 'peer.presence').map(({ to, params }) => ({ to, params }))
    expect(presenceFrames()).toEqual([])
    presence.set({ screen: 'locked' })
    await vi.advanceTimersByTimeAsync(0)
    expect(presenceFrames()).toEqual([{ to: 'env_box', params: { from: 'env_mac', presence: { screen: 'locked', power: 'awake', at: 500 } } }])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(presenceFrames()).toHaveLength(2)
    server.linkUp('env_other')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(presenceFrames().map((f) => f.to).sort()).toEqual(['env_box', 'env_box', 'env_box', 'env_other'])
    server.linkDown('env_other')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(presenceFrames().filter((f) => f.to === 'env_other')).toHaveLength(1)
    server.close()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(presenceFrames()).toHaveLength(5)
  })

  it('relay.facade runs the tool as the box key and maps FacadeError and ZodError', async () => {
    const { call, principal } = make()
    expect(await call('relay.facade', { principal, name: 'list_projects', arguments: {} })).toEqual({
      ok: true,
      result: { repos: [{ id: 'w1', name: 'repo', path: '/tmp/repo', github: null, projects: [] }] }
    })
    expect(await call('relay.facade', { principal, name: 'no_such_tool', arguments: {} })).toEqual({ ok: false, code: 'not_found', message: 'unknown tool "no_such_tool"' })
    expect(await call('relay.facade', { principal: { ...principal, caps: ['read'] }, name: 'stop_session', arguments: { session: 'x' } })).toMatchObject({ ok: false, code: 'forbidden' })
    const invalid = (await call('relay.facade', { principal, name: 'list_sessions', arguments: { limit: 'many' } })) as { ok: false; code: string; message: string }
    expect(invalid.ok).toBe(false)
    expect(invalid.code).toBe('invalid')
    expect(invalid.message).toMatch(/^invalid arguments: limit: /)
  })

  it('a notice goes to every link as relay.notice only when the host delivers nothing itself', async () => {
    const own = make({ deliversNotices: true, links: ['env_box'] })
    own.server.linkUp('env_box')
    const notice = { event: 'needs_you' as const, kind: 'approval' as const, threadId: 't1', title: 'T', subtitle: 'proj', body: 'B', url: 'http://x', ts: 5, seq: 9, requestId: 'r1', hostName: 'Studio' }
    own.server.onNotice(notice)
    await tick()
    expect(own.requests.filter((r) => r.method === 'relay.notice')).toEqual([])

    const relayed = make({ links: ['env_box', 'env_other'] })
    relayed.server.linkUp('env_box')
    relayed.server.linkUp('env_other')
    relayed.server.onNotice(notice)
    await tick()
    const sent = relayed.requests.filter((r) => r.method === 'relay.notice')
    expect(sent.map((r) => r.to).sort()).toEqual(['env_box', 'env_other'])
    // url stays home: the box's /ui cannot open a Mac thread
    expect(sent[0].params).toEqual({
      from: 'env_mac',
      notice: { event: 'needs_you', kind: 'approval', threadId: 't1', title: 'T', subtitle: 'proj', body: 'B', ts: 5, seq: 9, requestId: 'r1', hostName: 'Studio' }
    })
  })

  it('onPeerPush serves relay.* pushes and leaves every other push alone', async () => {
    const { server, principal, requests } = make()
    expect(server.onPeerPush('env_box', { push: 'sessions', sessions: [] })).toBe(false)
    expect(server.onPeerPush('env_box', { push: 'peer.call', callId: 'c1', method: 'mac.readFile', params: { thread: { id: 't' }, args: {} }, deadlineMs: 1000 } as Call)).toBe(false)
    expect(
      server.onPeerPush('env_box', { push: 'peer.call', callId: 'c2', method: 'relay.open', params: { from: 'env_box', args: { socketId: 's9', principal } }, deadlineMs: 1000 } as Call)
    ).toBe(true)
    await tick()
    await tick()
    expect(requests.find((r) => r.method === 'peer.reply')).toEqual({ to: 'env_box', method: 'peer.reply', params: { callId: 'c2', ok: true, result: { ok: true, contract: CONTRACT_VERSION } } })
    expect(server.laneCount()).toBe(1)
  })
})
