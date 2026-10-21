import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { MacBridgePush } from '@shared/contract-macbridge'
import { CROSS_HOST_OFFER, encodeAgentId, type CrossHostCallParams } from '@shared/contract-crosshost'
import type { SessionMeta } from '@shared/events'
import { CHILDREN_PREFIX, CrossHostAgents } from './crossHostAgents'
import { PeerCalls, handlePeerRequest, servePeerCall, type PeerCallHandler, type PeerSocket } from './remote/peerCalls'

type Call = Extract<MacBridgePush, { push: 'peer.call' }>
const MAC = `env_${'m'.repeat(22)}`
const MAC2 = `env_${'n'.repeat(22)}`
const BOX = `env_${'b'.repeat(22)}`

const parent = { id: 'box-thread', title: 'Box thread', permission: 'auto', cwd: '/srv/agents/work/temp-code', status: 'running', archived: false, provider: 'claude' } as unknown as SessionMeta

/** A fake Mac on an in-process link: serves thread.* calls through `handler`. */
function mac(calls: PeerCalls, envId: string, handler: PeerCallHandler, connection: number) {
  const socket: PeerSocket & { remote: boolean } = {
    connection,
    keyId: 'k',
    remote: true,
    send: (frame: ServerFrame) => {
      if (!('push' in frame) || frame.push !== 'peer.call') return
      void servePeerCall(frame as Call, envId, handler, request)
    }
  }
  const request = async (method: string, p?: unknown): Promise<unknown> =>
    handlePeerRequest(calls, socket, { method, params: p } as Parameters<typeof handlePeerRequest>[2])
  handlePeerRequest(calls, socket, { method: 'peer.register', params: { from: envId, offers: ['mac-bridge', CROSS_HOST_OFFER] } })
  return socket
}

function setup(opts: { bridged?: string | null } = {}) {
  const calls = new PeerCalls(BOX, () => {})
  const settings = new Map<string, string>()
  const appended: unknown[] = []
  const reports: unknown[] = []
  const seen: { method: string; params: CrossHostCallParams }[] = []
  let n = 0
  const states = new Map<string, { status: string; title: string }>()
  let waitGate: (() => void) | null = null
  const handler: PeerCallHandler = async (method, params) => {
    const p = params as CrossHostCallParams
    seen.push({ method, params: p })
    const a = p.args as Record<string, unknown>
    switch (method) {
      case 'thread.start':
      case 'thread.spawn': {
        const id = `mac${++n}`
        states.set(id, { status: 'running', title: (a.title as string) ?? 'Started' })
        return { sessionId: id, title: states.get(id)!.title, cwd: '/Users/landon/IdeaProjects/temp-code', projectId: 'p1', ...(a.cwd === '/nowhere' ? { cwdNote: 'work root' } : {}) }
      }
      case 'thread.send':
      case 'thread.interrupt':
        return { ok: true }
      case 'thread.answer':
        return { ok: true, kind: a.allow !== undefined ? 'approval' : 'question' }
      case 'thread.list':
        return (a.sessionIds as string[]).map((id) => ({ sessionId: id, ...states.get(id), provider: 'claude', model: 'm', agentType: 'implementer', threadType: null, cwd: '/x', idleForSeconds: 1, parentSessionId: 'box-thread' }))
      case 'thread.check':
        return { sessionId: a.sessionId, ...states.get(a.sessionId as string), provider: 'claude', model: 'm', agentType: 'implementer', threadType: null, cwd: '/x', idleForSeconds: 2, parentSessionId: null, currentTurn: { toolCalls: [], lastText: 'hi' }, pending: null, tasks: null }
      case 'thread.wait': {
        const s = states.get(a.sessionId as string)!
        if (s.status === 'running') await new Promise<void>((r) => (waitGate = r))
        const now = states.get(a.sessionId as string)!
        return { sessionId: a.sessionId, status: now.status, settled: now.status !== 'running', reply: now.status === 'idle' ? 'all done' : '', pending: null, title: now.title }
      }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  const socket = mac(calls, MAC, handler, 1)
  const agents = new CrossHostAgents({
    environmentId: BOX,
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    sessions: {
      get: (id) => (id === parent.id ? parent : null),
      append: (_id, event) => appended.push(event),
      deliverAgentReport: (_id, report) => reports.push(report)
    },
    calls,
    macPeerOf: () => opts.bridged ?? null,
    hostName: (id) => (id === MAC ? 'Landon Mac' : null),
    workRoot: () => '/srv/agents/work',
    log: () => {}
  })
  const settle = (id: string, status = 'idle'): void => {
    states.set(id, { ...states.get(id)!, status })
    waitGate?.()
    waitGate = null
  }
  return { agents, calls, settings, appended, reports, seen, socket, settle, states }
}

describe('CrossHostAgents: which Mac', () => {
  it('an explicit id must be registered with the threads offer; `mac` and nothing mean the bridge peer, else the only Mac', () => {
    const { agents } = setup()
    expect(agents.resolveHost('box-thread', MAC)).toBe(MAC)
    expect(() => agents.resolveHost('box-thread', MAC2)).toThrow('Mac offline')
    expect(agents.resolveHost('box-thread', 'mac')).toBe(MAC)
    expect(agents.resolveHost('box-thread')).toBe(MAC)
  })
  it("the thread's bridge peer wins when set", () => {
    const { agents, calls } = setup({ bridged: MAC2 })
    expect(() => agents.resolveHost('box-thread', 'mac')).toThrow(`Mac offline: ${MAC2}`)
    mac(calls, MAC2, async () => ({}), 2)
    expect(agents.resolveHost('box-thread', 'mac')).toBe(MAC2)
    expect(agents.resolveHost('box-thread', MAC)).toBe(MAC)
  })
  it('no Mac, or several with none chosen, refuses naming macBridge.thread.set', () => {
    const { agents, calls } = setup()
    mac(calls, MAC2, async () => ({}), 2)
    expect(() => agents.resolveHost('box-thread')).toThrow('macBridge.thread.set')
    calls.drop(1)
    calls.drop(2)
    expect(() => agents.resolveHost('box-thread')).toThrow('no Mac is linked')
  })
})

describe('CrossHostAgents: start, spawn, supervise', () => {
  it('startThread answers an encoded id with the host, and records the thread', async () => {
    const { agents, settings, seen } = setup()
    const r = await agents.startThread(parent, 'mac', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/srv/agents/work/temp-code' })
    expect(r).toMatchObject({ threadId: encodeAgentId(MAC, 'mac1'), host: MAC, cwd: '/Users/landon/IdeaProjects/temp-code', projectId: 'p1' })
    const call = seen[0]
    expect(call.method).toBe('thread.start')
    expect(call.params.caller).toEqual({ environmentId: BOX, sessionId: 'box-thread', title: 'Box thread', permission: 'auto' })
    expect(call.params.args).toMatchObject({ cwd: '/srv/agents/work/temp-code', workRoot: '/srv/agents/work', firstMessage: 'go' })
    expect(JSON.parse(settings.get(`${CHILDREN_PREFIX}box-thread`)!)).toMatchObject([{ environmentId: MAC, sessionId: 'mac1', kind: 'started' }])
  })
  it('spawn records the children, appends agent-spawned with the host, and carries the cwd note', async () => {
    const { agents, appended, states } = setup()
    const spec = { provider: 'claude' as const, model: 'claude-sonnet-5-5', reasoning: 'medium' as const, context1m: false, agentType: 'implementer' as const, task: 'first line\nmore', useWorktree: true, preamble: true }
    const started = await agents.spawn(parent, MAC, [spec, { ...spec, task: 'second' }])
    expect(started.map((s) => s.agentId)).toEqual([encodeAgentId(MAC, 'mac1'), encodeAgentId(MAC, 'mac2')])
    expect(states.get('mac1')?.title).toBe('first line')
    expect(appended).toEqual([
      { type: 'agent-spawned', childSessionId: 'mac1', environmentId: MAC },
      { type: 'agent-spawned', childSessionId: 'mac2', environmentId: MAC }
    ])
    expect(agents.children('box-thread')).toHaveLength(2)
  })
  it('send, check, interrupt and answer route by the encoded id and refuse an id this thread did not spawn', async () => {
    const { agents, seen } = setup()
    const [{ agentId }] = await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    expect(await agents.send(parent, agentId, 'more')).toBe('sent')
    expect(seen.at(-1)).toMatchObject({ method: 'thread.send', params: { args: { sessionId: 'mac1', message: 'more' } } })
    expect(JSON.parse(await agents.check(parent, agentId))).toMatchObject({ agentId, host: MAC, status: 'running', currentTurn: { lastText: 'hi' } })
    expect(await agents.interrupt(parent, agentId)).toContain('interrupted')
    expect(await agents.answer(parent, agentId, 'r1', undefined, true)).toContain('allowed')
    expect(await agents.answer(parent, agentId, 'q1', [['a']])).toContain('answered')
    expect(await agents.send(parent, encodeAgentId(MAC, 'other'), 'x')).toContain('not a subagent')
    expect(agents.isRemote(agentId)).toBe(true)
    expect(agents.isRemote('local-id')).toBe(false)
  })
  it('wait blocks until the Mac reports the thread settled, then answers its reply', async () => {
    const { agents, settle } = setup()
    const [{ agentId }] = await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    const waiting = agents.wait(parent, agentId, 0)
    await new Promise((r) => setTimeout(r, 20))
    settle('mac1')
    expect(await waiting).toMatchObject({ agentId, status: 'idle', reply: 'all done' })
    expect(agents.children('box-thread')[0].status).toBe('idle')
  })
  it('a link that drops mid-wait answers the last known state with linkDown instead of hanging', async () => {
    const { agents, calls } = setup()
    const [{ agentId }] = await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    const waiting = agents.wait(parent, agentId, 0)
    await new Promise((r) => setTimeout(r, 20))
    calls.drop(1)
    const r = await waiting
    expect(r).toMatchObject({ agentId, status: 'running', linkDown: true })
    expect((r as { note: string }).note).toContain('Landon Mac')
    // Off the link, list and check carry the last state and linkDown.
    const list = await agents.list(parent)
    expect(list[0]).toMatchObject({ agentId, host: MAC, status: 'running', linkDown: true })
    expect(JSON.parse(await agents.check(parent, agentId))).toMatchObject({ status: 'running', linkDown: true })
  })
  it('list reads live state when the link is up', async () => {
    const { agents, settle } = setup()
    const [{ agentId }] = await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    settle('mac1', 'waiting')
    const list = await agents.list(parent)
    expect(list).toEqual([expect.objectContaining({ agentId, host: MAC, status: 'waiting', idleForSeconds: 1, kind: 'spawned' })])
  })
  it('a settle the Mac reports wakes the parent unless a wait covers it', async () => {
    const { agents, reports, settle } = setup()
    const [{ agentId }] = await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    const report = { from: MAC, sessionId: 'mac1', parentSessionId: 'box-thread', title: 't', status: 'idle', reply: 'done', pending: null }
    expect(() => agents.settled(MAC2, report)).toThrow('another host')
    agents.settled(MAC, { ...report, sessionId: 'unknown' })
    expect(reports).toHaveLength(0)
    const waiting = agents.wait(parent, agentId, 0)
    await new Promise((r) => setTimeout(r, 20))
    agents.settled(MAC, report)
    expect(reports).toHaveLength(0)
    settle('mac1')
    await waiting
    agents.settled(MAC, report)
    expect(reports).toHaveLength(1)
    expect(reports[0]).toMatchObject({ agentId, status: 'idle' })
    expect((reports[0] as { text: string }).text).toContain('on host Landon Mac')
  })
})
