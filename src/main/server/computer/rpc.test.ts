import { afterEach, describe, expect, it } from 'vitest'
import { COMPUTER_TOOLS, computerToolJsonSchema } from '@shared/computer/tools'
import type { ComputerPush } from '@shared/contract-computer'
import { ComputerPushSchema } from '@shared/wireSchemas'
import { MacThreadTokens } from '../macTools'
import type { ComputerBridge } from './bridge'
import { COMPUTER_BRIDGE_NOTE } from '@shared/computer/tools'
import type { ComputerHost } from './mcp'
import { ComputerRpc } from './rpc'
import { computerHarness, type ComputerHarness } from './runHarness'

const harnesses: ComputerHarness[] = []
const rpcs: ComputerRpc[] = []
afterEach(async () => {
  for (const r of rpcs.splice(0)) r.close()
  for (const h of harnesses.splice(0)) await h.close()
})
const until = async (pred: () => boolean, label: string): Promise<void> => {
  const end = Date.now() + 5_000
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

function make(permission: 'safe' | 'auto' = 'auto') {
  const h = computerHarness()
  harnesses.push(h)
  h.set('t1', { permission })
  const tokens = new MacThreadTokens(null, 'computer')
  const host: ComputerHost = { available: () => true, sessions: h.sessions, service: h.service, tokens }
  const rpc = new ComputerRpc(host)
  rpcs.push(rpc)
  const token = tokens.tokenFor('t1')
  const count = (method: string) => h.requests().filter((r) => r.method === method).length
  return { h, rpc, token, count }
}

describe('computer.sessions and the push', () => {
  it('a host without computer use answers its state and no rows', () => {
    const rpc = new ComputerRpc(null, () => 'computer use runs on a Mac')
    expect(rpc.sessions()).toEqual({ service: { state: 'unavailable', reason: 'computer use runs on a Mac', restarts: 0, permissions: null }, sessions: [] })
  })

  it('names the live thread, its app and window while a call runs, pushes at most four a second', async () => {
    const { h, rpc } = make()
    const pushes: { at: number; push: ComputerPush }[] = []
    rpc.onPush((push) => pushes.push({ at: Date.now(), push: ComputerPushSchema.parse(push) as ComputerPush }))
    await h.run('computer_observe', { app: 'TextEdit' })
    const slow = h.run('computer_observe', { app: 'Slow' })
    await until(() => rpc.sessions().sessions[0]?.running !== null && rpc.sessions().sessions.length === 1, 'the running row')
    const row = rpc.sessions().sessions[0]
    expect(row).toMatchObject({ threadId: 't1', running: { tool: 'computer_observe', words: 'Reading Slow' } })
    expect(row.apps).toEqual([{ name: 'TextEdit', bundleId: 'com.apple.TextEdit', window: 'Untitled' }])
    expect(rpc.sessions().service.state).toBe('up')
    h.sessions.cancel('t1', 'interrupt')
    await slow
    await until(() => pushes.some((p) => p.push.sessions[0]?.running === null), 'the settled push')
    for (let i = 1; i < pushes.length; i++) expect(pushes[i].at - pushes[i - 1].at).toBeGreaterThanOrEqual(240)
    h.set('t1', { status: 'idle' })
    await until(() => rpc.sessions().sessions.length === 0, 'the row to end with the turn')
  })

  it('computer.stop stops the thread and says whether it was live', async () => {
    const { h, rpc } = make()
    expect(await rpc.stop('t1')).toEqual({ stopped: false })
    const slow = h.run('computer_observe', { app: 'Slow' })
    await until(() => rpc.sessions().sessions.length === 1, 'the live row')
    expect(await rpc.stop('t1')).toEqual({ stopped: true })
    expect((await slow).body).toBe('stopped by the person; no more computer use this turn')
  })
})

describe('the bridge', () => {
  it('refuses a token not the thread\'s own, mac bridge tokens included', async () => {
    const { rpc } = make()
    const socket = rpc.socket()
    const mac = new MacThreadTokens(null).tokenFor('t1')
    await expect(socket.call({ sessionId: 't1', token: mac, call: 1, tool: 'computer_apps', args: {}, images: 'none' })).rejects.toThrow(/forbidden/)
    expect(() => socket.tools({ sessionId: 't1', token: 'x' })).toThrow(/forbidden/)
    expect(() => socket.cancel({ sessionId: 't1', token: 'x', call: 1 })).toThrow(/forbidden/)
  })

  it('answers with images as parts or none', async () => {
    const { rpc, token } = make()
    const socket = rpc.socket()
    const args = { app: 'TextEdit', screenshot: true }
    const parts = await socket.call({ sessionId: 't1', token, call: 1, tool: 'computer_observe', args, images: 'parts' })
    expect(parts.isError).toBe(false)
    expect(parts.text).toMatch(/^screenshot 1 \(observation\): .*\.jpg \(1280×1072\)\n\napp "TextEdit"/)
    expect(parts.images).toHaveLength(1)
    expect(parts.images[0]).toMatchObject({ label: 'observation', mimeType: 'image/jpeg', width: 1280, height: 1072 })
    const none = await socket.call({ sessionId: 't1', token, call: 2, tool: 'computer_observe', args, images: 'none' })
    expect(none.images).toEqual([])
    expect(none.text).toMatch(/^screenshot 1 \(observation\): /)
  })

  it('app.computerTools equals the JSON schemas of tools.ts', () => {
    const { rpc, token } = make()
    expect(rpc.socket().tools({ sessionId: 't1', token })).toEqual({
      tools: COMPUTER_TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: computerToolJsonSchema(t.input) }))
    })
  })

  it("lists a codex thread's tools in the cua words and a Muse thread's in the anthropic ones", () => {
    const { h, rpc } = make()
    h.set('t2', { provider: 'codex', model: 'gpt-6.1-sol' })
    const tokens = (rpc as unknown as { host: ComputerHost }).host.tokens
    const { tools } = rpc.socket().tools({ sessionId: 't2', token: tokens.tokenFor('t2') })
    expect(tools.map((t) => t.name)).toEqual(['computer_apps', 'computer_observe', 'computer_act', 'computer_batch'])
    expect(tools[1].description).toContain('getAXState')
    h.set('t3', { provider: 'muse', model: 'muse-wonder-1.0' })
    const muse = rpc.socket().tools({ sessionId: 't3', token: tokens.tokenFor('t3') }).tools
    expect(muse[1].description).not.toContain('getAXState')
    expect(muse.map((t) => t.description)).toEqual(COMPUTER_TOOLS.map((t) => t.description))
  })

  it('app.computerCancel denies a waiting card, and an Allow after it acts on nothing', async () => {
    const { h, rpc, token, count } = make('safe')
    const socket = rpc.socket()
    const call = socket.call({ sessionId: 't1', token, call: 'c1', tool: 'computer_act', args: { app: 'TextEdit', action: 'key', text: 'a' }, images: 'none' })
    await until(() => h.cards.length === 1, 'the card')
    socket.cancel({ sessionId: 't1', token, call: 'c1' })
    h.cards[0].decide(true)
    expect(await call).toMatchObject({ isError: true, text: 'cancelled: the call was given up' })
    expect(count('action.run')).toBe(0)
  })

  it('a closed socket denies its waiting card', async () => {
    const { h, rpc, token, count } = make('safe')
    const socket = rpc.socket()
    const call = socket.call({ sessionId: 't1', token, call: 7, tool: 'computer_act', args: { app: 'TextEdit', action: 'key', text: 'a' }, images: 'none' })
    await until(() => h.cards.length === 1, 'the card')
    socket.close()
    expect((await call).isError).toBe(true)
    expect(h.cards[0].req.signal?.aborted).toBe(true)
    expect(count('action.run')).toBe(0)
  })

  it('a call cancelled while queued behind another raises no card and sends nothing', async () => {
    const { h, rpc, token, count } = make('safe')
    const socket = rpc.socket()
    const slow = h.run('computer_observe', { app: 'Slow' })
    const queued = socket.call({ sessionId: 't1', token, call: 9, tool: 'computer_act', args: { app: 'TextEdit', action: 'key', text: 'a' }, images: 'none' })
    await until(() => count('state.get') === 1, 'the slow read')
    socket.cancel({ sessionId: 't1', token, call: 9 })
    h.sessions.cancel('t1', 'interrupt')
    await slow
    expect((await queued).text).toBe('cancelled: the call was given up')
    expect(h.cards).toHaveLength(0)
    expect(count('action.run')).toBe(0)
  })
})

describe('a box thread bridged to its Mac', () => {
  function boxRpc() {
    const runs: string[] = []
    const stops: string[] = []
    const listeners = new Set<() => void>()
    const row = { threadId: 'b1', since: 1, lastCallAt: 1, apps: [{ name: 'TextEdit', bundleId: null, window: 'Untitled' }], running: null, tier: null, macPeer: 'env_mac', macName: 'Studio' }
    const bridge = {
      offered: (id: string) => id === 'b1',
      bridged: (id: string) => id === 'b1' || id === 'b3',
      run: async (ctx: { threadId: string }, tool: string) => (runs.push(`${ctx.threadId} ${tool}`), { steps: [], shots: [], body: 'ok', isError: false }),
      rows: () => [row],
      onRows: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
      stop: async (id: string) => (stops.push(id), true)
    } as unknown as ComputerBridge
    const tokens = new MacThreadTokens(null, 'computer')
    const rpc = new ComputerRpc(null, () => 'computer use runs on a Mac', { bridge, tokens })
    rpcs.push(rpc)
    return { rpc, tokens, runs, stops, listeners }
  }

  it("computer.sessions answers the bridge's mirrored rows; computer.stop stops the bridged thread", async () => {
    const b = boxRpc()
    expect(b.rpc.sessions().sessions.map((r) => [r.threadId, r.macName])).toEqual([['b1', 'Studio']])
    expect(b.rpc.sessions().service.state).toBe('unavailable')
    expect(await b.rpc.stop('b1')).toEqual({ stopped: true })
    expect(b.stops).toEqual(['b1'])
    expect(await b.rpc.stop('other')).toEqual({ stopped: false })
  })

  it("app.computer and app.computerTools route a bridged thread behind its own token; another thread gets none", async () => {
    const b = boxRpc()
    const s = b.rpc.socket()
    expect((await s.call({ sessionId: 'b1', token: b.tokens.tokenFor('b1'), call: 1, tool: 'computer_observe', args: { app: 'TextEdit' }, images: 'none' })).text).toBe('ok')
    expect(b.runs).toEqual(['b1 computer_observe'])
    expect(s.tools({ sessionId: 'b1', token: b.tokens.tokenFor('b1') }).tools.every((t) => t.description.endsWith(COMPUTER_BRIDGE_NOTE))).toBe(true)
    expect(s.tools({ sessionId: 'b2', token: b.tokens.tokenFor('b2') }).tools).toEqual([])
    expect((await s.call({ sessionId: 'b2', token: b.tokens.tokenFor('b2'), call: 2, tool: 'computer_observe', args: { app: 'x' }, images: 'none' })).isError).toBe(true)
    await expect(s.call({ sessionId: 'b1', token: b.tokens.tokenFor('b2'), call: 3, tool: 'computer_observe', args: {}, images: 'none' })).rejects.toThrow(/computer token/)
    // A thread bridged to a Mac that no longer offers computer use: no tools, but a call still reaches the Mac for its own refusal.
    expect(s.tools({ sessionId: 'b3', token: b.tokens.tokenFor('b3') }).tools).toEqual([])
    await s.call({ sessionId: 'b3', token: b.tokens.tokenFor('b3'), call: 4, tool: 'computer_observe', args: { app: 'TextEdit' }, images: 'none' })
    expect(b.runs).toEqual(['b1 computer_observe', 'b3 computer_observe'])
  })

  it("a Mac's own push leaves out the sessions it holds for box threads", async () => {
    const { h, rpc } = make()
    await h.run('computer_observe', { app: 'TextEdit' }, 'env_abcdefghijklmnopqrstuv:b1')
    await h.run('computer_observe', { app: 'TextEdit' }, 't1')
    expect(h.sessions.rows().map((r) => r.threadId).sort()).toEqual(['env_abcdefghijklmnopqrstuv:b1', 't1'])
    expect(rpc.sessions().sessions.map((r) => r.threadId)).toEqual(['t1'])
  })
})
