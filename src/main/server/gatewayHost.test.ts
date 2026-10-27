import { createServer, type Server } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { MessageChannel, type MessagePort } from 'node:worker_threads'
import type { ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Credential, ServiceId } from 'aliax-core'
import { holdStdin } from './drivers/claudeWarm'
import type { ControlPlane, ResponseInfo, ScopedRequest } from './gatewayCore'
import { PortControl, runGatewayChild } from './gatewayChild'
import { GatewayHost, type GatewayChildLink } from './gatewayHost'
import type { AccountsState, MainCall, OutMark, Wire, WireMessage } from './gatewayWire'
import { makeCertificate, readTlsDir, type TlsMaterial } from './tls'

/** A Node MessagePort as a Wire: the message arrives as itself (Electron's carries `{ data }`). */
function nodeWire(port: MessagePort): Wire {
  return {
    post: (m) => port.postMessage(m),
    onMessage: (fn) => void port.on('message', fn),
    onClose: (fn) => void port.on('close', fn),
    close: () => port.close()
  }
}

/** The real child logic in this process over a MessageChannel; `kill` stops its sockets as a dying process would. */
function realChildren(chromiumFetch: (input: string, init?: RequestInit) => Promise<Response> = globalThis.fetch) {
  const live: { kill: () => void }[] = []
  const spawn = (): GatewayChildLink => {
    const { port1, port2 } = new MessageChannel()
    const exits: ((code: number | null) => void)[] = []
    let dead = false
    let child: { stop: () => Promise<void> } | null = null
    const die = (code: number | null): void => {
      if (dead) return
      dead = true
      void child?.stop().then(() => {
        port1.close()
        for (const fn of exits) fn(code)
      })
    }
    child = runGatewayChild(nodeWire(port2), { chromiumFetch, exit: () => die(0), watchMainMs: 0 })
    const handle = { kill: () => die(null) }
    live.push(handle)
    return { wire: nodeWire(port1), kill: handle.kill, onExit: (fn) => void exits.push(fn) }
  }
  return { spawn, live }
}

/** A child that never says it is ready and exits soon after it starts. */
function dyingChild(): GatewayChildLink {
  const { port1 } = new MessageChannel()
  const exits: ((code: number | null) => void)[] = []
  setTimeout(() => exits.forEach((fn) => fn(1)), 5)
  return { wire: nodeWire(port1), kill: () => {}, onExit: (fn) => void exits.push(fn) }
}

/** The host's side in a test: accounts A and B on Claude, A pinned, everything asked recorded. */
function testControl(out: { marks: OutMark[] }) {
  const asked: string[] = []
  const responses: ResponseInfo[] = []
  const substitutes: ScopedRequest[] = []
  const unauthorized: ScopedRequest[] = []
  let next: string | null = null
  const control: ControlPlane = {
    credentialFor: async (service, account): Promise<Credential | null> => {
      asked.push(`${service}:${account ?? '(pinned)'}`)
      return { authorization: `Bearer TOK-${account ?? 'A'}`, expiresAt: Date.now() + 3_600_000 }
    },
    profilesKnown: async (serviceId: ServiceId) => (serviceId === 'claude-code' ? ['A', 'B'] : ['C']),
    pinned: async (serviceId: ServiceId) => (serviceId === 'claude-code' ? 'A' : 'C'),
    usageReport: async () => undefined,
    usage: async () => [],
    substitute: async (info) => {
      substitutes.push(info)
      return out.marks.some((m) => m.name === info.account) ? 'A' : null
    },
    onUnauthorized: async (info) => {
      unauthorized.push(info)
      return next
    },
    observeLimit: () => {},
    pin: async () => {},
    onResponse: (info) => responses.push(info),
    onRouted: () => {},
    onFailedOver: () => {},
    onError: () => {}
  }
  return { control, asked, responses, substitutes, unauthorized, replayUnder: (name: string | null) => (next = name) }
}

/** The fake Anthropic (and chatgpt.com, through the same rewrite): answers by bearer, refuses the ones in `dead` with 401. */
let upstream: Server
let upstreamOrigin = ''
const seen: { path: string; auth: string }[] = []
const dead = new Set<string>()
let slow: { started: () => void } | null = null

let home = ''
let tls: TlsMaterial
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const auth = req.headers.authorization ?? ''
    seen.push({ path: req.url ?? '', auth })
    req.resume()
    if (dead.has(auth)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":{"type":"authentication_error"}}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'anthropic-ratelimit-unified-status': 'allowed', 'x-upstream-only': 'yes' })
    if (slow) {
      // A stream that stays open until the test cuts it.
      res.write('data: {"n":1}\n\n')
      slow.started()
      return
    }
    res.end('data: {"n":1}\n\ndata: {"n":2}\n\n')
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamOrigin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`
  home = mkdtempSync(join(tmpdir(), 'temp-code-gateway-host-'))
  await makeCertificate(join(home, 'tls'), 'Test CA')
  tls = readTlsDir(join(home, 'tls'), 'app')!
}, 30_000)
afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise((r) => upstream.close(r))
  rmSync(home, { recursive: true, force: true })
})

let hosts: GatewayHost[] = []
afterEach(async () => {
  for (const h of hosts) await h.stop()
  hosts = []
  seen.length = 0
  dead.clear()
  slow = null
})

const seams = (): { trace: boolean; fakeProviders: string | null; role: null } => ({ trace: false, fakeProviders: upstreamOrigin, role: null })

async function startHost(options: Partial<ConstructorParameters<typeof GatewayHost>[0]>): Promise<GatewayHost> {
  const host = new GatewayHost({ claimShim: false, tls: null, seams: seams(), ...options })
  hosts.push(host)
  await host.start()
  return host
}

const post = (url: string): Promise<Response> => fetch(url, { method: 'POST', headers: { authorization: 'Bearer CLI' }, body: '{"model":"claude-opus-5-5"}' })

describe('GatewayHost with its own process', () => {
  it('asks a credential once and keeps it, reads the accounts locally, and reports each answer with its limit headers', async () => {
    const out = { marks: [] as OutMark[] }
    const t = testControl(out)
    const children = realChildren()
    const host = await startHost({ control: t.control, spawnChild: children.spawn, outMarks: () => out.marks })
    expect(host.status().process.mode).toBe('child')
    const base = host.url('claude')!
    for (let i = 0; i < 2; i++) {
      const res = await post(`${base}/~t=T1;a=B/v1/messages`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('data: {"n":1}\n\ndata: {"n":2}\n\n')
    }
    // An unscoped request spends the pin the host pushed.
    expect((await post(`${base}/v1/messages`)).status).toBe(200)
    expect(seen.map((s) => s.auth)).toEqual(['Bearer TOK-B', 'Bearer TOK-B', 'Bearer TOK-A'])
    expect(t.asked).toEqual(['claude:B', 'claude:(pinned)'])
    // B is not out: the child never asked about a substitute.
    expect(t.substitutes).toEqual([])
    await vi.waitFor(() => expect(t.responses).toHaveLength(3))
    expect(t.responses.map((r) => [r.account, r.status, r.headers.get('anthropic-ratelimit-unified-status'), r.headers.get('x-upstream-only')])).toEqual([
      ['B', 200, 'allowed', null],
      ['B', 200, 'allowed', null],
      ['A', 200, 'allowed', null]
    ])
    await vi.waitFor(() => expect(host.status().routed).toEqual({ claude: 3 }))
  })

  it('asks about an account only once main marks it out, and a 401 makes the child ask for the credential again', async () => {
    const out = { marks: [] as OutMark[] }
    const t = testControl(out)
    const host = await startHost({ control: t.control, spawnChild: realChildren().spawn, outMarks: () => out.marks })
    const base = host.url('claude')!
    // B goes out: the push reaches the child, which now asks and spends from A.
    out.marks = [{ serviceId: 'claude-code', name: 'B', until: null }]
    host.accountsChanged()
    await vi.waitFor(async () => {
      seen.length = 0
      expect((await post(`${base}/~t=T2;a=B/v1/messages`)).status).toBe(200)
      expect(seen.at(-1)?.auth).toBe('Bearer TOK-A')
    })
    expect(t.substitutes.at(-1)).toMatchObject({ thread: 'T2', account: 'B', model: 'claude-opus-5-5' })
    // A's token dies: the 401 passes through (nobody to replay under) and the child forgets what it held.
    dead.add('Bearer TOK-A')
    const asksBefore = t.asked.filter((a) => a === 'claude:A').length
    expect((await post(`${base}/~t=T3;a=A/v1/messages`)).status).toBe(401)
    expect(t.unauthorized.at(-1)).toMatchObject({ thread: 'T3', account: 'A' })
    dead.clear()
    expect((await post(`${base}/~t=T3;a=A/v1/messages`)).status).toBe(200)
    expect(t.asked.filter((a) => a === 'claude:A').length).toBe(asksBefore + 1)
  })

  it("an adopted warm process's requests carry the thread's scope once the child acknowledged", async () => {
    const t = testControl({ marks: [] })
    const host = await startHost({ control: t.control, spawnChild: realChildren().spawn })
    const url = host.warmClaudeUrl('w1')!
    expect(url).toBe(`${host.url('claude')}/~w=w1`)
    expect((await post(`${url}/v1/messages`)).status).toBe(200)
    await host.adoptWarm('w1', { thread: 'T9', account: 'B', pin: false })
    expect((await post(`${url}/v1/messages`)).status).toBe(200)
    expect(seen.map((s) => s.auth)).toEqual(['Bearer TOK-A', 'Bearer TOK-B'])
    expect(host.warmIds()).toEqual([{ id: 'w1', thread: 'T9' }])
  })

  it('respawns a dead child on the same ports, with its codex ports and warm map, and cuts the stream in flight', async () => {
    const t = testControl({ marks: [] })
    const children = realChildren()
    const host = await startHost({ control: t.control, spawnChild: children.spawn, tls })
    const port = host.status().port
    const codex = await host.scopedCodexUrl('ct', { thread: 'ct', account: 'C', pin: false })
    const codexPort = Number(new URL(codex!).port)
    host.warmClaudeUrl('w2')
    await host.adoptWarm('w2', { thread: 'T5', account: 'B', pin: true })

    // A stream is open when the child dies.
    let started!: () => void
    const streaming = new Promise<void>((r) => (started = r))
    slow = { started }
    const cut = fetch(`${host.url('claude')}/~t=T4;a=A/v1/messages`, { method: 'POST', body: '{}' }).then((r) => r.text())
    await streaming
    children.live[0].kill()
    await expect(cut).rejects.toThrow()
    slow = null

    await vi.waitFor(() => expect(host.status().process.restarts).toBe(1))
    await vi.waitFor(async () => expect((await post(`${host.url('claude')}/~t=T4;a=A/v1/messages`)).status).toBe(200))
    expect(host.status().port).toBe(port)
    expect(host.status().scopedPorts).toEqual({ ct: codexPort })
    // The warm id still rebinds to its thread, and the codex port still answers under its scope.
    seen.length = 0
    expect((await post(`${host.url('claude')}/~w=w2/v1/messages`)).status).toBe(200)
    expect(seen[0].auth).toBe('Bearer TOK-B')
    const status = await new Promise<number>((ok, bad) => {
      const req = httpsRequest({ host: '127.0.0.1', port: codexPort, path: '/backend-api/codex/responses', method: 'POST', rejectUnauthorized: false }, (res) => {
        res.resume()
        ok(res.statusCode ?? 0)
      })
      req.on('error', bad)
      req.end('{}')
    })
    expect(status).toBe(200)
    expect(seen.at(-1)).toEqual({ path: '/backend-api/codex/responses', auth: 'Bearer TOK-C' })
  })

  it('three exits in a minute: the gateway serves from this process on the port the child held', async () => {
    const t = testControl({ marks: [] })
    const children = realChildren()
    let spawns = 0
    const host = await startHost({
      control: t.control,
      spawnChild: () => (++spawns === 1 ? children.spawn() : dyingChild()),
      readyTimeoutMs: 2_000
    })
    const port = host.status().port
    children.live[0].kill()
    await vi.waitFor(() => expect(host.status().process.mode).toBe('in-process'), { timeout: 5_000 })
    expect(spawns).toBe(3)
    expect(host.status().port).toBe(port)
    expect((await post(`${host.url('claude')}/~t=T6;a=B/v1/messages`)).status).toBe(200)
    expect(seen.at(-1)?.auth).toBe('Bearer TOK-B')
  })

  it('a spawn that throws counts, and the gateway still comes up in this process', async () => {
    const t = testControl({ marks: [] })
    const host = await startHost({
      control: t.control,
      spawnChild: () => {
        throw new Error('no utility process here')
      }
    })
    expect(host.status()).toMatchObject({ running: true, process: { mode: 'in-process', restarts: 2 } })
    expect((await post(`${host.url('claude')}/v1/messages`)).status).toBe(200)
  })
})

describe('the adoption gate', () => {
  it('adoptWarm resolves only on the child word', async () => {
    const { port1, port2 } = new MessageChannel()
    const child = nodeWire(port2)
    let ack: (() => void) | null = null
    child.onMessage((m: WireMessage) => {
      if (m.t === 'start') child.post({ t: 'ready', pid: 1, port: 40_000, scoped: [] })
      if (m.t === 'ask') ack = () => child.post({ t: 'reply', id: m.id, ok: true, value: null })
    })
    const host = new GatewayHost({ claimShim: false, tls: null, control: testControl({ marks: [] }).control, spawnChild: () => ({ wire: nodeWire(port1), kill: () => {}, onExit: () => {} }) })
    hosts.push(host)
    await host.start()
    let done = false
    const adopted = host.adoptWarm('w', { thread: 'T', account: 'A', pin: false }).then(() => (done = true))
    await vi.waitFor(() => expect(ack).not.toBeNull())
    await new Promise((r) => setTimeout(r, 20))
    expect(done).toBe(false)
    ack!()
    await adopted
    expect(done).toBe(true)
  })

  it("the adopted CLI's stdin passes nothing until the rebind is done", async () => {
    const stdin = new PassThrough()
    const got: string[] = []
    stdin.on('data', (c) => got.push(String(c)))
    const proc = { stdin, pid: 7, kill: () => true } as unknown as ChildProcess
    let rebind!: () => void
    const held = holdStdin(proc, new Promise<void>((r) => (rebind = r)))
    expect(held.pid).toBe(7)
    held.stdin!.write('{"type":"control_request"}\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(got).toEqual([])
    rebind()
    await vi.waitFor(() => expect(got.join('')).toBe('{"type":"control_request"}\n'))
  })
})

describe('PortControl', () => {
  const state = (over: Partial<AccountsState> = {}): AccountsState => ({ profiles: { 'claude-code': ['A', 'B'] }, pinned: { 'claude-code': 'A' }, reports: {}, out: [], ...over })
  const setup = (credential: (account: string | null) => Credential | null, initial = state()) => {
    let now = 1_000_000
    const asks: MainCall[] = []
    const told: unknown[] = []
    const control = new PortControl(
      {
        call: async <T,>(c: MainCall): Promise<T> => {
          asks.push(c)
          if (c.m === 'credentialFor') return credential(c.account) as T
          if (c.m === 'substitute') return 'A' as T
          return null as T
        }
      },
      (e) => told.push(e),
      initial,
      () => now
    )
    return { control, asks, told, tick: (ms: number) => (now += ms), at: () => now }
  }

  it('keeps a credential until a minute before its token ends, and one with no stated end for five minutes', async () => {
    let expiresAt = 0
    const { control, asks, tick, at } = setup((account) => (account === 'B' ? { authorization: 'Bearer B', expiresAt } : { authorization: 'Bearer pinned' }))
    expiresAt = at() + 10 * 60_000
    await control.credentialFor('claude', 'B')
    await control.credentialFor('claude', 'B')
    expect(asks).toHaveLength(1)
    tick(9 * 60_000 + 1)
    await control.credentialFor('claude', 'B')
    expect(asks).toHaveLength(2)
    await control.credentialFor('claude', null)
    tick(4 * 60_000)
    await control.credentialFor('claude', null)
    expect(asks).toHaveLength(3)
    tick(60_001)
    await control.credentialFor('claude', null)
    expect(asks).toHaveLength(4)
  })

  it('a 401, a vault save, a moved pin and a drop during an ask each forget what they should', async () => {
    const { control, asks } = setup((account) => ({ authorization: `Bearer ${account}`, expiresAt: Date.now() * 2 }))
    const count = () => asks.filter((a) => a.m === 'credentialFor').length
    await control.credentialFor('claude', 'B')
    control.onResponse({ service: 'claude', path: '/v1/messages', status: 401, headers: new Headers(), account: 'B', model: null })
    await control.credentialFor('claude', 'B')
    expect(count()).toBe(2)
    control.dropCredentials('codex')
    await control.credentialFor('claude', 'B')
    expect(count()).toBe(2)
    control.dropCredentials(null)
    await control.credentialFor('claude', 'B')
    expect(count()).toBe(3)
    // A moved pin forgets only the unscoped credential.
    await control.credentialFor('claude', null)
    control.setState(state({ pinned: { 'claude-code': 'B' } }))
    await control.credentialFor('claude', null)
    await control.credentialFor('claude', 'B')
    expect(count()).toBe(5)
    // An answer that crossed a drop is used once and not kept.
    control.dropCredentials(null)
    const asking = control.credentialFor('claude', 'A')
    control.dropCredentials(null)
    await asking
    await control.credentialFor('claude', 'A')
    expect(count()).toBe(7)
  })

  it('substitute asks main only for an account that is out, and only while its mark lasts', async () => {
    const { control, asks, tick, at } = setup(() => null, state({ out: [] }))
    const info = (account: string): ScopedRequest => ({ service: 'claude', serviceId: 'claude-code', thread: 'T', account, own: account, model: null })
    expect(await control.substitute(info('B'))).toBeNull()
    control.setOut([{ serviceId: 'claude-code', name: 'B', until: at() + 1_000 }])
    expect(await control.substitute(info('B'))).toBe('A')
    expect(await control.substitute(info('A'))).toBeNull()
    tick(1_001)
    expect(await control.substitute(info('B'))).toBeNull()
    expect(asks.filter((a) => a.m === 'substitute')).toHaveLength(1)
  })

  it('a fetch that got no answer crosses to main as a network event', () => {
    const { control, told } = setup(() => null)
    control.onNetwork({ service: 'claude', path: '/~t=T1;a=A/v1/messages', account: 'A', error: 'fetch failed' })
    expect(told).toEqual([{ e: 'network', info: { service: 'claude', path: '/~t=T1;a=A/v1/messages', account: 'A', error: 'fetch failed' } }])
  })

  it('a 429 is charged in the local copy at once and told to main; the headers cross as the limit subset', async () => {
    const { control, told } = setup(() => null)
    control.observeLimit('claude-code', 'A', { window: '5h', resetsAt: 123 })
    expect(await control.usageReport('claude-code', 'A')).toEqual({ profileName: 'A', windows: [{ label: '5h', usedPercent: 100, resetsAt: 123 }] })
    control.onResponse({
      service: 'claude',
      path: '/v1/messages',
      status: 200,
      headers: new Headers({ 'anthropic-ratelimit-tokens-remaining': '5', 'x-ratelimit-limit-requests': '9', 'retry-after': '1', 'set-cookie': 'x', 'content-type': 'text/event-stream' }),
      account: 'A',
      model: 'm'
    })
    expect(told).toEqual([
      { e: 'observeLimit', serviceId: 'claude-code', name: 'A', limit: { window: '5h', resetsAt: 123 } },
      {
        e: 'response',
        info: {
          service: 'claude',
          path: '/v1/messages',
          status: 200,
          account: 'A',
          model: 'm',
          headers: [
            ['anthropic-ratelimit-tokens-remaining', '5'],
            ['content-type', 'text/event-stream'],
            ['retry-after', '1'],
            ['x-ratelimit-limit-requests', '9']
          ]
        }
      }
    ])
  })
})
