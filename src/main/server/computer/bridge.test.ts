import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { ComputerSessionRow } from '@shared/contract-computer'
import type { MacBridgePush } from '@shared/contract-macbridge'
import { MacFetchFileArgsSchema } from '@shared/contract-macbridge'
import {
  COMPUTER_BRIDGE_IDLE_CLOSE_MS,
  COMPUTER_MAC_WENT_OFFLINE,
  COMPUTER_OFFER_PREFIX,
  askingWords,
  type ComputerPeerAnswer
} from '@shared/contract-maccomputer'
import { READER_ACK_MS } from '@shared/computer/heldCalls'
import type { SessionMeta, SessionStatus } from '@shared/events'
import { MAC_AWAY_REFUSAL, MAC_AWAY_REFUSAL_LEGACY } from '../awayPrompts'
import { CANCELLED_PAUSED, MacPause } from '../macPause'
import { PeerCalls, handlePeerRequest } from '../remote/peerCalls'
import { ComputerBridge, MAC_SILENT_CANCEL, STOP_REPLY_MS } from './bridge'
import type { CallReader } from './pending'
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
  const away: [string, string, string][] = []
  const ledger: string[] = []
  const pushed: ComputerSessionRow[][] = []
  const holds: [string, string | null][] = []
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
    awayNoticed: (id, kind, what) => void away.push([id, kind, what]),
    held: (id, line) => void holds.push([id, line]),
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
  return { sessions, bridged, settings, calls, out, register, reply, fail, progress, pause, landingRoot, clock, reboots, away, ledger, pushed, holds, bridge, ofMethod, status, run, until }
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

  it('an answer that says away writes the allowed row; a refusal for Away (either build) writes the skipped row', async () => {
    const b = box()
    const p = b.run('computer_act', click)
    await b.until(() => b.out.length === 1, 'out')
    b.reply(b.out[0].callId, answer({ away: true }))
    expect((await p).isError).toBe(false)
    expect(b.away).toEqual([['t1', 'allowed', 'Click at 5,5 in TextEdit?']])
    const q = b.run('computer_act', click)
    await b.until(() => b.out.length === 2, 'out')
    b.fail(b.out[1].callId, MAC_AWAY_REFUSAL)
    expect((await q).body).toBe('denied: the person is away and this act spends money; finish around it and name it in your report')
    const r = b.run('computer_act', click)
    await b.until(() => b.out.length === 3, 'out')
    b.fail(b.out[2].callId, MAC_AWAY_REFUSAL_LEGACY)
    expect((await r).body).toBe(MAC_AWAY_REFUSAL_LEGACY)
    expect(b.away.map(([, kind]) => kind)).toEqual(['allowed', 'approval', 'approval'])
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

describe("ComputerBridge: the Mac's hold is the thread's status", () => {
  const LOAD = (place: string) => `Waiting for the Mac, load 12.3 of 8, ${place} in line`
  const heldRow = (words: string) => row({ running: { tool: 'computer_act', words, startedAt: 5, held: true } })

  /** One call out on t1 with the Mac holding it at `LOAD('3rd')`. */
  async function heldCall() {
    const b = box()
    const p = b.run('computer_act', click)
    await b.until(() => b.out.length === 1, 'out')
    const callId = b.out[0].callId
    b.progress(callId, heldRow(LOAD('3rd')))
    expect(b.holds).toEqual([['t1', LOAD('3rd')]])
    return { b, p, callId }
  }

  it("a held row sets the hold with the Mac's words, a moved standing updates it, the running row clears it, once per change", async () => {
    const { b, p, callId } = await heldCall()
    b.progress(callId, heldRow(LOAD('3rd')))
    b.progress(callId, heldRow(LOAD('2nd')))
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 5 } }))
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 5 } }))
    expect(b.holds).toEqual([
      ['t1', LOAD('3rd')],
      ['t1', LOAD('2nd')],
      ['t1', null]
    ])
    // the guard's words without the mark are an action's, never a hold
    b.progress(callId, row({ running: { tool: 'computer_act', words: LOAD('1st'), startedAt: 5 } }))
    expect(b.holds).toHaveLength(3)
    b.reply(callId, answer())
    await p
    expect(b.holds).toHaveLength(3)
  })

  it('a card that replaces a hold clears it', async () => {
    const { b, p, callId } = await heldCall()
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Waiting for the Mac to be free', startedAt: 5, held: true }, asking: { line: 'Run now?' } }))
    expect(b.holds.at(-1)).toEqual(['t1', null])
    b.reply(callId, answer())
    await p
  })

  it('the answer clears it, and a row after the answer sets nothing', async () => {
    const { b, p, callId } = await heldCall()
    b.reply(callId, answer())
    await p
    expect(b.holds).toEqual([
      ['t1', LOAD('3rd')],
      ['t1', null]
    ])
    b.progress(callId, heldRow(LOAD('1st')))
    expect(b.holds).toHaveLength(2)
  })

  it('a failure clears it', async () => {
    const { b, p, callId } = await heldCall()
    b.fail(callId, 'refused: the Mac said no')
    expect((await p).isError).toBe(true)
    expect(b.holds.at(-1)).toEqual(['t1', null])
  })

  it('Stop clears it at once, and a row after the Stop sets nothing', async () => {
    const { b, p, callId } = await heldCall()
    await b.bridge.stop('t1')
    expect(b.holds.at(-1)).toEqual(['t1', null])
    b.progress(callId, heldRow(LOAD('1st')))
    expect(b.holds).toHaveLength(2)
    b.reply(callId, answer({ body: 'stopped by the person', isError: true }))
    await p
    expect(b.holds).toHaveLength(2)
  })

  it("the Mac's link going down clears it before the call fails", async () => {
    const { b, p } = await heldCall()
    b.bridge.linkDown(MAC)
    expect(b.holds.at(-1)).toEqual(['t1', null])
    b.calls.drop(1)
    expect((await p).body).toBe(COMPUTER_MAC_WENT_OFFLINE)
    expect(b.holds).toHaveLength(2)
  })

  it("the thread's end clears it, and a row after it sets nothing", async () => {
    const { b, p, callId } = await heldCall()
    b.bridge.threadsEnded(['t1'])
    expect(b.holds.at(-1)).toEqual(['t1', null])
    b.progress(callId, heldRow(LOAD('1st')))
    b.reply(callId, answer())
    await p
    expect(b.holds).toHaveLength(2)
  })

  it('close clears it, and a row after close sets nothing', async () => {
    const { b, callId } = await heldCall()
    b.bridge.close()
    expect(b.holds.at(-1)).toEqual(['t1', null])
    b.progress(callId, heldRow(LOAD('1st')))
    expect(b.holds).toHaveLength(2)
  })
})

/** A reader the test turns on and off; the bridge's release hook is captured to be called as pending.ts would. */
function stubReader(present = true) {
  let here = present
  const listeners = new Set<(p: boolean) => void>()
  const waiters = new Set<() => void>()
  let release: (() => Promise<boolean>) | null = null
  const reader: CallReader = {
    present: () => here,
    whenPresent: (signal) =>
      here || signal.aborted
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.add(resolve)
            signal.addEventListener('abort', () => resolve(), { once: true })
          }),
    request: (_signal, send) => send(),
    onChange: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    releaseBy: (fn) => {
      release = fn
    }
  }
  return {
    reader,
    set(p: boolean): void {
      here = p
      for (const l of [...listeners]) l(p)
      if (p) for (const w of [...waiters]) w()
      if (p) waiters.clear()
    },
    release: (): Promise<boolean> => {
      if (!release) throw new Error('the bridge set no release hook')
      return release()
    },
    listening: (): number => listeners.size
  }
}

describe('ComputerBridge: a held call and its reader', () => {
  const LOAD = 'Waiting for the Mac, load 12.3 of 8, 3rd in line'
  const heldRow = (words = LOAD) => row({ running: { tool: 'computer_act', words, startedAt: 5, held: true } })
  const runningRow = () => row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 5 } })

  /** One call out on t1 under a stub reader, the Mac holding it at LOAD. */
  async function held(present = true) {
    const b = box()
    const s = stubReader(present)
    const ac = new AbortController()
    let settled = false
    const p = b.bridge.run({ threadId: 't1', signal: ac.signal, reader: s.reader }, 'computer_act', click).then((o) => {
      settled = true
      return o
    })
    await b.until(() => b.ofMethod('mac.computer').length === 1, 'out')
    const callId = b.ofMethod('mac.computer')[0].callId
    b.progress(callId, heldRow())
    return { b, s, ac, p, callId, settled: () => settled }
  }
  const readers = (b: ReturnType<typeof box>) => b.ofMethod('mac.computerReader')

  it('nothing goes to the Mac while nobody reads the call; it goes once a reader comes', async () => {
    const b = box()
    const s = stubReader(false)
    const ac = new AbortController()
    const p = b.bridge.run({ threadId: 't1', signal: ac.signal, reader: s.reader }, 'computer_observe', observe)
    for (let i = 0; i < 20; i++) await settle()
    expect(b.out).toHaveLength(0)
    s.set(true)
    await b.until(() => b.ofMethod('mac.computer').length === 1, 'out once read')
    b.reply(b.out[0].callId, answer())
    expect((await p).isError).toBe(false)
  })

  it('a call given up while it waits for a reader never reaches the Mac', async () => {
    const b = box()
    const s = stubReader(false)
    const ac = new AbortController()
    const p = b.bridge.run({ threadId: 't1', signal: ac.signal, reader: s.reader }, 'computer_observe', observe)
    for (let i = 0; i < 10; i++) await settle()
    ac.abort('x')
    expect((await p).body).toBe('cancelled: the call was given up')
    s.set(true)
    for (let i = 0; i < 10; i++) await settle()
    expect(b.out).toHaveLength(0)
  })

  it("the reader may leave only on the Mac's held: true; the notice names the call, and a reader back sends reading: true", async () => {
    const { b, s, p, callId } = await held()
    let left: boolean | null = null
    const rel = s.release().then((ok) => (left = ok))
    await b.until(() => readers(b).length === 1, 'the notice')
    expect(readers(b)[0].params.args).toEqual({ callIds: [callId], reading: false })
    expect(readers(b)[0].params.thread.id).toBe('t1')
    for (let i = 0; i < 5; i++) await settle()
    expect(left).toBeNull()
    b.reply(readers(b)[0].callId, { held: true })
    await rel
    expect(left).toBe(true)
    // released already: no second notice
    expect(await s.release()).toBe(true)
    expect(readers(b)).toHaveLength(1)
    s.set(true)
    await b.until(() => readers(b).length === 2, 'reading again')
    expect(readers(b)[1].params.args).toEqual({ callIds: [callId], reading: true })
    b.reply(readers(b)[1].callId, { held: false })
    b.reply(callId, answer({ steps: ['left_click · ax · changed'] }))
    expect((await p).steps).toEqual(['left_click · ax · changed'])
    expect(s.listening()).toBe(0)
  })

  it('held: false keeps the reader, and no notice goes again until another hold begins', async () => {
    const { b, s, p, callId } = await held()
    const first = s.release()
    await b.until(() => readers(b).length === 1, 'the notice')
    b.reply(readers(b)[0].callId, { held: false })
    expect(await first).toBe(false)
    expect(await s.release()).toBe(false)
    expect(readers(b)).toHaveLength(1)
    // the request ends and a new hold begins: the Mac is asked again
    b.progress(callId, runningRow())
    b.progress(callId, heldRow())
    const again = s.release()
    await b.until(() => readers(b).length === 2, 'the second notice')
    b.reply(readers(b)[1].callId, { held: true })
    expect(await again).toBe(true)
    s.set(true)
    await b.until(() => readers(b).length === 3, 'reading again')
    b.reply(readers(b)[2].callId, { held: false })
    b.reply(callId, answer())
    expect((await p).isError).toBe(false)
  })

  it('an answer past READER_ACK_MS keeps the reader and sends reading: true at once; the call still runs', async () => {
    const { b, s, p, callId } = await held()
    const original = b.calls.call.bind(b.calls)
    const deadlines: number[] = []
    // the ack deadline as a few ms of real time: the Mac set the flag and answers too late
    b.calls.call = ((env, method, params, deadlineMs, opts) => {
      if (method === 'mac.computerReader') {
        deadlines.push(deadlineMs)
        if ((params as { args: { reading: boolean } }).args.reading === false) return original(env, method, params, 5, opts)
      }
      return original(env, method, params, deadlineMs, opts)
    }) as typeof b.calls.call
    let left: boolean | null = null
    const rel = s.release().then((ok) => (left = ok))
    await new Promise((r) => setTimeout(r, 30))
    await b.until(() => readers(b).length === 2, 'the notice and reading: true after it')
    expect(readers(b).map((c) => c.params.args)).toEqual([
      { callIds: [callId], reading: false },
      { callIds: [callId], reading: true }
    ])
    expect(deadlines).toEqual([READER_ACK_MS, READER_ACK_MS])
    b.reply(readers(b)[1].callId, { held: false })
    await rel
    expect(left).toBe(false)
    expect(b.ofMethod('mac.cancel')).toHaveLength(0)
    b.reply(callId, answer({ steps: ['left_click · ax · changed'] }))
    expect((await p).steps).toEqual(['left_click · ax · changed'])
  })

  it('a reading: true that fails after a late ack cancels the call softly: mac.cancel, then the given-up line past STOP_REPLY_MS', async () => {
    const { b, s, p, callId, settled } = await held()
    const original = b.calls.call.bind(b.calls)
    b.calls.call = ((env, method, params, deadlineMs, opts) =>
      original(env, method, params, method === 'mac.computerReader' && (params as { args: { reading: boolean } }).args.reading === false ? 5 : deadlineMs, opts)) as typeof b.calls.call
    const rel = s.release()
    await new Promise((r) => setTimeout(r, 30))
    await b.until(() => readers(b).length === 2, 'reading: true')
    b.fail(readers(b)[1].callId, 'the socket broke')
    expect(await rel).toBe(false)
    await b.until(() => b.ofMethod('mac.cancel').length === 1, 'mac.cancel')
    expect(b.ofMethod('mac.cancel')[0].params.args).toEqual({ callIds: [callId], reason: 'stopped' })
    for (let i = 0; i < 5; i++) await settle()
    expect(settled()).toBe(false)
    await b.clock.advance(STOP_REPLY_MS + 1)
    expect((await p).body).toBe(MAC_SILENT_CANCEL)
  })

  it("an older Mac's own refusal, its file read's parse error on path, marks it too", async () => {
    const { b, s, p, callId } = await held()
    const first = s.release()
    await b.until(() => readers(b).length === 1, 'the notice')
    // what a Mac with no route for the method answers: it reads the args as mac.fetchFile's
    let refusal = ''
    try {
      MacFetchFileArgsSchema.parse(readers(b)[0].params.args)
    } catch (err) {
      refusal = (err as Error).message
    }
    b.fail(readers(b)[0].callId, refusal)
    expect(await first).toBe(false)
    b.progress(callId, runningRow())
    b.progress(callId, heldRow())
    expect(await s.release()).toBe(false)
    expect(readers(b)).toHaveLength(1)
    b.reply(callId, answer())
    await p
  })

  it('any other failure keeps the reader and leaves the Mac as it was: the next hold asks again', async () => {
    const { b, s, p, callId } = await held()
    const first = s.release()
    await b.until(() => readers(b).length === 1, 'the notice')
    b.fail(readers(b)[0].callId, 'this Mac does not know that host')
    expect(await first).toBe(false)
    // a refusal of the call's own fields comes from a Mac that knows the call
    b.progress(callId, runningRow())
    b.progress(callId, heldRow())
    const second = s.release()
    await b.until(() => readers(b).length === 2, 'a second notice')
    b.fail(readers(b)[1].callId, JSON.stringify([{ code: 'too_small', path: ['callIds'], message: 'Too small' }]))
    expect(await second).toBe(false)
    b.progress(callId, runningRow())
    b.progress(callId, heldRow())
    const third = s.release()
    await b.until(() => readers(b).length === 3, 'a third notice')
    b.reply(readers(b)[2].callId, { held: true })
    expect(await third).toBe(true)
    b.reply(callId, answer())
    await p
  })

  it("an older Mac's refusal keeps the reader, and that Mac is told nothing more", async () => {
    const { b, s, p, callId } = await held()
    const first = s.release()
    await b.until(() => readers(b).length === 1, 'the notice')
    b.fail(readers(b)[0].callId, 'unknown method mac.computerReader')
    expect(await first).toBe(false)
    b.progress(callId, runningRow())
    b.progress(callId, heldRow())
    expect(await s.release()).toBe(false)
    b.reply(callId, answer())
    await p
    // a later call to the same Mac: still nothing
    const s2 = stubReader()
    const q = b.bridge.run({ threadId: 't2', signal: new AbortController().signal, reader: s2.reader }, 'computer_act', click)
    await b.until(() => b.ofMethod('mac.computer').length === 2, 'the second call')
    const second = b.ofMethod('mac.computer')[1].callId
    b.progress(second, heldRow())
    expect(await s2.release()).toBe(false)
    expect(readers(b)).toHaveLength(1)
    b.reply(second, answer())
    await q
    // its link dropping forgets the mark: it may come back on a newer build
    b.bridge.linkDown(MAC)
    const s3 = stubReader()
    const r = b.bridge.run({ threadId: 't2', signal: new AbortController().signal, reader: s3.reader }, 'computer_act', click)
    await b.until(() => b.ofMethod('mac.computer').length === 3, 'the third call')
    const third = b.ofMethod('mac.computer')[2].callId
    b.progress(third, heldRow())
    const asked = s3.release()
    await b.until(() => readers(b).length === 2, 'a notice again')
    b.reply(readers(b)[1].callId, { held: true })
    expect(await asked).toBe(true)
    b.reply(third, answer())
    await r
  })

  it("a soft cancel sends mac.cancel, keeps the call out and answers the Mac's reply with its steps", async () => {
    const { b, ac, p, callId, settled } = await held()
    ac.abort('unread')
    await b.until(() => b.ofMethod('mac.cancel').length === 1, 'mac.cancel')
    expect(b.ofMethod('mac.cancel')[0].params.args).toEqual({ callIds: [callId], reason: 'stopped' })
    for (let i = 0; i < 5; i++) await settle()
    expect(settled()).toBe(false)
    b.reply(callId, answer({ steps: ['key a · ax · changed', 'Not executed: an earlier action in this batch failed.'], body: 'cancelled', isError: true }))
    expect(await p).toMatchObject({ steps: ['key a · ax · changed', 'Not executed: an earlier action in this batch failed.'], body: 'cancelled' })
  })

  it('a soft cancel the Mac never answers is given up with MAC_SILENT_CANCEL after STOP_REPLY_MS', async () => {
    for (const why of ['superseded', 'cancel'] as const) {
      const { b, ac, p } = await held()
      ac.abort(why)
      await b.until(() => b.ofMethod('mac.cancel').length === 1, 'mac.cancel')
      await b.clock.advance(STOP_REPLY_MS - 1)
      await settle()
      await b.clock.advance(2)
      expect((await p).body).toBe(MAC_SILENT_CANCEL)
    }
  })

  it('a dropped link ends a release in flight with false and the call with COMPUTER_MAC_WENT_OFFLINE', async () => {
    const { b, s, p } = await held()
    const rel = s.release()
    await b.until(() => readers(b).length === 1, 'the notice')
    b.calls.drop(1)
    expect(await rel).toBe(false)
    expect((await p).body).toBe(COMPUTER_MAC_WENT_OFFLINE)
  })

  it("holdWords says the mirrored row's hold, the card's words while one waits, and nothing once the call answered", async () => {
    const { b, p, callId } = await held()
    expect(b.bridge.holdWords('t1')).toBe(LOAD)
    b.progress(callId, runningRow())
    expect(b.bridge.holdWords('t1')).toBeNull()
    b.progress(callId, row({ running: { tool: 'computer_act', words: 'Clicking in TextEdit', startedAt: 5 }, asking: { line: 'Click (5, 5) in TextEdit?' } }))
    expect(b.bridge.holdWords('t1')).toBe(askingWords('Studio'))
    b.reply(callId, answer())
    await p
    expect(b.bridge.holdWords('t1')).toBeNull()
    expect(b.bridge.holdWords('t2')).toBeNull()
  })
})
