import { describe, expect, it } from 'vitest'
import type { HostPresence, RelayFacadeResult, RelayPrincipal } from '@shared/contract-relay'
import { FacadeError, type SessionRow } from './facade'
import { INSTRUCTIONS, mergeSessions, prefixIds, routeOf, runTool, type ToolDeps } from './mcp'
import type { RelayFacadeHosts } from './relay'

const T0 = Date.UTC(2026, 2, 4, 9, 14)
const MAC = 'env_mac0000000000000000000'
const LAPTOP = 'env_lap0000000000000000000'
const SLEEPY = 'env_slp0000000000000000000'
const GONE = 'env_gon0000000000000000000'
const BOX = 'env_box0000000000000000000'

const host = (environmentId: string, name: string, over: Partial<HostPresence> = {}): HostPresence => ({
  environmentId,
  name,
  platform: 'darwin',
  link: 'up',
  since: T0,
  screen: 'unlocked',
  power: 'awake',
  lastSeenAt: T0,
  build: null,
  ...over
})

const row = (id: string, status: SessionRow['status'], lastActivity: string): SessionRow => ({
  id,
  title: `T ${id}`,
  type: 'chat',
  repo: 'repo',
  project: null,
  branch: null,
  provider: 'claude',
  model: 'claude-haiku-5-5',
  status,
  state: status === 'working' ? 'running' : 'idle',
  pending: null,
  queued: 0,
  archived: false,
  lastActivity,
  host: 'local',
  url: 'http://x/ui#thread=' + id
})

/** A fake relay: four hosts in the four states; `call` answers what the test scripted per host, else the refusal the real HostRelay would. */
function fakeRelay(answers: Record<string, (name: string, args: unknown) => RelayFacadeResult> = {}) {
  const rows = [host(MAC, 'Studio'), host(LAPTOP, 'Laptop', { screen: 'locked' }), host(SLEEPY, 'Sleepy', { power: 'asleep' }), host(GONE, 'Gone', { link: 'down' })]
  const calls: { envId: string; name: string; args: unknown; principal: RelayPrincipal }[] = []
  const relay: RelayFacadeHosts = {
    list: () => rows,
    call: async (envId, principal, name, args) => {
      calls.push({ envId, name, args, principal })
      const r = rows.find((h) => h.environmentId === envId)
      if (!r) return { ok: false, code: 'not_found', message: `no host "${envId}"` }
      if (r.link === 'down') return { ok: false, code: 'unavailable', message: 'unavailable: the Mac is unreachable since 09:14' }
      if (r.power === 'asleep') return { ok: false, code: 'unavailable', message: 'unavailable: the Mac is asleep' }
      const scripted = answers[envId]
      return scripted ? scripted(name, args) : { ok: true, result: { echoed: name, args } }
    }
  }
  return { relay, calls, rows }
}

function deps(relay: RelayFacadeHosts | undefined, local: ToolDeps['local'] = async (name, args) => ({ local: name, args })): ToolDeps {
  return {
    environmentId: BOX,
    hostName: 'The box',
    relay,
    principal: { keyId: 'b1', name: 'Bot', audience: 'mcp', caps: ['read', 'operate'] },
    local
  }
}

describe('routeOf', () => {
  const { relay } = fakeRelay()
  it('goes local without a host or a plain session, and strips host from the args', () => {
    expect(routeOf(deps(relay), { session: 'abc' })).toEqual({ target: { kind: 'local' }, args: { session: 'abc' }, explicit: false })
    expect(routeOf(deps(relay), { host: BOX, limit: 3 })).toEqual({ target: { kind: 'local' }, args: { limit: 3 }, explicit: true })
    expect(routeOf(deps(relay), { host: 'the box' })).toEqual({ target: { kind: 'local' }, args: {}, explicit: true })
  })
  it('routes by a host id or name, case-insensitive, and by a prefixed session', () => {
    expect(routeOf(deps(relay), { host: MAC })).toEqual({ target: { kind: 'remote', envId: MAC }, args: {}, explicit: true })
    expect(routeOf(deps(relay), { host: 'studio' })).toEqual({ target: { kind: 'remote', envId: MAC }, args: {}, explicit: true })
    expect(routeOf(deps(relay), { session: `${MAC}:s1` })).toEqual({ target: { kind: 'remote', envId: MAC }, args: { session: 's1' }, explicit: false })
    expect(routeOf(deps(relay), { session: `${BOX}:s1` })).toEqual({ target: { kind: 'local' }, args: { session: 's1' }, explicit: false })
    expect(routeOf(deps(relay), { host: 'Studio', session: `${MAC}:s1` })).toEqual({ target: { kind: 'remote', envId: MAC }, args: { session: 's1' }, explicit: true })
  })
  it('refuses an unknown host, a prefixed session of an unknown host, and a host that contradicts the session', () => {
    expect(() => routeOf(deps(relay), { host: 'nowhere' })).toThrow('no host "nowhere" is known here; list_projects names the hosts')
    expect(() => routeOf(deps(relay), { session: 'env_xxx0000000000000000000:s1' })).toThrow(/no host "env_xxx0000000000000000000"/)
    expect(() => routeOf(deps(relay), { host: 'Laptop', session: `${MAC}:s1` })).toThrow(/lives on/)
    // without a relay every host but this one is unknown
    expect(() => routeOf(deps(undefined), { host: 'Studio' })).toThrow(/no host/)
  })
})

describe('prefixIds', () => {
  it('prefixes every id and session, stamps the host, drops url', () => {
    const r = row('s1', 'working', '2026-03-04T09:00:00.000Z')
    expect(prefixIds({ sessions: [r], cursor: 'c' }, MAC)).toEqual({ sessions: [{ ...r, id: `${MAC}:s1`, host: MAC, url: undefined }], cursor: 'c' })
    expect((prefixIds({ sessions: [r], cursor: null }, MAC) as { sessions: SessionRow[] }).sessions[0]).not.toHaveProperty('url')
    expect(prefixIds({ ...r, cwd: '/x' }, MAC)).toMatchObject({ id: `${MAC}:s1`, host: MAC, cwd: '/x' })
    expect(prefixIds({ ...r, prompts: [{ session: 's1', requestId: 'r', kind: 'question', seq: 1, summary: '?' }] }, MAC)).toMatchObject({
      id: `${MAC}:s1`,
      prompts: [{ session: `${MAC}:s1`, requestId: 'r' }]
    })
    expect(prefixIds({ pending: [{ session: 's1', requestId: 'r' }, { session: 's2', requestId: 'q' }] }, MAC)).toEqual({
      pending: [{ session: `${MAC}:s1`, requestId: 'r' }, { session: `${MAC}:s2`, requestId: 'q' }]
    })
    expect(prefixIds({ session: 's1', status: 'working', text: '…', firstSeq: 1, lastSeq: 2 }, MAC)).toMatchObject({ session: `${MAC}:s1`, text: '…' })
    expect(prefixIds({ session: 's1', cwd: '/x', files: [] }, MAC)).toMatchObject({ session: `${MAC}:s1`, files: [] })
    expect(prefixIds({ hosts: [], repos: [{ id: 'w', name: 'r', host: MAC }] }, MAC)).toEqual({ hosts: [], repos: [{ id: 'w', name: 'r', host: MAC }] })
    expect(prefixIds(null, MAC)).toBeNull()
    expect(prefixIds('x', MAC)).toBe('x')
  })
})

describe('runTool', () => {
  it('a local call runs the local facade with host stripped; an explicit local host never merges', async () => {
    const { relay, calls } = fakeRelay()
    expect(await runTool(deps(relay), 'get_session', { session: 'abc' })).toEqual({ local: 'get_session', args: { session: 'abc' } })
    expect(await runTool(deps(relay), 'list_sessions', { host: 'The box', limit: 2 })).toEqual({ local: 'list_sessions', args: { limit: 2 } })
    expect(calls).toEqual([])
  })

  it('a relayed call goes to the host as the bot key, its answer comes back prefixed, and a refusal is a FacadeError', async () => {
    const { relay, calls } = fakeRelay({
      [MAC]: (name, args) =>
        name === 'get_session'
          ? { ok: true, result: { ...row((args as { session: string }).session, 'working', '2026-03-04T09:00:00.000Z'), cwd: '/mac' } }
          : { ok: false, code: 'not_found', message: 'no session "zzz". list_sessions shows the ids.' }
    })
    const out = (await runTool(deps(relay), 'get_session', { session: `${MAC}:s1` })) as Record<string, unknown>
    expect(out).toMatchObject({ id: `${MAC}:s1`, host: MAC, cwd: '/mac' })
    expect(out).not.toHaveProperty('url')
    expect(calls[0]).toMatchObject({ envId: MAC, name: 'get_session', args: { session: 's1' }, principal: { keyId: 'b1', audience: 'mcp' } })
    await expect(runTool(deps(relay), 'stop_session', { session: `${MAC}:zzz` })).rejects.toMatchObject({ code: 'not_found', message: 'no session "zzz". list_sessions shows the ids.' })
    await expect(runTool(deps(relay), 'get_session', { session: `${SLEEPY}:s1` })).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable: the Mac is asleep' })
    await expect(runTool(deps(relay), 'get_session', { host: 'Gone', session: 's1' })).rejects.toMatchObject({ code: 'unavailable', message: 'unavailable: the Mac is unreachable since 09:14' })
    // a locked host answers every tool
    expect(await runTool(deps(relay), 'get_transcript', { session: `${LAPTOP}:s9` })).toEqual({ echoed: 'get_transcript', args: { session: 's9' } })
  })

  it('a relayed error of the FacadeError kind reads as its message (what /mcp prints after "error: ")', async () => {
    const { relay } = fakeRelay()
    const err = await runTool(deps(relay), 'get_session', { session: `${GONE}:s1` }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FacadeError)
    expect((err as FacadeError).message).toBe('unavailable: the Mac is unreachable since 09:14')
  })

  it('list_projects merges the repos of every available host and lists every host with its state', async () => {
    const { relay, calls } = fakeRelay({
      [MAC]: () => ({ ok: true, result: { hosts: [{ environmentId: MAC, self: true }], repos: [{ id: 'w2', name: 'mac-repo', host: MAC, projects: [] }] } }),
      [LAPTOP]: () => ({ ok: true, result: { hosts: [], repos: [{ id: 'w3', name: 'lap-repo', host: LAPTOP, projects: [] }] } })
    })
    const local = async (): Promise<unknown> => ({ hosts: [{ environmentId: BOX, name: 'The box', self: true, state: 'available' }], repos: [{ id: 'w1', name: 'box-repo', host: BOX, projects: [] }] })
    const out = (await runTool(deps(relay, local), 'list_projects', {})) as { hosts: { environmentId: string; self: boolean; state: string }[]; repos: { id: string; host: string }[] }
    expect(out.hosts.map((h) => [h.environmentId, h.self, h.state])).toEqual([
      [BOX, true, 'available'],
      [MAC, false, 'available'],
      [LAPTOP, false, 'locked'],
      [SLEEPY, false, 'asleep'],
      [GONE, false, 'unreachable']
    ])
    // the locked host's repos are listed (it answers); the asleep and down hosts are not asked
    expect(out.repos.map((r) => [r.id, r.host])).toEqual([['w1', BOX], ['w2', MAC], ['w3', LAPTOP]])
    expect(calls.map((c) => c.envId).sort()).toEqual([LAPTOP, MAC].sort())
    // with a host, the one host's repos under this host's own host list
    const one = (await runTool(deps(relay, local), 'list_projects', { host: 'Studio' })) as { hosts: unknown[]; repos: { id: string }[] }
    expect(one.repos.map((r) => r.id)).toEqual(['w2'])
    expect(one.hosts).toHaveLength(5)
  })

  it('list_sessions without a host merges working-first, prefixes relayed ids, names the hosts that did not answer; cursor pages this host only', async () => {
    const { relay, calls } = fakeRelay({
      [MAC]: () => ({ ok: true, result: { sessions: [row('m1', 'working', '2026-03-04T08:00:00.000Z'), row('m2', 'done', '2026-03-04T09:30:00.000Z')], cursor: 'mac-cursor' } }),
      [LAPTOP]: () => ({ ok: true, result: { sessions: [row('l1', 'waiting', '2026-03-04T09:10:00.000Z')], cursor: null } })
    })
    const local = async (): Promise<unknown> => ({ sessions: [row('b1', 'working', '2026-03-04T09:20:00.000Z'), row('b2', 'done', '2026-03-04T07:00:00.000Z')], cursor: 'box-cursor' })
    const out = (await runTool(deps(relay, local), 'list_sessions', { limit: 10 })) as { sessions: SessionRow[]; cursor: string | null; unavailable: { host: string; name: string; reason: string }[] }
    expect(out.sessions.map((s) => s.id)).toEqual(['b1', `${MAC}:m1`, `${LAPTOP}:l1`, `${MAC}:m2`, 'b2'])
    expect(out.sessions.map((s) => s.host)).toEqual(['local', MAC, LAPTOP, MAC, 'local'])
    expect(out.cursor).toBe('box-cursor')
    expect(out.unavailable).toEqual([
      { host: SLEEPY, name: 'Sleepy', reason: 'unavailable: the Mac is asleep' },
      { host: GONE, name: 'Gone', reason: 'unavailable: the Mac is unreachable since 09:14' }
    ])
    expect(calls.map((c) => c.envId)).toEqual([MAC, LAPTOP, SLEEPY, GONE])
    calls.length = 0
    const paged = (await runTool(deps(relay, local), 'list_sessions', { cursor: 'box-cursor' })) as { sessions: SessionRow[] }
    expect(paged.sessions.map((s) => s.id)).toEqual(['b1', 'b2'])
    expect(calls).toEqual([])
    // with a host, that host's page alone, prefixed, cursor passed through
    const macOnly = (await runTool(deps(relay, local), 'list_sessions', { host: MAC, cursor: 'c2' })) as { sessions: SessionRow[]; cursor: string }
    expect(macOnly.sessions.map((s) => s.id)).toEqual([`${MAC}:m1`, `${MAC}:m2`])
    expect(macOnly.cursor).toBe('mac-cursor')
    expect(calls[0]).toMatchObject({ envId: MAC, args: { cursor: 'c2' } })
  })

  it('list_pending merges with prefixed sessions and the unavailable list', async () => {
    const { relay } = fakeRelay({ [MAC]: () => ({ ok: true, result: { pending: [{ session: 'm1', requestId: 'r1', kind: 'question' }] } }) })
    const local = async (): Promise<unknown> => ({ pending: [{ session: 'b1', requestId: 'r0', kind: 'permission' }] })
    const out = (await runTool(deps(relay, local), 'list_pending', {})) as { pending: { session: string }[]; unavailable: { host: string }[] }
    expect(out.pending.map((p) => p.session)).toEqual(['b1', `${MAC}:m1`])
    expect(out.unavailable.map((u) => u.host)).toEqual([SLEEPY, GONE])
    // a relayed answer that is not ok for a reason other than state still lands in unavailable
    const flaky = fakeRelay({ [MAC]: () => ({ ok: false, code: 'unavailable', message: 'unavailable: the host did not answer within 60 s' }) })
    const out2 = (await runTool(deps(flaky.relay, local), 'list_pending', {})) as { unavailable: { host: string; reason: string }[] }
    expect(out2.unavailable[0]).toEqual({ host: MAC, name: 'Studio', reason: 'unavailable: the host did not answer within 60 s' })
  })

  it('without a relay the list tools answer the local page alone', async () => {
    const local = async (): Promise<unknown> => ({ sessions: [row('b1', 'done', '2026-03-04T07:00:00.000Z')], cursor: null })
    expect(await runTool(deps(undefined, local), 'list_sessions', {})).toEqual({ sessions: [row('b1', 'done', '2026-03-04T07:00:00.000Z')], cursor: null })
  })

  it('mergeSessions puts working first, then the newest activity', () => {
    const rows = [row('a', 'done', '2026-03-04T09:00:00.000Z'), row('b', 'working', '2026-03-04T08:00:00.000Z'), row('c', 'waiting', '2026-03-04T10:00:00.000Z'), row('d', 'working', '2026-03-04T09:30:00.000Z')]
    expect(mergeSessions(rows).map((r) => r.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('the instructions name the hosts and the prefixed id', () => {
    expect(INSTRUCTIONS).toContain('Hosts: list_projects names every host reachable from here with its state; a session id of the form env_…:id lives on that host and routes there.')
  })
})
