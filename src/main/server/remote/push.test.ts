import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/events'
import type { HubAck } from '../hub'
import { ActivityFeed, activityPhase, PushRegistry, type PushHub } from './push'

function db(): DatabaseSync {
  const d = new DatabaseSync(':memory:')
  d.exec(`
    CREATE TABLE remote_push (key_id TEXT PRIMARY KEY, token TEXT NOT NULL, bundle_id TEXT NOT NULL, environment TEXT NOT NULL, events TEXT NOT NULL, relay TEXT NOT NULL, error TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE remote_push_activities (key_id TEXT NOT NULL, session_id TEXT NOT NULL, token TEXT NOT NULL, bundle_id TEXT NOT NULL, environment TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (key_id, session_id));
  `)
  return d
}

/** A hub that records every call and answers what the test set. */
function fakeHub(answer: () => HubAck = () => ({ ok: true })) {
  const calls: { method: string; args: unknown }[] = []
  const hub: PushHub = {
    async registerDevice(device) {
      calls.push({ method: 'registerDevice', args: device })
      return answer()
    },
    async removeDevice(deviceId) {
      calls.push({ method: 'removeDevice', args: deviceId })
      return answer()
    },
    async setActivity(activity) {
      calls.push({ method: 'setActivity', args: activity })
      return answer()
    },
    async removeActivity(deviceId, threadId) {
      calls.push({ method: 'removeActivity', args: { deviceId, threadId } })
      return answer()
    },
    async pushActivity(activity) {
      calls.push({ method: 'pushActivity', args: activity })
      return { delivered: 1, failed: 0 }
    }
  }
  return { hub, calls }
}

const TOKEN = 'AB'.repeat(32)
const registration = { token: TOKEN, bundleId: 'dev.landon.tempcode.ios', environment: 'sandbox' as const }

describe('PushRegistry', () => {
  it('keeps one registration per key, forwards it to the hub and reports the relay state', async () => {
    const { hub, calls } = fakeHub()
    const push = new PushRegistry(db(), { hub: () => hub, now: () => 1000, log: () => {} })
    expect(push.status('k1')).toEqual({ registered: false, relay: 'none', error: null, events: [], updatedAt: null })
    const status = await push.register('k1', { ...registration, events: ['needs_you', 'failed', 'needs_you'] })
    expect(status).toEqual({ registered: true, relay: 'ok', error: null, events: ['needs_you', 'failed'], updatedAt: 1000 })
    expect(calls).toEqual([
      { method: 'registerDevice', args: { deviceId: 'k1', token: TOKEN.toLowerCase(), bundleId: 'dev.landon.tempcode.ios', environment: 'sandbox', events: ['needs_you', 'failed'] } }
    ])
    // A rotated token replaces the row and the subscription under the same device id.
    const rotated = 'CD'.repeat(32)
    await push.register('k1', { ...registration, token: rotated })
    expect(calls).toHaveLength(2)
    expect(calls[1].args).toMatchObject({ deviceId: 'k1', token: rotated.toLowerCase(), events: ['needs_you', 'finished', 'failed', 'stuck', 'host_down', 'host_up'] })
    expect(push.status('k1').events).toHaveLength(6)
  })
  it('records a hub refusal on the row and offers it again at resync', async () => {
    let answer: HubAck = { ok: false, error: 'HTTP 503' }
    const { hub, calls } = fakeHub(() => answer)
    const push = new PushRegistry(db(), { hub: () => hub, log: () => {} })
    expect(await push.register('k1', registration)).toMatchObject({ registered: true, relay: 'failed', error: 'HTTP 503' })
    answer = { ok: true }
    await push.resync()
    expect(calls.filter((c) => c.method === 'registerDevice')).toHaveLength(2)
    expect(push.status('k1')).toMatchObject({ relay: 'ok', error: null })
    await push.resync()
    expect(calls.filter((c) => c.method === 'registerDevice')).toHaveLength(2)
  })
  it('is relay none on a host without a hub, and registers nothing there', async () => {
    const push = new PushRegistry(db(), { hub: () => null, log: () => {} })
    expect(await push.register('k1', registration)).toMatchObject({ registered: true, relay: 'none', error: null })
    expect(await push.unregister('k1')).toMatchObject({ registered: false })
  })
  it('drops the registration and the activities with the key, here and on the hub', async () => {
    const { hub, calls } = fakeHub()
    const push = new PushRegistry(db(), { hub: () => hub, log: () => {} })
    await push.register('k1', registration)
    await push.setActivity('k1', { sessionId: 't1', token: TOKEN })
    expect(push.hasActivities('t1')).toBe(true)
    expect(calls.at(-1)).toEqual({ method: 'setActivity', args: { deviceId: 'k1', threadId: 't1', token: TOKEN.toLowerCase(), bundleId: 'dev.landon.tempcode.ios', environment: 'sandbox' } })
    await push.dropKey('k1')
    expect(push.status('k1').registered).toBe(false)
    expect(push.hasActivities('t1')).toBe(false)
    expect(calls.map((c) => c.method)).toEqual(['registerDevice', 'setActivity', 'removeDevice', 'removeActivity'])
    // A key with nothing registered is a no-op.
    await push.dropKey('k2')
    expect(calls).toHaveLength(4)
  })
  it('ends an activity on a null token and needs a bundle for one without a registration', async () => {
    const { hub, calls } = fakeHub()
    const push = new PushRegistry(db(), { hub: () => hub, log: () => {} })
    await expect(push.setActivity('k1', { sessionId: 't1', token: TOKEN })).rejects.toThrow(/bundleId and environment/)
    await push.setActivity('k1', { sessionId: 't1', token: TOKEN, bundleId: 'dev.landon.tempcode.ios', environment: 'production' })
    expect(push.activities('t1')).toEqual([{ keyId: 'k1', sessionId: 't1' }])
    await push.setActivity('k1', { sessionId: 't1', token: null })
    expect(push.activities('t1')).toEqual([])
    expect(calls.map((c) => c.method)).toEqual(['setActivity', 'removeActivity'])
  })
})

describe('ActivityFeed', () => {
  const meta = (patch: Partial<SessionMeta>): SessionMeta => ({
    id: 't1',
    parentId: null,
    projectId: null,
    workspaceId: null,
    threadType: 'implementation',
    planPath: null,
    provider: 'claude',
    model: 'claude-sonnet-5-5',
    reasoning: 'low',
    agentType: 'implementer',
    title: 'Ship it',
    cwd: '/tmp',
    status: 'running',
    pinned: false,
    archived: false,
    permission: 'edits',
    fast: false,
    ultrafast: false,
    context1m: false,
    busySince: 500,
    pausedAt: null,
    frozenActiveElapsed: null,
    nativeId: null,
    createdAt: 1,
    updatedAt: 900,
    ...patch
  })
  it('maps statuses to the strip phases', () => {
    expect(['starting', 'running', 'watching'].map((s) => activityPhase(s as SessionMeta['status']))).toEqual(['working', 'working', 'working'])
    expect(activityPhase('paused')).toBe('paused')
    expect(activityPhase('waiting')).toBe('waiting')
    expect(activityPhase('error')).toBe('failed')
    expect(activityPhase('idle')).toBe('finished')
    expect(activityPhase('running', true)).toBe('finished')
  })
  it('pushes one update per transition for threads with an activity, ends on a settled phase and drops the rows', async () => {
    const listeners = new Set<(m: SessionMeta) => void>()
    const { hub, calls } = fakeHub()
    const push = new PushRegistry(db(), { hub: () => hub, log: () => {} })
    await push.setActivity('k1', { sessionId: 't1', token: TOKEN, bundleId: 'b', environment: 'sandbox' })
    const feed = new ActivityFeed({ registry: { onMeta: (l) => (listeners.add(l), () => listeners.delete(l)) }, push, hub: () => hub, now: () => 2000, log: () => {} })
    feed.start()
    const emit = (m: SessionMeta) => listeners.forEach((l) => l(m))
    emit(meta({}))
    emit(meta({ updatedAt: 950 }))
    emit(meta({ id: 't2', status: 'running' }))
    emit(meta({ status: 'paused' }))
    emit(meta({ status: 'waiting' }))
    emit(meta({ status: 'running' }))
    await new Promise((r) => setTimeout(r, 20))
    const pushes = calls.filter((c) => c.method === 'pushActivity').map((c) => c.args as { event: string; state: { phase: string; since: number; ts: number }; title: string; threadType?: string })
    expect(pushes.map((p) => [p.event, p.state.phase])).toEqual([
      ['update', 'working'],
      ['update', 'paused'],
      ['end', 'waiting']
    ])
    expect(pushes[0]).toMatchObject({ threadId: 't1', title: 'Ship it', threadType: 'implementation', state: { since: 500, ts: 2000 } })
    expect(push.hasActivities('t1')).toBe(false)
    feed.stop()
  })
})

describe('a host with its own APNs sender', () => {
  /** A sender that records every request and answers what the test set. */
  function fakeApns(answer: (token: string) => { ok: true } | { ok: false; error: string; gone: boolean } = () => ({ ok: true })) {
    const sent: { token: string; topic: string; pushType: string; environment: string; payload: unknown; collapseId?: string }[] = []
    return { sent, apns: { async send(r: { token: string; topic: string; pushType: string; environment: string; payload: unknown; collapseId?: string }) { sent.push(r); return answer(r.token) } } }
  }
  it('relays registrations locally, takes its devices back from the hub at boot, and posts notices to the phones that asked', async () => {
    const { hub, calls } = fakeHub()
    const { apns, sent } = fakeApns()
    const push = new PushRegistry(db(), { hub: () => hub, apns: () => apns, hostId: () => 'box', environmentId: () => 'env_box', now: () => 1000, log: () => {} })
    expect(await push.register('k1', { ...registration, events: ['needs_you'] })).toMatchObject({ relay: 'ok', error: null })
    await push.register('k2', { ...registration, token: 'cd'.repeat(32), environment: 'production', events: ['finished'] })
    expect(calls).toEqual([])
    await push.resync()
    expect(calls.map((c) => c.method).sort()).toEqual(['removeDevice', 'removeDevice'])
    expect(await push.deliver({ event: 'needs_you', threadId: 't1', seq: 21, title: 'Ship it', body: 'Permission: Bash', ts: 5000 })).toEqual({ delivered: 1, failed: 0 })
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ token: TOKEN.toLowerCase(), topic: 'dev.landon.tempcode.ios', pushType: 'alert', environment: 'sandbox', collapseId: 't1:needs_you' })
    expect(sent[0].payload).toEqual({
      aps: { alert: { title: 'Ship it', body: 'Permission: Bash' }, sound: 'default', 'thread-id': 't1', 'interruption-level': 'time-sensitive' },
      tc: { event: 'needs_you', hostId: 'box', environmentId: 'env_box', threadId: 't1', seq: 21, ts: 5000 }
    })
    expect(await push.deliver({ event: 'finished', threadId: 't1', seq: 30, title: 'Ship it', body: 'Finished its turn', ts: 6000 })).toEqual({ delivered: 1, failed: 0 })
    expect(sent[1]).toMatchObject({ environment: 'production', token: 'cd'.repeat(32) })
  })
  it('drops a phone Apple calls gone, records other failures on the row, and pushes activity states to the thread tokens', async () => {
    const { apns, sent } = fakeApns((token) => (token.startsWith('ab') ? { ok: false, error: 'APNs 410 Unregistered', gone: true } : { ok: false, error: 'APNs 500', gone: false }))
    const push = new PushRegistry(db(), { hub: () => null, apns: () => apns, log: () => {} })
    await push.register('k1', registration)
    await push.register('k2', { ...registration, token: 'cd'.repeat(32) })
    await push.setActivity('k1', { sessionId: 't1', token: TOKEN })
    await push.setActivity('k2', { sessionId: 't1', token: 'ef'.repeat(32) })
    expect(await push.deliver({ event: 'needs_you', threadId: 't1', seq: 1, title: 't', body: 'b', ts: 1000 })).toEqual({ delivered: 0, failed: 2 })
    expect(push.status('k1').registered).toBe(false)
    expect(push.status('k2')).toMatchObject({ registered: true, relay: 'failed', error: 'APNs 500' })
    expect(push.activityTokens('t1').map((r) => r.keyId)).toEqual(['k2'])
    sent.length = 0
    expect(await push.deliverActivity({ threadId: 't1', event: 'end', state: { phase: 'waiting', since: 1, ts: 2, seq: 1 }, ts: 2000 })).toEqual({ delivered: 0, failed: 1 })
    expect(sent[0]).toMatchObject({ token: 'ef'.repeat(32), topic: 'dev.landon.tempcode.ios.push-type.liveactivity', pushType: 'liveactivity', collapseId: 't1' })
    expect((sent[0].payload as { aps: Record<string, unknown> }).aps).toMatchObject({ event: 'end', 'content-state': { phase: 'waiting', seq: 1 } })
  })
  it('lets the feed deliver locally and end the rows', async () => {
    const listeners = new Set<(m: SessionMeta) => void>()
    const { apns, sent } = fakeApns()
    const push = new PushRegistry(db(), { hub: () => null, apns: () => apns, log: () => {} })
    await push.setActivity('k1', { sessionId: 't1', token: TOKEN, bundleId: 'b', environment: 'production' })
    const feed = new ActivityFeed({ registry: { onMeta: (l) => (listeners.add(l), () => listeners.delete(l)) }, push, hub: () => null, local: () => true, now: () => 2000, log: () => {} })
    feed.start()
    const base: SessionMeta = { id: 't1', parentId: null, projectId: null, workspaceId: null, threadType: 'chat', planPath: null, provider: 'claude', model: 'm', reasoning: 'low', agentType: 'implementer', title: 'T', cwd: '/', status: 'running', pinned: false, archived: false, permission: 'edits', fast: false, ultrafast: false, context1m: false, busySince: 500, pausedAt: null, frozenActiveElapsed: null, nativeId: null, createdAt: 1, updatedAt: 900 }
    listeners.forEach((l) => l(base))
    listeners.forEach((l) => l({ ...base, status: 'idle' }))
    await new Promise((r) => setTimeout(r, 20))
    expect(sent.map((s) => [(s.payload as { aps: { event: string } }).aps.event, s.environment])).toEqual([['update', 'production'], ['end', 'production']])
    expect(push.hasActivities('t1')).toBe(false)
    feed.stop()
  })
})
