import { createServer as createHttp, get, type Server as HttpServer } from 'node:http'
import { createServer, connect, type AddressInfo, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import type { ServerFrame } from '@shared/contract'
import { PORT_HIGH_WATER, PORT_WINDOW_FRAMES, forwardedLine, type ForwardedPort } from '@shared/contract-ports'
import { MacPortForwards, allocate, portIsFree } from './macPorts'
import { PortForwardHost } from './portForward'
import { LinkStream } from './portStreams'

const BOX = 'env_box000000000000000000'
const MAC = 'env_mac000000000000000000'

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

const listenOn = (server: Server | HttpServer, port = 0, host = '127.0.0.1'): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve((server.address() as AddressInfo).port))
  })
const tick = () => new Promise((r) => setImmediate(r))
const until = async (ok: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
const fetchText = (port: number, path = '/'): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', reject)
  })

/** A box and a Mac joined by an in-memory link: requests go to the host's methods, pushes to the Mac's. */
function rig(offers: ForwardedPort[]) {
  let linkUp = true
  let buffered = 0
  const host = new PortForwardHost({
    environmentId: BOX,
    offers: () => offers,
    macs: () => (linkUp ? [MAC] : []),
    push: (_env, frame: ServerFrame) => {
      if (!linkUp) return false
      const f = frame as { push: string } & Record<string, unknown>
      setImmediate(() => {
        if (f.push === 'ports') void mac.onPorts(BOX, f.ports as ForwardedPort[])
        if (f.push === 'ports.data') mac.onData(BOX, f.streamId as string, f.seq as number, f.data as string)
        if (f.push === 'ports.close') mac.onClose(BOX, f.streamId as string, f.seq as number, f.error as string | undefined)
      })
      return true
    },
    buffered: () => buffered,
    hostName: () => 'Landon Mac',
    log: () => {}
  })
  let enabled = true
  const mac = new MacPortForwards({
    environmentId: MAC,
    link: () =>
      linkUp
        ? {
            buffered: () => buffered,
            request: async (method, params) => {
              await tick()
              const p = params as Record<string, never>
              switch (method) {
                case 'ports.bound':
                  return host.bound(MAC, p.bound)
                case 'ports.open':
                  return host.open(MAC, p.streamId, p.forwardId)
                case 'ports.data':
                  return host.data(MAC, p.streamId, p.seq, p.data)
                case 'ports.close':
                  return host.close(MAC, p.streamId, p.seq, p.error)
              }
              throw new Error(`unknown ${method}`)
            }
          }
        : null,
    hosts: () => [{ id: BOX, name: 'box', connected: linkUp }],
    enabled: () => enabled,
    setEnabled: (_id, on) => (enabled = on),
    log: () => {}
  })
  cleanups.push(() => {
    mac.shutdown()
    host.shutdown()
  })
  return {
    host,
    mac,
    setBuffered: (n: number) => (buffered = n),
    drop: () => {
      linkUp = false
      host.macDropped(MAC)
      mac.linkDown(BOX)
    },
    up: () => {
      linkUp = true
      host.macRegistered(MAC)
    }
  }
}

/** An http server that also echoes over websocket: the dev server stand-in. */
async function devServer(): Promise<number> {
  const http = createHttp((req, res) => res.end(`hello from ${req.url}`))
  const wss = new WebSocketServer({ server: http })
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo ${m}`)))
  const port = await listenOn(http)
  cleanups.push(() => new Promise<void>((r) => (wss.close(), http.close(() => r()), http.closeAllConnections())))
  return port
}

const macPortOf = (mac: MacPortForwards, id: string) => mac.hosts()[0]?.forwards.find((f) => f.id === id)?.macPort ?? null

describe('allocation of the Mac number', () => {
  it('takes the wanted number when free, else the next free one, skipping its own forwards', async () => {
    const holder = createServer()
    const busy = await listenOn(holder)
    cleanups.push(() => holder.close())
    const a = createServer()
    cleanups.push(() => a.close())
    expect(await allocate(a, busy, { taken: new Set(), isFree: portIsFree })).toBe(busy + 1)
    const b = createServer()
    cleanups.push(() => b.close())
    expect(await allocate(b, busy, { taken: new Set([busy + 1]), isFree: portIsFree })).toBe(busy + 2)
  })

  it('prefers the number it had before a reconnect', async () => {
    const s = createServer()
    cleanups.push(() => s.close())
    const free = await allocate(s, 40_000, { prefer: 40_010, taken: new Set(), isFree: async (p) => p !== 40_000 })
    expect(free).toBe(40_010)
  })

  it('reads a port something answers on over v6 as taken', async () => {
    expect(await allocate(createServer(), 40_100, { taken: new Set(), isFree: async (p) => p > 40_102 })).toBe(40_103)
  })
})

describe('the forward', () => {
  it('serves a GET and a websocket echo through the Mac number, which says it moved', async () => {
    const port = await devServer()
    const offer: ForwardedPort = { id: 'r1', port, label: `http://localhost:${port}`, title: 'Box thread', sessionId: 's1', runId: null }
    const { host, mac } = rig([offer])
    host.macRegistered(MAC)
    await until(() => host.forwardsOf('r1').length === 1)
    const [fwd] = host.forwardsOf('r1')
    // The box and the Mac share this machine in the test: the dev server holds the number, so the forward moves up.
    expect(fwd).toMatchObject({ environmentId: MAC, hostName: 'Landon Mac', macPort: port + 1, error: null })
    expect(forwardedLine(port, [fwd])).toBe(`Forwarded to http://localhost:${port + 1} on the Mac (${port} is taken there)`)

    expect(await fetchText(port + 1, '/a?b=1')).toEqual({ status: 200, body: 'hello from /a?b=1' })

    const ws = new WebSocket(`ws://127.0.0.1:${port + 1}/hmr`)
    const reply = await new Promise<string>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'))
      ws.on('message', (m) => resolve(String(m)))
      ws.on('error', reject)
    })
    expect(reply).toBe('echo ping')
    expect(mac.hosts()[0].forwards[0].connections).toBeGreaterThan(0)
    ws.close()
    await until(() => host.streamCount() === 0)
  })

  it('carries a large body whole', async () => {
    const big = 'x'.repeat(3 * 1024 * 1024 + 7)
    const http = createHttp((_req, res) => res.end(big))
    const port = await listenOn(http)
    cleanups.push(() => new Promise<void>((r) => (http.close(() => r()), http.closeAllConnections())))
    const { host, mac } = rig([{ id: 'big', port, label: '', title: '', sessionId: null, runId: null }])
    host.macRegistered(MAC)
    await until(() => macPortOf(mac, 'big') !== null)
    const got = await fetchText(macPortOf(mac, 'big') as number)
    expect(got.body.length).toBe(big.length)
  })

  it('closes every forward when the switch goes off and binds again when it is back on', async () => {
    const port = await devServer()
    const { host, mac } = rig([{ id: 'r1', port, label: '', title: '', sessionId: null, runId: null }])
    host.macRegistered(MAC)
    await until(() => macPortOf(mac, 'r1') !== null)
    const macPort = macPortOf(mac, 'r1') as number
    const hosts = await mac.setEnabled(BOX, false)
    expect(hosts[0]).toMatchObject({ enabled: false, forwards: [] })
    await until(() => host.forwardsOf('r1').length === 0)
    await expect(fetchText(macPort)).rejects.toThrow()
    await mac.setEnabled(BOX, true)
    await until(() => macPortOf(mac, 'r1') === macPort)
    expect((await fetchText(macPort)).status).toBe(200)
  })

  it('tears the forward down when the link drops and brings it back on the same number', async () => {
    const port = await devServer()
    const r = rig([{ id: 'r1', port, label: '', title: '', sessionId: null, runId: null }])
    r.host.macRegistered(MAC)
    await until(() => macPortOf(r.mac, 'r1') !== null)
    const macPort = macPortOf(r.mac, 'r1') as number
    r.drop()
    await until(() => r.mac.hosts()[0].forwards.length === 0)
    await expect(fetchText(macPort)).rejects.toThrow()
    r.up()
    await until(() => macPortOf(r.mac, 'r1') === macPort)
    expect((await fetchText(macPort)).body).toBe('hello from /')
  })

  it('closes the listener of a port the host no longer offers', async () => {
    const port = await devServer()
    const offers: ForwardedPort[] = [{ id: 'r1', port, label: '', title: '', sessionId: null, runId: null }]
    const r = rig(offers)
    r.host.macRegistered(MAC)
    await until(() => macPortOf(r.mac, 'r1') !== null)
    const macPort = macPortOf(r.mac, 'r1') as number
    offers.length = 0
    r.host.refresh()
    await until(() => r.mac.hosts()[0].forwards.length === 0)
    await expect(fetchText(macPort)).rejects.toThrow()
  })
})

describe('LinkStream', () => {
  const pair = async (): Promise<[Socket, Socket]> => {
    const server = createServer({ allowHalfOpen: true })
    const port = await listenOn(server)
    const inner = new Promise<Socket>((r) => server.once('connection', r))
    const outer = connect({ port, host: '127.0.0.1', allowHalfOpen: true })
    const a = await inner
    cleanups.push(() => (a.destroy(), outer.destroy(), server.close()))
    return [a, outer]
  }

  it('writes frames in seq order whatever order they arrive in, then ends after the counted ones', async () => {
    const [local, far] = await pair()
    const stream = new LinkStream('s', local, { data: () => {}, close: () => {}, buffered: () => 0 })
    stream.pump()
    let got = ''
    far.on('data', (b) => (got += b))
    const ended = new Promise((r) => far.once('end', r))
    const b64 = (s: string) => Buffer.from(s).toString('base64')
    stream.remoteClose(3)
    stream.deliver(2, b64('c'))
    stream.deliver(0, b64('a'))
    stream.deliver(0, b64('dup'))
    stream.deliver(1, b64('b'))
    await ended
    expect(got).toBe('abc')
  })

  it('pauses the socket while the link is full and resumes when it drains', async () => {
    const [local, far] = await pair()
    let buffered = 0
    const frames: number[] = []
    const stream = new LinkStream('s', local, { data: (seq) => void frames.push(seq), close: () => {}, buffered: () => buffered })
    stream.pump()
    buffered = PORT_HIGH_WATER + 1
    far.write('one')
    await until(() => frames.length === 1)
    expect(stream.isPaused).toBe(true)
    far.write('two')
    await new Promise((r) => setTimeout(r, 60))
    expect(frames).toEqual([0])
    buffered = 0
    await until(() => frames.length === 2)
    expect(stream.isPaused).toBe(false)
  })

  it('pauses while too many acked sends are out', async () => {
    const [local, far] = await pair()
    const acks: (() => void)[] = []
    const stream = new LinkStream('s', local, {
      data: () => new Promise<void>((r) => acks.push(r)),
      close: () => {},
      buffered: () => 0
    })
    stream.pump()
    for (let i = 0; i < PORT_WINDOW_FRAMES; i++) {
      far.write(`f${i}`)
      await until(() => acks.length === i + 1)
    }
    expect(stream.isPaused).toBe(true)
    for (const a of acks.splice(0)) a()
    await until(() => !stream.isPaused)
  })

  it('tells the other side the count when the local socket ends, and the reason when it breaks', async () => {
    const [local, far] = await pair()
    const closes: [number, string | undefined][] = []
    const stream = new LinkStream('s', local, { data: () => {}, close: (seq, err) => void closes.push([seq, err]), buffered: () => 0 })
    stream.pump()
    far.write('x')
    far.end()
    await until(() => closes.length === 1)
    expect(closes[0]).toEqual([1, undefined])
    far.destroy()
    stream.finish('boom', true)
    expect(closes[1]).toEqual([1, 'boom'])
  })
})
