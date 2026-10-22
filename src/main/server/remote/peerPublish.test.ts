import { describe, expect, it, vi } from 'vitest'
import type { PublishRun } from '@shared/contract-publish'
import { PeerCalls, PeerOfflineError } from './peerCalls'
import { PeerPublish } from './peerPublish'

const args = { sha: 'a'.repeat(40), branch: 'master', version: '1.0.277', notes: 'Ship the fixes' }
const result: PublishRun = { ok: true, exit: 0, version: args.version, text: 'Published 1.0.277' }

function setup(ids = ['mac'], bridge: string | null = null) {
  let resolve!: (value: PublishRun) => void
  let reject!: (err: Error) => void
  const waiting = new Promise<PublishRun>((yes, no) => {
    resolve = yes
    reject = no
  })
  const order: string[] = []
  const call = vi.fn<PeerCalls['call']>((_envId, method) => {
    order.push(method)
    return (method === 'publish.start' ? waiting : Promise.resolve({ stopped: true })) as never
  })
  const calls = {
    online: vi.fn(
      (id: string, offer?: string) => ids.includes(id) && (!offer || offer === 'publish')
    ),
    registeredIds: vi.fn(() => ids),
    call,
    cancel: vi.fn(() => {
      order.push('cancel')
      reject(new Error('stopped'))
      return true
    })
  }
  const peer = new PeerPublish({
    environmentId: 'box',
    calls: calls as unknown as PeerCalls,
    macPeerOf: () => bridge
  })
  return { peer, calls, resolve, reject, order }
}

describe('PeerPublish', () => {
  it('picks the thread bridge peer when it offers publish, else the only registered publisher', () => {
    const multiple = setup(['first', 'second'], 'second')
    expect(multiple.peer.resolveMac('thread')).toBe('second')
    expect(multiple.calls.online).toHaveBeenCalledWith('second', 'publish')
    const only = setup(['first'], 'offline')
    expect(only.peer.resolveMac('thread')).toBe('first')
    expect(only.calls.registeredIds).toHaveBeenCalledWith('publish')
    expect(setup().peer.resolveMac('thread')).toBe('mac')
  })

  it('refuses zero or several Macs and names the choices', () => {
    expect(() => setup([]).peer.resolveMac('thread')).toThrow('no Mac paired')
    expect(() => setup(['first', 'second']).peer.resolveMac('thread')).toThrow(
      'several Macs are linked (first, second)'
    )
  })

  it('sends the caller, args, 90 minute deadline and call id; joins lines across progress frames', async () => {
    const { peer, calls, resolve } = setup()
    const lines: string[] = []
    const run = peer.start('thread', args, (line) => lines.push(line))
    expect(calls.call).toHaveBeenCalledWith(
      'mac',
      'publish.start',
      { caller: { environmentId: 'box', sessionId: 'thread' }, args },
      90 * 60_000,
      { callId: expect.any(String), onProgress: expect.any(Function) }
    )
    const opts = calls.call.mock.calls[0][4]!
    opts.onProgress!({ seq: 0, chunk: 'buil', skipped: 0 })
    opts.onProgress!({ seq: 1, chunk: 'ding\r', skipped: 0 })
    opts.onProgress!({ seq: 2, chunk: '\nfirst\n\nlast', skipped: 0 })
    expect(lines).toEqual(['building', 'first', ''])
    resolve(result)
    await expect(run.done).resolves.toEqual(result)
    expect(lines).toEqual(['building', 'first', '', 'last'])
  })

  it('returns a failed job as a result', async () => {
    const { peer, resolve } = setup()
    const { done } = peer.start('thread', args, () => {})
    const failed = { ...result, ok: false, exit: 1, text: 'notarization failed' }
    resolve(failed)
    await expect(done).resolves.toEqual(failed)
  })

  it('rejects with the Mac refusal text', async () => {
    const { peer, reject } = setup()
    const { done } = peer.start('thread', args, () => {})
    reject(new Error('the tree has uncommitted changes; commit first'))
    await expect(done).rejects.toThrow('the tree has uncommitted changes; commit first')
  })

  it('turns a dropped link into the publish offline error', async () => {
    const { peer, reject } = setup()
    const { done } = peer.start('thread', args, () => {})
    reject(new PeerOfflineError('mac'))
    await expect(done).rejects.toThrow('the Mac went offline during the publish')
  })

  it('sends stop to the same Mac with a 30 second deadline, then cancels the start call', async () => {
    const { peer, calls, order } = setup()
    const run = peer.start('thread', args, () => {})
    const rejected = expect(run.done).rejects.toThrow('stopped')
    await run.stop()
    expect(calls.call.mock.calls[1]).toEqual([
      'mac',
      'publish.stop',
      { caller: { environmentId: 'box', sessionId: 'thread' }, args: {} },
      30_000
    ])
    expect(calls.cancel).toHaveBeenCalledWith(calls.call.mock.calls[0][4]!.callId, 'stopped')
    expect(order).toEqual(['publish.start', 'publish.stop', 'cancel'])
    await rejected
  })

  it('cancels the start call even when the stop RPC fails', async () => {
    const { peer, calls } = setup()
    const run = peer.start('thread', args, () => {})
    const rejected = expect(run.done).rejects.toThrow('stopped')
    calls.call.mockRejectedValueOnce(new PeerOfflineError('mac'))
    await expect(run.stop()).rejects.toBeInstanceOf(PeerOfflineError)
    expect(calls.cancel).toHaveBeenCalledOnce()
    await rejected
  })
})
