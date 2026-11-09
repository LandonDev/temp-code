import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { MacBridgePush } from '@shared/contract-macbridge'
import {
  COMPUTER_BRIDGE_IDLE_CLOSE_MS,
  COMPUTER_MAC_WENT_OFFLINE,
  COMPUTER_OFFER_PREFIX,
  type ComputerPeerAnswer
} from '@shared/contract-maccomputer'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { MAC_AWAY_REFUSAL } from '../awayPrompts'
import { CANCELLED_PAUSED, MacPause } from '../macPause'
import { PeerCalls, handlePeerRequest } from '../remote/peerCalls'
import { ComputerBridge, STOP_REPLY_MS } from './bridge'
import { renderText } from './result'
import { ManualClock, settle } from './testFake'

const MAC = 'env_mac'
type Call = Extract<MacBridgePush, { push: 'peer.call' }> & { params: { thread: { id: string; permission?: string }; args: Record<string, unknown> } }

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({ id, parentId: null, title: `T ${id}`, status: 'running', permission: 'safe', archived: false, ...extra }) as SessionMeta

const answer = (extra: Partial<ComputerPeerAnswer> = {}): ComputerPeerAnswer => ({ steps: [], body: 'TextEdit "Untitled"', isError: false, images: [], row: null, ...extra })
const row = (extra: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId: `${MAC}:t1`,
  since: 1,
  lastCallAt: 2,
  apps: [{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', window: 'Untitled' }],
  running: null,
  tier: 'ax',
  ...extra
})

const bridges: ComputerBridge[] = []
afterEach(() => {
  for (const b of bridges.splice(0)) b.close()
})

function box(opts: { bridged?: string[]; offers?: string[] } = {}) {
  const sessions = new Map<string, SessionMeta>([
    ['t1', meta('t1')],
    ['t2', meta('t2')],
    ['child', meta('child', { parentId: 't1' })],
    ['plain', meta('plain')]
  ])
  const bridged = new Set(opts.bridged ?? ['t1', 't2', 'child'])
  const settings = new Map<string, string>()
  const calls = new PeerCalls('env_box', () => {})
  const out: Call[] = []
  const socket = {
    connection: 1,
    keyId: 'k',
    remote: true,
    send: (frame: ServerFrame) => {
      if ('push' in frame && frame.push === 'peer.call') out.push(frame as Call)
    }
  }
  const register = (offers = opts.offers ?? ['mac-bridge', 'computer']): void =>
    void handlePeerRequest(calls, socket, { method: 'peer.register', params: { from: MAC, offers } })
  register()
  const reply = (callId: string, result: unknown): void =>
    void handlePeerRequest(calls, socket, { method: 'peer.reply', params: { callId, ok: true, result } } as Parameters<typeof handlePeerRequest>[2])
  const fail = (callId: string, error: string): void =>
    void handlePeerRequest(calls, socket, { method: 'peer.reply', params: { callId, ok: false, error } } as Parameters<typeof handlePeerRequest>[2])
  let progressSeq = 0
  const progress = (callId: string, r: ComputerSessionRow): void =>
    void handlePeerRequest(calls, socket, { method: 'peer.progress', params: { callId, seq: progressSeq++, chunk: JSON.stringify({ row: r }) } } as Parameters<typeof handlePeerRequest>[2])
  const pause = new MacPause({ sessions: { get: (id) => sessions.get(id) ?? null }, calls, log: () => {} })
  const landingRoot = mkdtempSync(join(tmpdir(), 'tc-bridge-'))
  const clock = new ManualClock()
  const reboots: string[] = []
  const away: [string, string][] = []
  const ledger: string[] = []
  const pushed: ComputerSessionRow[][] = []
  const bridge = new ComputerBridge({
    calls,
    macPeerOf: (id) => {
      for (let cur: string | null = id; cur; cur = sessions.get(cur)?.parentId ?? null) if (bridged.has(cur)) return MAC
      return null
    },
    pause,
    sessions: { get: (id) => sessions.get(id) ?? null, list: () => [...sessions.values()] },
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => void (v === null ? settings.delete(k) : settings.set(k, v)) },
    landing: (s) => join(landingRoot, s.id, 'computer'),
    macName: () => 'Studio',
    resources: {
      recordComputer: (id, mac, label) => void ledger.push(`record ${id} ${mac} ${label}`),
      computerEnded: (id, mac, note) => void ledger.push(`ended ${id} ${mac} ${note}`)
    },
    reboot: (id) => void reboots.push(id),
    awayRefused: (id, what) => void away.push([id, what]),
    clock,
    log: () => {}
  })
  bridges.push(bridge)
  bridge.onRows((rows) => pushed.push(rows))
  const ofMethod = (method: string): Call[] => out.filter((c) => c.method === method)
  const status = (id: string, s: SessionStatus): void => {
    sessions.set(id, { ...sessions.get(id)!, status: s })
    bridge.onMeta(sessions.get(id)!)
    pause.onStatus(id, s)
  }
  const run = (tool: string, args: Record<string, unknown>, threadId = 't1', ctx: { signal?: AbortSignal; permission?: () => SessionMeta['permission'] } = {}) =>
    bridge.run({ threadId, ...ctx }, tool, args)
  const until = async (pred: () => boolean, label: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (pred()) return
      await settle()
    }
    throw new Error(`timed out: ${label}`)
  }
  return { sessions, bridged, settings, calls, out, register, reply, fail, progress, pause, landingRoot, clock, reboots, away, ledger, pushed, bridge, ofMethod, status, run, until }
}

const observe = { app: 'TextEdit' }
const click = { app: 'TextEdit', action: 'left_click', coordinate: [5, 5] }

describe('ComputerBridge: the offer', () => {
  it('a thread is offered the tools only when its bridge names a Mac that offers computer use, kept while that Mac is offline', () => {
    const b = box({ offers: ['mac-bridge'] })
    expect(b.bridge.offered('plain')).toBe(false)
    expect(b.bridge.offered('t1')).toBe(false)
    b.register(['mac-bridge', 'computer'])
    expect(b.bridge.offered('t1')).toBe(true)
    expect(b.bridge.offered('child')).toBe(true)
    b.bridge.offersChanged(MAC, new Set(['mac-bridge', 'computer']))
    b.calls.drop(1)
    expect(b.bridge.offered('t1')).toBe(true)
    b.settings.delete(`${COMPUTER_OFFER_PREFIX}${MAC}`)
    expect(b.bridge.offered('t1')).toBe(false)
    expect(b.bridge.bridged('t1')).toBe(true)
    expect(b.bridge.bridged('plain')).toBe(false)
  })

  it('an offer that flips is kept and reboots the bridged threads; an equal one does nothing', () => {
    const b = box()
    b.bridge.offersChanged(MAC, new Set(['mac-bridge', 'computer']))
    expect(b.settings.get(`${COMPUTER_OFFER_PREFIX}${MAC}`)).toBe('on')
    expect(b.reboots.sort()).toEqual(['child', 't1', 't2'])
    b.bridge.offersChanged(MAC, new Set(['mac-bridge', 'computer']))
    expect(b.reboots).toHaveLength(3)
    b.bridge.offersChanged(MAC, new Set(['mac-bridge']))
    expect(b.settings.has(`${COMPUTER_OFFER_PREFIX}${MAC}`)).toBe(false)
    expect(b.reboots).toHaveLength(6)
  })
})

describe('ComputerBridge: one call', () => {
  it('carries the tool call with the permission read inside the queue, the turn and the root', async () => {
    const b = box()
    let permission: SessionMeta['permission'] = 'safe'
    const first = b.run('computer_observe', observe, 'child', { permission: () => permission })
    const second = b.run('computer_left_click', { app: 'TextEdit', coordinate: [1, 1] }, 'child', { permission: () => permission })
    await b.until(() => b.ofMethod('mac.computer').length === 1, 'the first call')
    permission = 'auto'
    b.reply(b.out[0].callId, answer())
    await first
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'the second call')
    const [c1, c2] = b.ofMethod('mac.computer')
    expect(c1.params.args).toMatchObject({ call: { tool: 'computer_observe', args: observe, threadId: 'child', permission: 'safe' }, rootId: 't1' })
    expect(c2.params.args).toMatchObject({ call: { tool: 'computer_act', args: { action: 'left_click' }, permission: 'auto' } })
    expect(c2.params.args.turn).toBe(c1.params.args.turn)
    b.reply(c2.callId, answer())
    await second
    b.status('child', 'idle')
    b.status('child', 'running')
    const third = b.run('computer_observe', observe, 'child')
    await b.until(() => b.ofMethod('mac.computer').length === 3, 'the third call')
    expect(b.ofMethod('mac.computer')[2].params.args.turn).not.toBe(c1.params.args.turn)
    b.reply(b.ofMethod('mac.computer')[2].callId, answer())
    await third
  })

  it('refuses bad arguments with no peer call', async () => {
    const b = box()
    expect((await b.run('computer_fly', {})).body).toMatch(/^invalid arguments/)
    expect((await b.run('computer_act', { app: 'TextEdit', action: 'left_click', coordinate: 'here' })).body).toMatch(/^invalid arguments/)
    expect(b.out).toHaveLength(0)
  })

  it('one call at a time per thread; two threads at once', async () => {
    const b = box()
    const a1 = b.run('computer_observe', observe, 't1')
    const a2 = b.run('computer_observe', observe, 't1')
    const c1 = b.run('computer_observe', observe, 't2')
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'two out')
    expect(b.ofMethod('mac.computer').map((c) => c.params.thread.id).sort()).toEqual(['t1', 't2'])
    for (const c of b.ofMethod('mac.computer')) b.reply(c.callId, answer())
    await Promise.all([a1, c1])
    await b.until(() => b.ofMethod('mac.computer').length === 3, 'the next of t1')
    b.reply(b.ofMethod('mac.computer')[2].callId, answer())
    await a2
  })

  it('a call cancelled or Stopped while it waits behind another never reaches the Mac', async () => {
    const b = box()
    const first = b.run('computer_observe', observe)
    const given = new AbortController()
    const queued = b.run('computer_observe', observe, 't1', { signal: given.signal })
    await b.until(() => b.ofMethod('mac.computer').length === 1, 'the first out')
    given.abort('x')
    expect((await queued).body).toBe('cancelled: the call was given up')
    const stopped = b.run('computer_observe', observe)
    void b.bridge.stop('t1')
    expect((await stopped).body).toBe('stopped by the person; no more computer use this turn')
    b.reply(b.ofMethod('mac.computer')[0].callId, answer({ steps: [], body: 'stopped by the person', isError: true }))
    await first
    await settle()
    expect(b.ofMethod('mac.computer')).toHaveLength(1)
  })

  it('lands the pictures under the thread with its own counter, and the text puts their lines between the steps and the body', async () => {
    const b = box()
    const jpg = Buffer.from([0xff, 0xd8, 1, 2])
    const png = Buffer.from([0x89, 0x50, 3])
    const p = b.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'screenshot' }] })
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({
      steps: ['screenshot · ax'],
      body: 'TextEdit "Untitled"',
      images: [
        { label: 'step 1', data: jpg.toString('base64'), mimeType: 'image/jpeg', width: 10, height: 20 },
        { label: 'observation', data: png.toString('base64'), mimeType: 'image/png', width: 30, height: 40 }
      ]
    }))
    const o = await p
    const dir = join(b.landingRoot, 't1', 'computer')
    expect(readdirSync(dir).sort()).toEqual(['0001.jpg', '0002.png'])
    expect(readFileSync(join(dir, '0001.jpg'))).toEqual(jpg)
    expect(o.shots.map((s) => [s.label, s.where, s.mimeType, s.width, s.height])).toEqual([
      ['step 1', 1, 'image/jpeg', 10, 20],
      ['observation', 'observation', 'image/png', 30, 40]
    ])
    const parts = renderText(o)
    const lines = parts.split('\n')
    expect(lines[0]).toBe('screenshot · ax')
    expect(lines[1]).toContain(join(dir, '0001.jpg'))
    expect(lines[2]).toContain(join(dir, '0002.png'))
    expect(lines.at(-1)).toBe('TextEdit "Untitled"')
    expect(renderText(o, { shotLines: false })).toBe('screenshot · ax\n\nTextEdit "Untitled"')
    const next = b.run('computer_observe', { ...observe, screenshot: true })
    await b.until(() => b.out.length === 2, 'the next')
    b.reply(b.out[1].callId, answer({ images: [{ label: 'observation', data: jpg.toString('base64'), mimeType: 'image/jpeg', width: 1, height: 1 }] }))
    expect((await next).shots[0].path).toBe(join(dir, '0003.jpg'))
  })

  it('a picture of another type is refused', async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ images: [{ label: 'observation', data: 'AA==', mimeType: 'image/gif', width: 1, height: 1 }] }))
    expect((await p).body).toMatch(/refused: a picture of type image\/gif/)
  })

  it('an answer that does not parse is the Mac sending something this host cannot read', async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, { text: 'old shape', images: [] })
    expect((await p).body).toBe('computer use is off on this host: the Mac sent an answer this host cannot read; do the work another way')
  })
})

describe('ComputerBridge: pause, Stop, Away, offline', () => {
  it('a paused thread is refused with no peer call; a pause mid-call answers cancelled and mac.cancel names the call', async () => {
    const b = box()
    b.status('t1', 'paused')
    expect((await b.run('computer_observe', observe)).body).toBe('refused: the thread is paused')
    expect(b.ofMethod('mac.computer')).toHaveLength(0)
    b.status('t1', 'running')
    const p = b.run('computer_act', click)
    await b.until(() => b.ofMethod('mac.computer').length === 1, 'out')
    const callId = b.ofMethod('mac.computer')[0].callId
    b.status('t1', 'paused')
    expect((await p).body).toBe(CANCELLED_PAUSED)
    expect(b.ofMethod('mac.cancel').at(-1)?.params.args).toMatchObject({ callIds: [callId], reason: 'paused' })
  })

  it("the harness's abort answers at once and sends mac.cancel for that call only", async () => {
    const b = box()
    const given = new AbortController()
    const p = b.run('computer_observe', observe, 't1', { signal: given.signal })
    const other = b.run('computer_observe', observe, 't2')
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'both out')
    const mine = b.ofMethod('mac.computer').find((c) => c.params.thread.id === 't1')!.callId
    given.abort('x')
    expect((await p).body).toBe('cancelled: the call was given up')
    expect(b.ofMethod('mac.cancel').map((c) => c.params.args)).toEqual([{ callIds: [mine], reason: 'stopped' }])
    b.reply(b.ofMethod('mac.computer').find((c) => c.params.thread.id === 't2')!.callId, answer())
    await other
  })

  it("Stop ends computer use for the turn: mac.computerEnd stopped, the call in flight answers the Mac's partial steps, later ones stopped with no call, the next turn runs", async () => {
    const b = box()
    const p = b.run('computer_batch', { app: 'TextEdit', actions: [{ action: 'key', text: 'a' }, { action: 'key', text: 'b' }] })
    await b.until(() => b.out.length === 1, 'out')
    b.progress(b.out[0].callId, row({ running: { tool: 'computer_batch', words: 'Working in TextEdit', startedAt: 1 } }))
    expect(await b.bridge.stop('t1')).toBe(true)
    expect(b.ofMethod('mac.computerEnd').map((c) => c.params.args)).toEqual([{ reason: 'stopped' }])
    b.reply(b.out[0].callId, answer({ steps: ['key a · ax · changed', 'Not executed: an earlier action in this batch failed.'], body: 'stopped by the person', isError: true }))
    expect(await p).toMatchObject({ steps: ['key a · ax · changed', 'Not executed: an earlier action in this batch failed.'], body: 'stopped by the person' })
    expect((await b.run('computer_observe', observe)).body).toBe('stopped by the person; no more computer use this turn')
    expect(b.ofMethod('mac.computer')).toHaveLength(1)
    b.status('t1', 'idle')
    b.status('t1', 'running')
    const next = b.run('computer_observe', observe)
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'the next turn')
    b.reply(b.ofMethod('mac.computer')[1].callId, answer())
    expect((await next).isError).toBe(false)
  })

  it('a reply after a Stop or the thread\'s end answers its steps but brings back neither the row nor the ledger entry', async () => {
    const b = box()
    const p = b.run('computer_act', click)
    await b.until(() => b.out.length === 1, 'out')
    b.progress(b.out[0].callId, row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 1 } }))
    await b.bridge.stop('t1')
    b.progress(b.out[0].callId, row({ asking: { line: 'Click?' } }))
    b.reply(b.out[0].callId, answer({ steps: [], body: 'stopped by the person', isError: true, row: row() }))
    expect((await p).body).toBe('stopped by the person')
    expect(b.bridge.rows()).toEqual([])
    expect(b.ledger).toEqual([])
    const q = b.run('computer_observe', observe, 't2')
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'out')
    b.bridge.threadsEnded(['t2'])
    b.reply(b.ofMethod('mac.computer')[1].callId, answer({ row: row({ threadId: 'env_mac:t2' }) }))
    expect((await q).isError).toBe(false)
    expect(b.bridge.rows()).toEqual([])
    expect(b.ledger).toEqual([])
  })

  it('a Stop or the thread\'s end while the reply\'s pictures are being written still brings back neither the row nor the ledger entry', async () => {
    const b = box()
    const image = { label: 'observation', data: Buffer.from([0xff, 0xd8, 1]).toString('base64'), mimeType: 'image/jpeg', width: 1, height: 1 }
    const p = b.run('computer_observe', { ...observe, screenshot: true })
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ images: [image], row: row() }))
    await new Promise((r) => setImmediate(r))
    void b.bridge.stop('t1')
    expect((await p).shots).toHaveLength(1)
    expect(b.bridge.rows()).toEqual([])
    expect(b.ledger).toEqual([])
    const q = b.run('computer_observe', { ...observe, screenshot: true }, 't2')
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'out')
    b.reply(b.ofMethod('mac.computer')[1].callId, answer({ images: [image], row: row() }))
    await new Promise((r) => setImmediate(r))
    b.bridge.threadsEnded(['t2'])
    expect((await q).shots).toHaveLength(1)
    expect(b.ledger).toEqual([])
  })

  it('a call that never answers a Stop is given up after 10 s', async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    await b.bridge.stop('t1')
    await b.clock.advance(STOP_REPLY_MS + 1)
    expect((await p).body).toBe('stopped by the person; no more computer use this turn')
  })

  it('an answer that says away writes the away row; a refusal for Away answers away and writes it too', async () => {
    const b = box()
    const p = b.run('computer_act', click)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ body: 'denied: the person is away', isError: true, away: true }))
    expect((await p).body).toBe('denied: the person is away')
    expect(b.away).toEqual([['t1', 'Click at 5,5 in TextEdit?']])
    const q = b.run('computer_act', click)
    await b.until(() => b.out.length === 2, 'out')
    b.fail(b.out[1].callId, MAC_AWAY_REFUSAL)
    expect((await q).body).toBe('denied: the person is away; finish around this act and name it in your report')
    expect(b.away).toHaveLength(2)
  })

  it("a Mac refusal is the Mac's line as written", async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.fail(b.out[0].callId, "refused: computer use is off for this host; turn on Computer use for it in the Mac's Settings → Hosts")
    expect(await p).toMatchObject({ isError: true, body: "refused: computer use is off for this host; turn on Computer use for it in the Mac's Settings → Hosts" })
  })

  it('no Mac named, the Mac offline before a call, and the Mac going offline during one', async () => {
    const b = box()
    expect((await b.run('computer_observe', observe, 'plain')).body).toBe('computer use is off on this host: the Mac bridge is off for this thread (turn it on from the thread menu); do the work another way')
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.calls.drop(1)
    expect((await p).body).toBe(COMPUTER_MAC_WENT_OFFLINE)
    expect((await b.run('computer_observe', observe)).body).toMatch(/^computer use is off on this host: Mac offline: env_mac/)
  })
})

describe('ComputerBridge: rows, turns and the ledger', () => {
  it("mirrors the Mac's row re-keyed with the Mac, the card's words while one waits, the guard's standing as it came", async () => {
    const b = box()
    const p = b.run('computer_act', click)
    await b.until(() => b.out.length === 1, 'out')
    const callId = b.out[0].callId
    await b.clock.advance(250)
    expect(b.bridge.rows()).toEqual([expect.objectContaining({ threadId: 't1', macPeer: MAC, macName: 'Studio', running: expect.objectContaining({ words: 'Clicking in TextEdit' }) })])
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Waiting for the Mac, 2 of 2 computer sessions, 1st in line', startedAt: 5 } }))
    expect(b.bridge.rows()[0].running?.words).toBe('Waiting for the Mac, 2 of 2 computer sessions, 1st in line')
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 5 }, asking: { line: 'Click (5, 5) in TextEdit?' } }))
    expect(b.bridge.rows()[0]).toMatchObject({ threadId: 't1', asking: { line: 'Click (5, 5) in TextEdit?' }, running: { words: 'Waiting for approval on Studio' } })
    const before = b.pushed.length
    await b.clock.advance(100)
    expect(b.pushed.length - before).toBeLessThanOrEqual(1)
    await b.clock.advance(1_000)
    expect(b.pushed.length - before).toBe(1)
    b.reply(callId, answer({ row: row() }))
    await p
    expect(b.bridge.rows()[0]).toMatchObject({ threadId: 't1', running: null, apps: [{ name: 'TextEdit' }] })
    expect(b.bridge.rows()[0].asking).toBeUndefined()
  })

  it('a settle sends settled once and ends the row; threadsEnded sends ended and stamps the ledger', async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ row: row() }))
    await p
    expect(b.ledger).toEqual(['record t1 env_mac TextEdit'])
    b.status('t1', 'idle')
    b.status('t1', 'done')
    expect(b.ofMethod('mac.computerEnd').map((c) => c.params.args)).toEqual([{ reason: 'settled' }])
    expect(b.bridge.rows()).toEqual([])
    b.bridge.threadsEnded(['t1'])
    expect(b.ofMethod('mac.computerEnd').map((c) => c.params.args)).toEqual([{ reason: 'settled' }, { reason: 'ended' }])
    expect(b.ledger).toEqual(['record t1 env_mac TextEdit', 'ended t1 env_mac ended with the thread'])
  })

  it('closes the Mac session after 10 idle minutes, never while a call is out, and records the ledger again when the thread comes back', async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    await b.clock.advance(COMPUTER_BRIDGE_IDLE_CLOSE_MS + 60_000)
    expect(b.ofMethod('mac.computerEnd')).toHaveLength(0)
    b.reply(b.out[0].callId, answer({ row: row() }))
    await p
    await b.clock.advance(COMPUTER_BRIDGE_IDLE_CLOSE_MS - 1_000)
    expect(b.ofMethod('mac.computerEnd')).toHaveLength(0)
    await b.clock.advance(2_000)
    expect(b.ofMethod('mac.computerEnd').map((c) => c.params.args)).toEqual([{ reason: 'ended' }])
    expect(b.ledger).toEqual(['record t1 env_mac TextEdit', 'ended t1 env_mac closed after 10 idle minutes'])
    const q = b.run('computer_observe', observe)
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'again')
    b.reply(b.ofMethod('mac.computer')[1].callId, answer({ row: row() }))
    await q
    expect(b.ledger.at(-1)).toBe('record t1 env_mac TextEdit')
  })

  it("the ledger's removal ends the session on the Mac, and refuses while it is offline", async () => {
    const b = box()
    const ended = b.bridge.end(MAC, meta('t1'), 't1')
    await b.until(() => b.ofMethod('mac.computerEnd').length === 1, 'the end')
    b.reply(b.ofMethod('mac.computerEnd')[0].callId, { ended: true })
    expect(await ended).toEqual({ ended: true })
    b.calls.drop(1)
    await expect(b.bridge.end(MAC, meta('t1'), 't1')).rejects.toMatchObject({ offline: true })
  })

  it("a dropped link ends that Mac's rows", async () => {
    const b = box()
    const p = b.run('computer_observe', observe)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ row: row() }))
    await p
    expect(b.bridge.rows()).toHaveLength(1)
    b.bridge.linkDown(MAC)
    expect(b.bridge.rows()).toEqual([])
    expect(existsSync(b.landingRoot)).toBe(true)
  })
})
