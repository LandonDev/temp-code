import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@shared/contract'
import type { MacBridgePush } from '@shared/contract-macbridge'
import { HostLinks } from './hostLinks'
import { PeerCalls, PeerOfflineError, handlePeerRequest, type LinkRequest } from './peerCalls'

const MAC = `env_${'m'.repeat(22)}`
const BOX = `env_${'b'.repeat(22)}`
const OLD = `env_${'o'.repeat(22)}`

/** A fake peer registered on this host's PeerCalls, answering every call with its method and params. */
function registered(calls: PeerCalls, envId: string, offers: string[], connection: number): void {
  const socket = {
    connection,
    keyId: 'k',
    remote: true,
    send: (frame: ServerFrame) => {
      if (!('push' in frame) || frame.push !== 'peer.call') return
      const call = frame as Extract<MacBridgePush, { push: 'peer.call' }>
      handlePeerRequest(calls, socket, { method: 'peer.reply', params: { callId: call.callId, ok: true, result: { via: 'registered', method: call.method, params: call.params } } })
    }
  }
  handlePeerRequest(calls, socket, { method: 'peer.register', params: { from: envId, offers } })
}

function setup() {
  const calls = new PeerCalls(BOX, () => {})
  const links: Record<string, LinkRequest | null> = {}
  const sent: { id: string; method: string; params: unknown; timeoutMs?: number }[] = []
  const link = (id: string, up = true): void => {
    links[id] = up
      ? async (method, params, opts) => {
          sent.push({ id, method, params, timeoutMs: opts?.timeoutMs })
          return { via: 'link', method }
        }
      : null
  }
  const hosts = new HostLinks({ calls, offer: 'threads', link: (id) => links[id] ?? null, linkIds: () => Object.keys(links) })
  return { calls, hosts, link, sent }
}

describe('HostLinks', () => {
  it('reaches a host registered here with the offer by peer.call, and a host linked from here by a request on its listener', async () => {
    const { calls, hosts, link, sent } = setup()
    registered(calls, MAC, ['mac-bridge', 'threads'], 1)
    link(BOX)
    expect(hosts.reachable()).toEqual([
      { id: MAC, via: 'registered' },
      { id: BOX, via: 'link' }
    ])
    expect(hosts.via(MAC)).toBe('registered')
    expect(hosts.via(BOX)).toBe('link')
    expect(await hosts.call(MAC, 'thread.check', { caller: 'c', args: {} }, 5_000)).toMatchObject({ via: 'registered', method: 'thread.check' })
    expect(await hosts.call(BOX, 'thread.start', { caller: 'c', args: {} }, 7_000)).toMatchObject({ via: 'link', method: 'thread.start' })
    expect(sent).toEqual([{ id: BOX, method: 'thread.start', params: { caller: 'c', args: {} }, timeoutMs: 7_000 }])
  })
  it('a host registered without the offer is named as such; one nowhere is offline; a saved link that is down is not reachable', async () => {
    const { calls, hosts, link } = setup()
    registered(calls, OLD, ['mac-bridge'], 2)
    link(BOX, false)
    expect(hosts.reachable()).toEqual([])
    expect(hosts.via(OLD)).toBeNull()
    expect(hosts.refusal(OLD)).toContain('offers no threads')
    expect(hosts.refusal(MAC)).toContain('no live link')
    expect(hosts.refusal(BOX)).toContain('no live link')
    await expect(hosts.call(BOX, 'thread.check', {}, 1_000)).rejects.toBeInstanceOf(PeerOfflineError)
    await expect(hosts.call(MAC, 'thread.check', {}, 1_000)).rejects.toBeInstanceOf(PeerOfflineError)
  })
  it('a link that drops under a request reads as the host out of reach; another failure passes through', async () => {
    const { hosts } = setup()
    const links: Record<string, LinkRequest | null> = {}
    const h = new HostLinks({ calls: new PeerCalls(BOX, () => {}), offer: 'threads', link: (id) => links[id] ?? null, linkIds: () => Object.keys(links) })
    links[BOX] = async () => {
      links[BOX] = null
      throw new Error('socket closed')
    }
    await expect(h.call(BOX, 'thread.check', {}, 1_000)).rejects.toBeInstanceOf(PeerOfflineError)
    links[BOX] = async () => {
      throw new Error('unknown session: x')
    }
    await expect(h.call(BOX, 'thread.check', {}, 1_000)).rejects.toThrow('unknown session: x')
    expect(hosts.reachable()).toEqual([])
  })
})
