import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import { PEER_CHUNK_CHARS, type MacBridgePush, type MacCallParams } from '@shared/contract-macbridge'
import {
  PeerCalls,
  PeerOfflineError,
  handlePeerRequest,
  replyOverLink,
  servePeerCall,
  type PeerCallHandler,
  type PeerSocket
} from './peerCalls'

type Call = Extract<MacBridgePush, { push: 'peer.call' }>
const params = { thread: { id: 's1', title: 'T' }, args: { path: '/x' } }

/**
 * An in-process link: the box's PeerCalls on one end, a "Mac" on the other
 * that serves every peer.call push through `handler` and answers through
 * handlePeerRequest, exactly the frames PeerLink.request would carry.
 */
function link(handler: PeerCallHandler, opts: { connection?: number; serve?: boolean } = {}) {
  const calls = new PeerCalls('env_box', () => {})
  const frames: ServerFrame[] = []
  const requests: { method: string; params: unknown }[] = []
  const socket: PeerSocket & { remote: boolean } = {
    connection: opts.connection ?? 1,
    keyId: 'k1',
    remote: true,
    send: (frame) => {
      frames.push(frame)
      if (opts.serve === false || !('push' in frame) || frame.push !== 'peer.call') return
      void servePeerCall(frame as Call, 'env_mac', handler, request)
    }
  }
  const request = async (method: string, p?: unknown): Promise<unknown> => {
    requests.push({ method, params: p })
    return handlePeerRequest(calls, socket, { method, params: p } as Parameters<
      typeof handlePeerRequest
    >[2])
  }
  handlePeerRequest(calls, socket, {
    method: 'peer.register',
    params: { from: 'env_mac', offers: ['mac-bridge'] }
  })
  return { calls, frames, requests, socket, request }
}

afterEach(() => vi.useRealTimers())

describe('PeerCalls', () => {
  it('registers a socket under the Mac id and answers the box id', () => {
    const calls = new PeerCalls('env_box', () => {})
    const socket = { connection: 3, keyId: null, remote: true, send: () => {} }
    expect(
      handlePeerRequest(calls, socket, {
        method: 'peer.register',
        params: { from: 'env_mac', offers: ['mac-bridge'] }
      })
    ).toEqual({ environmentId: 'env_box' })
    expect(calls.online('env_mac', 'mac-bridge')).toBe(true)
    expect(calls.online('env_mac', 'other')).toBe(false)
    expect(calls.registeredIds('mac-bridge')).toEqual(['env_mac'])
  })

  it('notify sends one frame down every registered socket and nothing to a dropped one', () => {
    const calls = new PeerCalls('env_box', () => {})
    const got: Record<string, ServerFrame[]> = { a: [], b: [] }
    handlePeerRequest(calls, { connection: 1, keyId: null, remote: true, send: (f) => got.a.push(f) }, { method: 'peer.register', params: { from: 'env_a', offers: [] } })
    handlePeerRequest(calls, { connection: 2, keyId: null, remote: true, send: (f) => got.b.push(f) }, { method: 'peer.register', params: { from: 'env_b', offers: [] } })
    calls.drop(2)
    calls.notify({ push: 'memory.nudge', from: 'env_box' })
    expect(got.a).toEqual([{ push: 'memory.nudge', from: 'env_box' }])
    expect(got.b).toEqual([])
  })

  it("refuses peer.* from the box's own loopback socket", () => {
    const calls = new PeerCalls('env_box', () => {})
    expect(() =>
      handlePeerRequest(
        calls,
        { connection: 1, keyId: null, remote: false, send: () => {} },
        { method: 'peer.register', params: { from: 'x', offers: [] } }
      )
    ).toThrow(/another host/)
    expect(calls.online('x')).toBe(false)
  })

  it('a call goes out as a push and the reply resolves it', async () => {
    const { calls, frames } = link(async (method, p) => ({
      method,
      path: (p.args as { path: string }).path
    }))
    await expect(calls.call('env_mac', 'mac.readFile', params, 5_000)).resolves.toEqual({
      method: 'mac.readFile',
      path: '/x'
    })
    const push = frames[0] as Call
    expect(push.push).toBe('peer.call')
    expect(push.deadlineMs).toBe(5_000)
    expect((push.params as MacCallParams).thread.id).toBe('s1')
    expect(calls.pendingCount()).toBe(0)
  })

  it('an error on the Mac rejects the call with its message', async () => {
    const { calls } = link(async () => {
      throw new Error('denied at the Mac')
    })
    await expect(calls.call('env_mac', 'mac.run', params, 5_000)).rejects.toThrow(
      'denied at the Mac'
    )
  })

  it('a reply over 2 MiB streams as chunks and is put back together', async () => {
    const big = 'é'.repeat(PEER_CHUNK_CHARS + 1234) + '😀'.repeat(10)
    const { calls, requests } = link(async () => ({ content: big }))
    const result = await calls.call<{ content: string }>('env_mac', 'mac.readFile', params, 10_000)
    expect(result.content).toBe(big)
    const chunks = requests.filter((r) => r.method === 'peer.chunk')
    expect(chunks.length).toBe(2)
    expect(requests.at(-1)).toEqual({
      method: 'peer.reply',
      params: expect.objectContaining({ ok: true, chunks: 2 })
    })
  })

  it('chunks split anywhere (inside a surrogate pair) still rebuild the value', async () => {
    const { calls, frames, request } = link(async () => null, { serve: false })
    const pending = calls.call('env_mac', 'mac.readFile', params, 5_000)
    const callId = (frames[0] as Call).callId
    const value = { s: 'a😀b'.repeat(50), n: [1, 2, 3] }
    await replyOverLink(request, callId, { ok: true, result: value }, 7)
    await expect(pending).resolves.toEqual(value)
  })

  it('a reply with a chunk missing fails the call instead of parsing half', async () => {
    const { calls, frames, request } = link(async () => null, { serve: false })
    const pending = calls.call('env_mac', 'mac.readFile', params, 5_000)
    const callId = (frames[0] as Call).callId
    await request('peer.chunk', { callId, index: 0, data: '{"a":' })
    await request('peer.reply', { callId, ok: true, chunks: 2 })
    await expect(pending).rejects.toThrow(/incomplete/)
  })

  it('the deadline is per call: a slow answer fails at its own deadline, a later reply is refused', async () => {
    vi.useFakeTimers()
    const { calls, frames, request } = link(async () => null, { serve: false })
    const short = calls.call('env_mac', 'mac.readFile', params, 1_000)
    const long = calls.call('env_mac', 'mac.run', params, 600_000)
    const shortCaught = short.catch((e: Error) => e)
    vi.advanceTimersByTime(1_001)
    expect(((await shortCaught) as Error).message).toMatch(/did not answer mac.readFile within 1 s/)
    expect(calls.pendingCount()).toBe(1)
    const [first, second] = frames as Call[]
    await expect(
      request('peer.reply', { callId: first.callId, ok: true, result: 1 })
    ).rejects.toThrow(/unknown or expired/)
    await request('peer.reply', { callId: second.callId, ok: true, result: 'ran' })
    await expect(long).resolves.toBe('ran')
  })

  it('only the socket the call went out on may answer it', async () => {
    const { calls, frames } = link(async () => null, { serve: false })
    const pending = calls.call('env_mac', 'mac.readFile', params, 5_000)
    const callId = (frames[0] as Call).callId
    const other = { connection: 99, keyId: 'k2', remote: true, send: () => {} }
    expect(() =>
      handlePeerRequest(calls, other, {
        method: 'peer.reply',
        params: { callId, ok: true, result: 'spoof' }
      })
    ).toThrow(/unknown or expired/)
    expect(() =>
      handlePeerRequest(calls, other, {
        method: 'peer.chunk',
        params: { callId, index: 0, data: 'x' }
      })
    ).toThrow(/unknown or expired/)
    calls.reply(1, { callId, ok: true, result: 'real' })
    await expect(pending).resolves.toBe('real')
  })

  it('no registered socket answers offline; a closed socket fails its calls and unregisters', async () => {
    const calls = new PeerCalls('env_box', () => {})
    await expect(calls.call('env_nobody', 'mac.listDir', params, 5_000)).rejects.toBeInstanceOf(
      PeerOfflineError
    )
    const { calls: c2 } = link(async () => null, { serve: false, connection: 7 })
    const pending = c2.call('env_mac', 'mac.listDir', params, 60_000)
    c2.drop(7)
    await expect(pending).rejects.toThrow(/Mac offline/)
    expect(c2.online('env_mac')).toBe(false)
  })

  it('onRegister hears a peer arriving or returning on a new socket, with its offers, not a re-register on the same one', () => {
    const calls = new PeerCalls('env_box', () => {})
    const heard: string[] = []
    const off = calls.onRegister((id, offers) => heard.push(`${id}:${[...offers].join(',')}`))
    const s1 = { connection: 1, keyId: 'k1', remote: true, send: () => {} }
    handlePeerRequest(calls, s1, { method: 'peer.register', params: { from: 'env_mac', offers: ['mac-bridge'] } })
    handlePeerRequest(calls, s1, { method: 'peer.register', params: { from: 'env_mac', offers: ['mac-bridge'] } })
    calls.drop(1)
    handlePeerRequest(calls, { ...s1, connection: 2 }, { method: 'peer.register', params: { from: 'env_mac', offers: ['mac-bridge', 'x'] } })
    off()
    handlePeerRequest(calls, { ...s1, connection: 3 }, { method: 'peer.register', params: { from: 'env_mac', offers: [] } })
    expect(heard).toEqual(['env_mac:mac-bridge', 'env_mac:mac-bridge,x'])
  })

  it('a newer registration takes the id over; the old socket closing leaves it registered', () => {
    const { calls } = link(async () => null, { connection: 1 })
    const newer = { connection: 2, keyId: 'k1', remote: true, send: () => {} }
    handlePeerRequest(calls, newer, {
      method: 'peer.register',
      params: { from: 'env_mac', offers: ['mac-bridge'] }
    })
    calls.drop(1)
    expect(calls.online('env_mac')).toBe(true)
    calls.drop(2)
    expect(calls.online('env_mac')).toBe(false)
  })

  it('an expired reply on the Mac side is logged, never thrown', async () => {
    const lines: string[] = []
    const request = async (): Promise<unknown> => {
      throw new Error('unknown or expired call')
    }
    await servePeerCall(
      { push: 'peer.call', callId: 'c1', method: 'mac.listDir', params, deadlineMs: 1 },
      'env_box',
      async () => 'x',
      request,
      (l) => lines.push(l)
    )
    expect(lines[0]).toMatch(/not taken: unknown or expired/)
  })
})

describe('peer.progress (mac_run streaming)', () => {
  it('frames reach onProgress in seq order, all before the reply settles the call', async () => {
    const got: string[] = []
    const { calls } = link(async (_m, _p, ctx) => {
      for (const line of ['a\n', 'b\n', 'c\n']) ctx.progress?.(line)
      return { done: true }
    })
    const result = await calls.call('env_mac', 'mac.run', params, 5_000, {
      onProgress: (f) => got.push(`${f.seq}:${f.chunk}`)
    })
    expect(result).toEqual({ done: true })
    expect(got).toEqual(['0:a\n', '1:b\n', '2:c\n'])
  })

  it('out-of-order frames wait for the gap; a repeat or an older seq is dropped', async () => {
    const { calls, frames } = link(async () => null, { serve: false })
    const got: number[] = []
    const pending = calls.call('env_mac', 'mac.run', params, 5_000, {
      onProgress: (f) => got.push(f.seq)
    })
    const callId = (frames[0] as Call).callId
    for (const seq of [1, 2, 0, 1, 3]) calls.progress(1, { callId, seq, chunk: `${seq}` })
    expect(got).toEqual([0, 1, 2, 3])
    calls.reply(1, { callId, ok: true, result: 'r' })
    await pending
  })

  it('a frame for an unknown or settled call is ignored, never an error', async () => {
    const { calls, frames, socket } = link(async () => null, { serve: false })
    const got: string[] = []
    expect(
      handlePeerRequest(calls, socket, {
        method: 'peer.progress',
        params: { callId: 'c-nope', seq: 0, chunk: 'x' }
      })
    ).toEqual({ ok: true })
    const pending = calls.call('env_mac', 'mac.run', params, 5_000, {
      onProgress: (f) => got.push(f.chunk)
    })
    const callId = (frames[0] as Call).callId
    calls.reply(1, { callId, ok: true, result: 'r' })
    await pending
    expect(calls.progress(1, { callId, seq: 0, chunk: 'late' })).toEqual({ ok: true })
    expect(got).toEqual([])
  })

  it('only the socket the call went out on may send its progress; the box loopback never', async () => {
    const { calls, frames } = link(async () => null, { serve: false })
    const got: string[] = []
    const pending = calls.call('env_mac', 'mac.run', params, 5_000, {
      onProgress: (f) => got.push(f.chunk)
    })
    const callId = (frames[0] as Call).callId
    const other = { connection: 99, keyId: 'k2', remote: true, send: () => {} }
    expect(() =>
      handlePeerRequest(calls, other, {
        method: 'peer.progress',
        params: { callId, seq: 0, chunk: 'spoof' }
      })
    ).toThrow(/forbidden/)
    const loopback = { connection: 1, keyId: null, remote: false, send: () => {} }
    expect(() =>
      handlePeerRequest(calls, loopback, {
        method: 'peer.progress',
        params: { callId, seq: 0, chunk: 'spoof' }
      })
    ).toThrow(/forbidden/)
    calls.progress(1, { callId, seq: 0, chunk: 'real', skipped: 7 })
    expect(got).toEqual(['real'])
    calls.reply(1, { callId, ok: true, result: 'r' })
    await pending
  })

  it('a call that asked for no progress drops its frames quietly', async () => {
    const { calls } = link(async (_m, _p, ctx) => {
      ctx.progress?.('ignored\n')
      return 'r'
    })
    await expect(calls.call('env_mac', 'mac.readFile', params, 5_000)).resolves.toBe('r')
  })

  it('servePeerCall numbers the frames and sends skipped only when there is some', async () => {
    const requests: { method: string; params: unknown }[] = []
    const request = async (method: string, p?: unknown): Promise<unknown> => {
      requests.push({ method, params: p })
      return { ok: true }
    }
    await servePeerCall(
      { push: 'peer.call', callId: 'c1', method: 'mac.run', params, deadlineMs: 5_000 },
      'env_mac',
      async (_m, _p, ctx) => {
        ctx.progress?.('one\n')
        ctx.progress?.('two\n', 512)
        return 'r'
      },
      request
    )
    expect(requests.map((r) => r.method)).toEqual(['peer.progress', 'peer.progress', 'peer.reply'])
    expect(requests[0].params).toEqual({ callId: 'c1', seq: 0, chunk: 'one\n' })
    expect(requests[1].params).toEqual({ callId: 'c1', seq: 1, chunk: 'two\n', skipped: 512 })
  })
})
