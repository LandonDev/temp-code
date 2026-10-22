import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { MacBridgePush } from '@shared/contract-macbridge'
import { CROSS_HOST_OFFER, encodeAgentId, type CrossHostCallParams } from '@shared/contract-crosshost'
import type { SessionMeta } from '@shared/events'
import type { ProjectLinkFacts } from '@shared/projectLinks'
import { CHILDREN_PREFIX, CrossHostAgents, type RemoteLanding } from './crossHostAgents'
import { HostLinks } from './remote/hostLinks'
import { PeerCalls, handlePeerRequest, servePeerCall, type LinkRequest, type PeerCallHandler, type PeerSocket } from './remote/peerCalls'

type Call = Extract<MacBridgePush, { push: 'peer.call' }>
const MAC = `env_${'m'.repeat(22)}`
const MAC2 = `env_${'n'.repeat(22)}`
const BOX = `env_${'b'.repeat(22)}`
const BOX2 = `env_${'x'.repeat(22)}`

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

function setup(
  opts: {
    bridged?: string | null
    linked?: Record<string, LinkRequest | null>
    parent?: SessionMeta
    landing?: (l: RemoteLanding) => { hold: boolean }
    projectLink?: (projectId: string) => ProjectLinkFacts | null
  } = {}
) {
  const calls = new PeerCalls(BOX, () => {})
  const settings = new Map<string, string>()
  const appended: unknown[] = []
  const reports: unknown[] = []
  const changed: string[] = []
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
      case 'thread.read':
        if (a.sessionId === 'gone') throw new Error('unknown thread: gone')
        return { sessionId: a.sessionId, title: 'Mac thread', projectName: 'temp-code', digest: '# Mac thread' }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  const socket = mac(calls, MAC, handler, 1)
  const linked = opts.linked ?? {}
  const me = opts.parent ?? parent
  const agents = new CrossHostAgents({
    environmentId: BOX,
    store: { getSetting: (k) => settings.get(k) ?? null, setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)) },
    sessions: {
      get: (id) => (id === me.id ? me : null),
      append: (_id, event) => appended.push(event),
      deliverAgentReport: (_id, report) => reports.push(report)
    },
    links: new HostLinks({ calls, offer: CROSS_HOST_OFFER, link: (id) => linked[id] ?? null, linkIds: () => Object.keys(linked) }),
    link: (id) => linked[id] ?? null,
    macPeerOf: () => opts.bridged ?? null,
    hostName: (id) => (id === MAC ? 'Landon Mac' : id === BOX2 ? 'The box' : null),
    workRoot: () => '/srv/agents/work',
    landing: opts.landing,
    ...(opts.projectLink ? { projectLink: opts.projectLink } : {}),
    batchChanged: (id) => changed.push(id),
    log: () => {}
  })
  const settle = (id: string, status = 'idle'): void => {
    states.set(id, { ...states.get(id)!, status })
    waitGate?.()
    waitGate = null
  }
  return { agents, calls, settings, appended, reports, seen, socket, settle, states, changed, handler }
}

describe('CrossHostAgents: which Mac', () => {
  it('an explicit id must be registered with the threads offer; `mac` and nothing mean the bridge peer, else the only Mac', () => {
    const { agents } = setup()
    expect(agents.resolveHost('box-thread', MAC)).toBe(MAC)
    expect(() => agents.resolveHost('box-thread', MAC2)).toThrow('offline')
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

// ── the other direction: a host linked from here, and the batch index ──

const master = { id: 'master-1', title: 'Master', permission: 'auto', cwd: '/srv/agents/work/temp-code', status: 'watching', archived: false, provider: 'claude', isMaster: true, parentId: null, masterId: null } as unknown as SessionMeta

/** A fake box on a link from here: answers thread.* requests the way the box's listener would. */
function linkedBox(opts: { down?: () => boolean; refuseAdopt?: string } = {}) {
  const seen: { method: string; params: { caller: { environmentId: string; sessionId: string }; args: Record<string, unknown> } }[] = []
  const states = new Map<string, { status: string; title: string }>()
  let n = 0
  const request: LinkRequest = async (method, params) => {
    if (opts.down?.()) throw new Error('socket closed')
    const p = params as (typeof seen)[number]['params']
    seen.push({ method, params: p })
    const a = p.args
    switch (method) {
      case 'thread.start': {
        const id = `box${++n}`
        states.set(id, { status: 'running', title: (a.title as string) ?? 'Started' })
        return { sessionId: id, title: states.get(id)!.title, cwd: '/srv/agents/work/temp-code', projectId: 'bp1' }
      }
      case 'thread.list':
        return (a.sessionIds as string[]).map((id) => ({ sessionId: id, ...states.get(id), provider: 'claude', model: 'm', agentType: 'implementer', threadType: 'implementation', cwd: '/x', idleForSeconds: 1, parentSessionId: null }))
      case 'thread.adopt':
        if (opts.refuseAdopt) throw new Error(opts.refuseAdopt)
        states.set(a.sessionId as string, { status: 'running', title: 'Loose on the box' })
        return { ok: true, sessionId: a.sessionId, title: 'Loose on the box', provider: 'codex', model: 'gpt', agentType: 'implementer', threadType: 'chat', status: 'running', cwd: '/x', idleForSeconds: 0, parentSessionId: null }
      case 'thread.pause':
      case 'thread.resume':
      case 'thread.archive':
      case 'thread.send':
        return { ok: true }
      default:
        throw new Error(`unexpected ${method}`)
    }
  }
  return { request, seen, states }
}

describe('CrossHostAgents: an @thread reference to another host', () => {
  it('reads any thread there with thread.read, naming the host; this host answers null', async () => {
    const { agents, seen } = setup()
    expect(await agents.readThread(parent, MAC, 'any-thread')).toEqual({
      ok: true,
      hostName: 'Landon Mac',
      sessionId: 'any-thread',
      title: 'Mac thread',
      projectName: 'temp-code',
      digest: '# Mac thread'
    })
    expect(seen.at(-1)).toMatchObject({ method: 'thread.read', params: { caller: { environmentId: BOX, sessionId: 'box-thread' }, args: { sessionId: 'any-thread' } } })
    expect(await agents.readThread(parent, BOX, 'local')).toBeNull()
  })

  it('a host out of reach, or one that refuses, answers ok: false with why', async () => {
    const { agents } = setup()
    const down = await agents.readThread(parent, MAC2, 'x')
    expect(down).toMatchObject({ ok: false, hostName: MAC2 })
    expect(down && !down.ok && down.why).toContain('offline')
    expect(await agents.readThread(parent, MAC, 'gone')).toMatchObject({ ok: false, hostName: 'Landon Mac', why: expect.stringContaining('unknown thread') })
  })
})

describe('CrossHostAgents: the Mac asking the box over its own link', () => {
  it('`box` means the one host linked from here; an id linked from here works too; `mac` still means a host registered here', () => {
    const box = linkedBox()
    const { agents } = setup({ linked: { [BOX2]: box.request } })
    expect(agents.resolveHost('box-thread', 'box')).toBe(BOX2)
    expect(agents.resolveHost('box-thread', BOX2)).toBe(BOX2)
    expect(agents.resolveHost('box-thread', 'mac')).toBe(MAC)
    // Nothing named, two hosts reachable: the refusal names both.
    expect(() => agents.resolveHost('box-thread')).toThrow('several hosts are linked')
    expect(agents.hostsOnline()).toEqual([
      { id: MAC, name: 'Landon Mac', alias: 'mac' },
      { id: BOX2, name: 'The box', alias: 'box' }
    ])
    expect(agents.hostsLine()).toBe(`mac = Landon Mac (${MAC}), box = The box (${BOX2})`)
  })
  it('`box` with no link from here, or several, refuses with what to do', () => {
    const { agents } = setup()
    expect(() => agents.resolveHost('box-thread', 'box')).toThrow('no host is linked from here')
    const two = setup({ linked: { [BOX2]: linkedBox().request, [MAC2]: linkedBox().request } })
    expect(() => two.agents.resolveHost('box-thread', 'box')).toThrow('several hosts are linked from here')
  })
  it('startThread on the box goes as a thread.start request on the link with the caller inside, and records the thread', async () => {
    const box = linkedBox()
    const { agents, settings } = setup({ linked: { [BOX2]: box.request } })
    const r = await agents.startThread(parent, 'box', { threadType: 'implementation', provider: 'codex', firstMessage: 'build it', cwd: '/Users/landon/IdeaProjects/temp-code' })
    expect(r).toMatchObject({ threadId: encodeAgentId(BOX2, 'box1'), host: BOX2, cwd: '/srv/agents/work/temp-code' })
    expect(box.seen[0]).toMatchObject({ method: 'thread.start', params: { caller: { environmentId: BOX, sessionId: 'box-thread' }, args: { cwd: '/Users/landon/IdeaProjects/temp-code', workRoot: '/srv/agents/work' } } })
    expect(JSON.parse(settings.get(`${CHILDREN_PREFIX}box-thread`)!)).toMatchObject([{ environmentId: BOX2, sessionId: 'box1', kind: 'started', threadType: 'implementation' }])
    expect(await agents.send(parent, r.threadId, 'more')).toBe('sent')
    expect(box.seen.at(-1)?.method).toBe('thread.send')
  })
})

describe('CrossHostAgents: a master\'s batch across hosts', () => {
  it('a thread a master starts on another host carries the masterId there and is indexed under the master here', async () => {
    const box = linkedBox()
    const { agents, changed } = setup({ linked: { [BOX2]: box.request }, parent: master })
    const r = await agents.startThread(master, 'box', { threadType: 'implementation', provider: 'codex', firstMessage: 'go', cwd: '/Users/landon/IdeaProjects/temp-code' })
    expect(box.seen[0].params.args.masterId).toBe('master-1')
    expect(agents.batchChildren('master-1')).toEqual([expect.objectContaining({ environmentId: BOX2, sessionId: 'box1', masterId: 'master-1', status: 'running' })])
    expect(changed).toEqual(['master-1'])
    // refresh reads the host's state and touches the record; a changed status tells the engine.
    box.states.set('box1', { status: 'idle', title: 'Started' })
    const refreshed = await agents.refreshBatch('master-1')
    expect(refreshed.unreachable).toEqual([])
    expect(refreshed.children[0].status).toBe('idle')
    expect(changed).toEqual(['master-1', 'master-1'])
    // A settle for the thread (its starter as the parent) touches the record and wakes the master.
    const { reports } = setup({ linked: { [BOX2]: box.request }, parent: master })
    void reports
    expect(r.threadId).toBe(encodeAgentId(BOX2, 'box1'))
  })
  it('refresh names a host out of reach and keeps the last state; batchAction pauses, resumes and archives on the host, and archive leaves the index', async () => {
    const box = linkedBox()
    const linked: Record<string, LinkRequest | null> = { [BOX2]: box.request }
    const { agents } = setup({ linked, parent: master })
    await agents.startThread(master, 'box', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/x' })
    linked[BOX2] = null
    const r = await agents.refreshBatch('master-1')
    expect(r.unreachable).toEqual([BOX2])
    expect(r.children[0].status).toBe('running')
    const failed = await agents.batchAction('master-1', 'pause')
    expect(failed.failed[0].error).toContain('the link to The box is down')
    linked[BOX2] = box.request
    expect(await agents.batchAction('master-1', 'pause')).toEqual({ succeeded: [encodeAgentId(BOX2, 'box1')], failed: [] })
    expect(box.seen.at(-1)).toMatchObject({ method: 'thread.pause', params: { caller: { sessionId: 'master-1' }, args: { sessionId: 'box1' } } })
    await agents.batchAction('master-1', 'resume')
    expect(box.seen.at(-1)?.method).toBe('thread.resume')
    expect(await agents.batchAction('master-1', 'archive')).toEqual({ succeeded: [encodeAgentId(BOX2, 'box1')], failed: [] })
    expect(agents.batchChildren('master-1')).toEqual([])
    expect(agents.children('master-1')[0]).toMatchObject({ sessionId: 'box1', status: 'done' })
    expect(agents.children('master-1')[0].masterId).toBeUndefined()
  })
  it('adopt takes a `<env>:<id>` root on its host into the batch, records it, and answers refusals per id', async () => {
    const box = linkedBox()
    const { agents } = setup({ linked: { [BOX2]: box.request }, parent: master })
    const r = await agents.adopt(master, [encodeAgentId(BOX2, 'loose'), 'plain-id', encodeAgentId(MAC2, 'elsewhere')])
    expect(r.adopted).toEqual([encodeAgentId(BOX2, 'loose')])
    expect(r.refused).toEqual([
      { sessionId: 'plain-id', why: 'not a thread on another host' },
      { sessionId: encodeAgentId(MAC2, 'elsewhere'), why: expect.stringContaining('is down') }
    ])
    expect(box.seen[0]).toMatchObject({ method: 'thread.adopt', params: { caller: { sessionId: 'master-1' }, args: { sessionId: 'loose', masterId: 'master-1' } } })
    expect(agents.batchChildren('master-1')).toEqual([expect.objectContaining({ sessionId: 'loose', title: 'Loose on the box', provider: 'codex', masterId: 'master-1' })])
    const refused = setup({ linked: { [BOX2]: linkedBox({ refuseAdopt: 'it is a subagent' }).request }, parent: master })
    expect((await refused.agents.adopt(master, [encodeAgentId(BOX2, 'sub')])).refused).toEqual([{ sessionId: encodeAgentId(BOX2, 'sub'), why: 'it is a subagent' }])
  })
  it('a landing report from the host reaches the engine with the batch child named; an unknown thread is refused', async () => {
    const box = linkedBox()
    const landings: RemoteLanding[] = []
    const { agents } = setup({ linked: { [BOX2]: box.request }, parent: master, landing: (l) => (landings.push(l), { hold: l.phase === 'ask' }) })
    await agents.startThread(master, 'box', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/x' })
    const report = { from: BOX2, sessionId: 'box1', masterId: 'master-1', phase: 'ask' as const, branch: 'feat', target: 'master', subjects: ['one'] }
    expect(agents.landing(BOX2, report)).toEqual({ hold: true })
    expect(agents.landing(BOX2, { ...report, phase: 'landed', sha: 'abc' })).toEqual({ hold: false })
    expect(landings).toEqual([
      expect.objectContaining({ masterId: 'master-1', environmentId: BOX2, sessionId: 'box1', phase: 'ask', branch: 'feat' }),
      expect.objectContaining({ phase: 'landed', sha: 'abc' })
    ])
    expect(() => agents.landing(BOX2, { ...report, sessionId: 'nope' })).toThrow('is not a thread of the batch')
    expect(() => agents.landing(MAC, report)).toThrow('another host')
  })
  it('a settle for a started thread names its starter as the parent: the record moves and the starter is woken', async () => {
    const box = linkedBox()
    const { agents, reports, changed } = setup({ linked: { [BOX2]: box.request }, parent: master })
    await agents.startThread(master, 'box', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/x' })
    agents.settled(BOX2, { from: BOX2, sessionId: 'box1', parentSessionId: 'master-1', title: 'Started', status: 'idle', reply: 'done here', pending: null })
    expect(agents.batchChildren('master-1')[0].status).toBe('idle')
    expect(changed).toEqual(['master-1', 'master-1'])
    expect(reports).toHaveLength(1)
    expect((reports[0] as { text: string }).text).toContain('on host The box')
  })
  it("a report pushed down this host's link as a peer.call is served and answered on it", async () => {
    const box = linkedBox()
    const replies: { method: string; params: unknown }[] = []
    const linkedWithReplies: LinkRequest = async (method, params, opts) => {
      if (method.startsWith('peer.')) {
        replies.push({ method, params })
        return { ok: true }
      }
      return box.request(method, params, opts)
    }
    const landings: RemoteLanding[] = []
    const { agents } = setup({ linked: { [BOX2]: linkedWithReplies }, parent: master, landing: (l) => (landings.push(l), { hold: false }) })
    await agents.startThread(master, 'box', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/x' })
    const push = { push: 'peer.call' as const, callId: 'c9', method: 'crossHost.landing', params: { from: BOX2, sessionId: 'box1', masterId: 'master-1', phase: 'landed', branch: 'b', target: 'master', subjects: [], sha: 'abc' }, deadlineMs: 10_000 }
    expect(agents.onPeerPush(BOX2, push as never)).toBe(true)
    await new Promise((r) => setTimeout(r, 5))
    expect(landings).toHaveLength(1)
    expect(replies).toEqual([{ method: 'peer.reply', params: { callId: 'c9', ok: true, result: { hold: false } } }])
    expect(agents.onPeerPush(BOX2, { push: 'peer.call', callId: 'c1', method: 'mac.run', params: {}, deadlineMs: 1 } as never)).toBe(false)
  })
})

describe("CrossHostAgents: the caller's project rides along", () => {
  /** The registry's projectLinkFacts over one row: ids minted on first use, then kept. */
  function rows() {
    const row = { id: 'proj-1', name: 'Alpha', branch: 'tc/alpha', mode: 'worktree' as const, cwd: '/srv/agents/home/.temp-code/worktrees/alpha', linkId: null as string | null }
    const workspace = { path: '/srv/agents/work/alpha', linkId: null as string | null, githubRepo: 'LandonDev/alpha' }
    const minted: string[] = []
    const projectLink = (projectId: string): ProjectLinkFacts | null => {
      if (projectId !== row.id) return null
      if (!workspace.linkId) minted.push((workspace.linkId = 'wl_1'))
      if (!row.linkId) minted.push((row.linkId = 'pl_1'))
      return { linkId: row.linkId, workspaceLinkId: workspace.linkId, name: row.name, branch: row.branch, mode: row.mode, workspacePath: workspace.path, cwd: row.cwd, workspaceGithubRepo: workspace.githubRepo }
    }
    return { projectLink, minted }
  }

  it('startThread sends the named project row, not the session cwd; spawn sends the parent project; the ids are minted once', async () => {
    const { projectLink, minted } = rows()
    const inProject = { ...parent, projectId: 'proj-1', cwd: '/srv/agents/work/temp-code/.claude/worktrees/x' } as SessionMeta
    const { agents, seen } = setup({ projectLink, parent: inProject })
    await agents.startThread(inProject, 'mac', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/srv/agents/home/.temp-code/worktrees/alpha', projectId: 'proj-1' })
    await agents.spawn(inProject, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    const [start, spawn] = seen.map((c) => c.params.args as Record<string, unknown>)
    const facts = { linkId: 'pl_1', workspaceLinkId: 'wl_1', name: 'Alpha', branch: 'tc/alpha', mode: 'worktree', workspacePath: '/srv/agents/work/alpha', cwd: '/srv/agents/home/.temp-code/worktrees/alpha', workspaceGithubRepo: 'LandonDev/alpha' }
    expect(start.project).toEqual(facts)
    expect(start).not.toHaveProperty('projectId')
    expect(spawn.project).toEqual(facts)
    expect(minted).toEqual(['wl_1', 'pl_1'])
  })

  it('no project, or one this host does not have: no facts, the path decides on the far host', async () => {
    const { projectLink } = rows()
    const { agents, seen } = setup({ projectLink })
    await agents.startThread(parent, 'mac', { threadType: 'chat', provider: 'claude', firstMessage: 'go', cwd: '/srv/agents/work/temp-code', projectId: 'gone' })
    await agents.spawn(parent, MAC, [{ provider: 'claude', model: 'm', reasoning: 'medium', context1m: false, agentType: 'explorer', task: 't', useWorktree: false, preamble: true }])
    for (const call of seen) expect(call.params.args).not.toHaveProperty('project')
  })
})
