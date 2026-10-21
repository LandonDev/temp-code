import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import { PEER_CHUNK_CHARS, type MacBridgePush } from '@shared/contract-macbridge'
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
    expect(push.params.thread.id).toBe('s1')
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
