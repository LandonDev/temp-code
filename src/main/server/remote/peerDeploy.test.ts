import { describe, expect, it, vi } from 'vitest'
import type { DeployStatus, HostLogPush } from '@shared/contract-host'
import { PeerDeploy } from './peerDeploy'

const status = (phase: DeployStatus['phase'], exit: number | null = null): DeployStatus => ({
  job: 'deploy',
  phase,
  target: 'v1.0.283',
  startedAt: 1,
  finishedAt: null,
  exit,
  stoppable: false,
  installed: true,
  installHint: '',
  version: '1.0.280'
})

function setup(links = [{ id: 'box', name: 'The box' }]) {
  const calls: { method: string; params: unknown }[] = []
  let snapshot = { text: '', status: status('idle') }
  let connected = true
  const request = vi.fn(async (method: string, params?: unknown) => {
    calls.push({ method, params })
    if (method === 'host.deploy') return status('pending')
    if (method === 'host.deployStatus') return snapshot.status
    if (method === 'host.log') return snapshot
    throw new Error(`unexpected ${method}`)
  })
  const peer = new PeerDeploy({
    links: () => links,
    link: (id) => (connected && links.some((l) => l.id === id) ? (request as never) : null)
  })
  return {
    peer,
    calls,
    setSnapshot: (text: string, s: DeployStatus) => {
      snapshot = { text, status: s }
    },
    disconnect: () => {
      connected = false
    },
    reconnect: () => {
      connected = true
    }
  }
}

describe('PeerDeploy', () => {
  it('refuses zero or several links and names them; one box is the box', () => {
    expect(() => setup([]).peer.resolveBox()).toThrow('no host is linked')
    expect(() =>
      setup([
        { id: 'a', name: 'Box A' },
        { id: 'b', name: 'Box B' }
      ]).peer.resolveBox()
    ).toThrow('several hosts are linked (Box A, Box B)')
    expect(setup().peer.resolveBox()).toBe('box')
  })

  it('fires host.deploy over the link, follows the log through host.log and the pushes, and reads the status', async () => {
    const { peer, calls, setSnapshot } = setup()
    await expect(peer.deploy('v1.0.283')).resolves.toMatchObject({ phase: 'pending' })
    expect(calls[0]).toEqual({ method: 'host.deploy', params: { ref: 'v1.0.283' } })
    setSnapshot('== box-update v1.0.283\n', status('running'))
    const heard: HostLogPush[] = []
    peer.subscribe(-7, (p) => heard.push(p))
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    expect(heard[0]).toEqual({ push: 'host-log', job: 'deploy', append: '== box-update v1.0.283\n', status: status('running') })
    // The box's pushes on the link reach the subscriber; other pushes and other jobs do not.
    expect(peer.onPeerPush('box', { push: 'host-log', job: 'deploy', append: 'SOURCE: release asset\n', status: status('running') })).toBe(true)
    expect(peer.onPeerPush('box', { push: 'host-log', job: 'publish', append: 'x', status: status('running') })).toBe(false)
    expect(peer.onPeerPush('other', { push: 'host-log', job: 'deploy', append: 'y', status: status('running') })).toBe(true)
    expect(heard).toHaveLength(2)
    expect(heard[1].append).toBe('SOURCE: release asset\n')
    await expect(peer.status()).resolves.toMatchObject({ phase: 'running' })
  })

  it('after the box restarted into the new build, the fresh snapshot feeds only the unseen tail and its done status closes the step', async () => {
    const { peer, setSnapshot, disconnect, reconnect } = setup()
    await peer.deploy('v1.0.283')
    setSnapshot('== box-update v1.0.283\nSOURCE: asset\n', status('running'))
    const heard: HostLogPush[] = []
    peer.subscribe(-7, (p) => heard.push(p))
    await vi.waitFor(() => expect(heard).toHaveLength(1))
    peer.onPeerPush('box', { push: 'host-log', job: 'deploy', append: 'TRIAL PASS: ok\n', status: status('running') })
    disconnect()
    peer.linkUp('box')
    expect(heard).toHaveLength(2)
    // The new process re-read the whole file and finished.
    setSnapshot('== box-update v1.0.283\nSOURCE: asset\nTRIAL PASS: ok\nCOMMIT PASS: done\n== box-update exited 0\n', status('done', 0))
    reconnect()
    peer.linkUp('box')
    await vi.waitFor(() => expect(heard).toHaveLength(3))
    expect(heard[2]).toEqual({
      push: 'host-log',
      job: 'deploy',
      append: 'COMMIT PASS: done\n== box-update exited 0\n',
      status: status('done', 0)
    })
    // A link-up of another host, or with nobody subscribed, asks nothing.
    peer.linkUp('other')
    heard.length = 0
    peer.subscribe(-7, () => {})()
    peer.linkUp('box')
    await new Promise((r) => setTimeout(r, 5))
    expect(heard).toEqual([])
  })

  it('status without a link answers the last status it heard, else refuses', async () => {
    const { peer, disconnect } = setup()
    await expect(peer.status()).rejects.toThrow('the box is not connected')
    await peer.deploy('master')
    disconnect()
    await expect(peer.status()).resolves.toMatchObject({ phase: 'pending' })
  })
})
