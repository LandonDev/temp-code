import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { MacBridgePush, MacCallParams, MacCancelArgs, MacHeldArgs } from '@shared/contract-macbridge'
import type { SessionMeta } from '@shared/events'
import {
  CANCELLED_PAUSED,
  CANCELLED_STOPPED,
  MacPause,
  REFUSED_PAUSED,
  isMacRead
} from './macPause'
import { PeerCalls, handlePeerRequest } from './remote/peerCalls'

afterEach(() => void vi.useRealTimers())

const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    parentId: null,
    projectId: null,
    workspaceId: null,
    title: `T ${id}`,
    status: 'idle',
    permission: 'safe',
    ...extra
  }) as SessionMeta

type Call = Omit<Extract<MacBridgePush, { push: 'peer.call' }>, 'params'> & { params: MacCallParams }

/**
 * A box with a registered Mac that answers nothing by itself: the test
 * replies to a call when it wants to, so calls stay out on the Mac.
 */
function box() {
  const sessions = new Map<string, SessionMeta>([
    ['root', meta('root')],
    ['child', meta('child', { parentId: 'root' })],
    ['grandchild', meta('grandchild', { parentId: 'child' })],
    ['other', meta('other')]
  ])
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
  handlePeerRequest(calls, socket, {
    method: 'peer.register',
    params: { from: 'env_mac', offers: ['mac-bridge'] }
  })
  const reply = (callId: string, result: unknown): void => {
    handlePeerRequest(calls, socket, {
      method: 'peer.reply',
      params: { callId, ok: true, result }
    } as Parameters<typeof handlePeerRequest>[2])
  }
  const jobThreads = new Map<string, string>()
  const heldChanges: [string, number][] = []
  const lines: string[] = []
  const pause = new MacPause({
    sessions: { get: (id) => sessions.get(id) ?? null },
    calls,
    jobThreads: () => jobThreads,
    heldChanged: (root, held) => heldChanges.push([root, held]),
    log: (l) => lines.push(l)
  })
  /** One mac.* call as macTools would send it, answering what the Mac answers. */
  const send =
    (method: Call['method'], sessionId: string) =>
    (callId: string): Promise<unknown> =>
      calls.call('env_mac', method, { thread: { id: sessionId, title: '' }, args: {} }, 60_000, {
        callId
      })
  const guard = (sessionId: string, method: Call['method'], waitMs = 60_000) =>
    pause.guard({ sessionId, macPeer: 'env_mac', method, shape: { cwd: '/x' }, waitMs }, send(method, sessionId))
  const ofMethod = (method: string): Call[] => out.filter((c) => c.method === method)
  const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> =>
    p.then(
      (value) => ({ ok: true as const, value }),
      (err: unknown) => ({ ok: false as const, error: err instanceof Error ? err.message : String(err) })
    )
  return { sessions, calls, out, reply, pause, jobThreads, heldChanges, lines, guard, ofMethod, settle }
}

describe('isMacRead', () => {
  it('the three reads, nothing else', () => {
    expect(['mac.readFile', 'mac.listDir', 'mac.fetchFile'].every(isMacRead)).toBe(true)
    expect(['mac.run', 'mac.writeFile', 'mac.jobStart', 'mac.jobRead'].some(isMacRead)).toBe(false)
  })
})

describe('MacPause: a running thread', () => {
  it('sends at once with the call id it named, and forgets it when the Mac answers', async () => {
    const b = box()
    const p = b.guard('root', 'mac.run')
    expect(b.out.length).toBe(1)
    b.reply(b.out[0].callId, { ok: 1 })
    expect(await p).toEqual({ ok: 1 })
    expect(b.pause.heldCount('root')).toBe(0)
    expect(b.heldChanges).toEqual([])
  })

  it('the tree: a thread is paused when it or any ancestor is', () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    expect(b.pause.isPaused('grandchild')).toBe(true)
    expect(b.pause.isPaused('other')).toBe(false)
    expect(b.pause.rootOf('grandchild')).toBe('root')
    b.pause.onStatus('root', 'running')
    expect(b.pause.isPaused('child')).toBe(false)
  })
})

describe('MacPause: pausing', () => {
  it('cancels every call out on the Mac under the thread: the caller hears "cancelled: the thread was paused", the Mac one mac.cancel per thread naming the calls, jobs too', async () => {
    const b = box()
    const own = b.settle(b.guard('root', 'mac.run'))
    const childs = b.settle(b.guard('grandchild', 'mac.writeFile'))
    const foreign = b.settle(b.guard('other', 'mac.run'))
    const [c1, c2, c3] = b.out
    b.pause.onStatus('root', 'paused')
    expect(await own).toEqual({ ok: false, error: CANCELLED_PAUSED })
    expect(await childs).toEqual({ ok: false, error: CANCELLED_PAUSED })
    const cancels = b.ofMethod('mac.cancel')
    expect(cancels.map((c) => [c.params.thread.id, c.params.args])).toEqual([
      ['root', { callIds: [c1.callId], jobs: true, reason: 'paused' }],
      ['grandchild', { callIds: [c2.callId], jobs: true, reason: 'paused' }]
    ])
    // The other thread's call is still out; a late answer for a cancelled one is dropped.
    b.reply(c3.callId, 'fine')
    expect(await foreign).toEqual({ ok: true, value: 'fine' })
    expect(() => b.reply(c1.callId, 'late')).toThrow(/unknown or expired/)
  })

  it('a thread with a job on the Mac and nothing out still gets its cancel, so the job ends', () => {
    const b = box()
    b.jobThreads.set('child', 'env_mac')
    b.pause.onStatus('root', 'paused')
    expect(b.ofMethod('mac.cancel').map((c) => [c.params.thread.id, (c.params.args as MacCancelArgs).callIds])).toEqual([
      ['child', []]
    ])
  })

  it('status paused twice is one pause; a thread never paused that goes idle changes nothing', () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    b.pause.onStatus('root', 'paused')
    expect(b.lines.filter((l) => l.includes('cancelled')).length).toBe(0)
    b.pause.onStatus('other', 'idle')
    expect(b.ofMethod('mac.cancel')).toEqual([])
  })
})

describe('MacPause: the hold', () => {
  it('a command, job or write while paused waits on the box, never sent; the Mac lists it; resume lifts the hold in arrival order', async () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    const first = b.guard('root', 'mac.run')
    const second = b.guard('child', 'mac.jobStart')
    const third = b.guard('grandchild', 'mac.writeFile')
    expect(b.out.filter((c) => c.method !== 'mac.held')).toEqual([])
    expect(b.pause.heldCount('root')).toBe(3)
    expect(b.pause.heldCount('child')).toBe(2)
    expect(b.pause.heldUnder('root').map((h) => h.method)).toEqual(['mac.run', 'mac.jobStart', 'mac.writeFile'])
    // The Mac hears each thread's whole held set; the box's clients the root's count.
    const helds = b.ofMethod('mac.held')
    expect(helds.map((c) => [c.params.thread.id, (c.params.args as MacHeldArgs).held.map((h) => h.method)])).toEqual([
      ['root', ['mac.run']],
      ['child', ['mac.jobStart']],
      ['grandchild', ['mac.writeFile']]
    ])
    expect((helds[0].params.args as MacHeldArgs).held[0]).toMatchObject({ cwd: '/x', method: 'mac.run' })
    expect(b.heldChanges).toEqual([
      ['root', 1],
      ['root', 2],
      ['root', 3]
    ])
    b.pause.onStatus('root', 'running')
    const sent = b.out.filter((c) => !['mac.held', 'mac.cancel'].includes(c.method))
    expect(sent.map((c) => [c.method, c.params.thread.id])).toEqual([
      ['mac.run', 'root'],
      ['mac.jobStart', 'child'],
      ['mac.writeFile', 'grandchild']
    ])
    expect(b.pause.heldCount('root')).toBe(0)
    expect(b.heldChanges.at(-1)).toEqual(['root', 0])
    expect(b.ofMethod('mac.held').at(-1)?.params.args).toEqual({ held: [] })
    b.reply(sent[0].callId, 'a')
    b.reply(sent[1].callId, 'b')
    b.reply(sent[2].callId, 'c')
    expect(await Promise.all([first, second, third])).toEqual(['a', 'b', 'c'])
  })

  it('a subagent paused on its own: its calls wait while the root runs on; the root resuming does not lift them', async () => {
    const b = box()
    b.pause.onStatus('child', 'paused')
    const held = b.settle(b.guard('grandchild', 'mac.run'))
    const free = b.guard('root', 'mac.run')
    expect(b.out.filter((c) => c.method === 'mac.run').map((c) => c.params.thread.id)).toEqual(['root'])
    b.pause.onStatus('root', 'running')
    expect(b.pause.heldCount('root')).toBe(1)
    b.pause.onStatus('child', 'running')
    expect(b.pause.heldCount('root')).toBe(0)
    const run = b.out.filter((c) => c.method === 'mac.run')
    expect(run.map((c) => c.params.thread.id)).toEqual(['root', 'grandchild'])
    b.reply(run[0].callId, 1)
    b.reply(run[1].callId, 2)
    expect(await free).toBe(1)
    expect(await held).toEqual({ ok: true, value: 2 })
  })

  it("answers at once with 'refused: the thread is paused' when the caller's wait would run out first", async () => {
    vi.useFakeTimers()
    const b = box()
    b.pause.onStatus('root', 'paused')
    const short = b.settle(b.guard('root', 'mac.run', 5_000))
    const long = b.settle(b.guard('root', 'mac.run', 60_000))
    await vi.advanceTimersByTimeAsync(5_001)
    expect(await short).toEqual({ ok: false, error: REFUSED_PAUSED })
    expect(b.pause.heldCount('root')).toBe(1)
    expect(b.ofMethod('mac.held').at(-1)?.params.args).toMatchObject({ held: [{ method: 'mac.run' }] })
    b.pause.onStatus('root', 'running')
    const run = b.ofMethod('mac.run')
    expect(run.length).toBe(1)
    b.reply(run[0].callId, 'went')
    expect(await long).toEqual({ ok: true, value: 'went' })
  })

  it('reads are never held: a paused thread still sends them', () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    void b.guard('child', 'mac.readFile').catch(() => {})
    void b.guard('child', 'mac.listDir').catch(() => {})
    expect(b.out.map((c) => c.method)).toEqual(['mac.readFile', 'mac.listDir'])
    expect(b.pause.heldCount('root')).toBe(0)
  })
})

describe('MacPause: Stop', () => {
  it('stop() cancels the root tree out on the Mac with "cancelled: the thread was stopped" and refuses what waited', async () => {
    const b = box()
    const out = b.settle(b.guard('child', 'mac.run'))
    b.pause.onStatus('grandchild', 'paused')
    const waited = b.settle(b.guard('grandchild', 'mac.run'))
    b.pause.stop('grandchild')
    expect(await out).toEqual({ ok: false, error: CANCELLED_STOPPED })
    expect(await waited).toEqual({ ok: false, error: CANCELLED_STOPPED })
    expect(b.ofMethod('mac.cancel').map((c) => [c.params.thread.id, (c.params.args as MacCancelArgs).reason])).toEqual([
      ['child', 'stopped']
    ])
    expect(b.pause.heldCount('root')).toBe(0)
  })

  it('a paused thread that goes idle or errored (Stop, a failure) refuses what it held instead of sending it', async () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    const waited = b.settle(b.guard('root', 'mac.run'))
    b.pause.onStatus('root', 'idle')
    expect(await waited).toEqual({ ok: false, error: CANCELLED_STOPPED })
    expect(b.ofMethod('mac.run')).toEqual([])
  })

  it('a thread that ends (archived, removed) drops its hold and its pause', async () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    const waited = b.settle(b.guard('child', 'mac.run'))
    b.pause.ended(['root'])
    expect(await waited).toEqual({ ok: false, error: CANCELLED_STOPPED })
    expect(b.pause.isPaused('child')).toBe(false)
  })

  it('close() fails everything waiting', async () => {
    const b = box()
    b.pause.onStatus('root', 'paused')
    const waited = b.settle(b.guard('root', 'mac.run'))
    b.pause.close()
    expect(await waited).toEqual({ ok: false, error: 'server closing' })
  })
})
