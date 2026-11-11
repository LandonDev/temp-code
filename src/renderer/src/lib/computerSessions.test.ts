import { describe, expect, it, vi } from 'vitest'
import type { ComputerServiceState, ComputerSessionRow } from '@server/shared/contract-computer'

type Listener = (link: FakeLink, event: 'added' | 'removed') => void
interface FakeLink {
  environmentId: string
  connected: boolean
  request: (method: string, params: unknown) => Promise<unknown>
  onPush: (fn: (push: { push: string; sessions?: ComputerSessionRow[]; service?: ComputerServiceState }) => void) => void
  onOpen: (fn: () => void) => void
  push?: (p: { push: string; sessions?: ComputerSessionRow[]; service?: ComputerServiceState }) => void
  open?: () => void
}
const linkListeners = vi.hoisted(() => new Set<(link: unknown, event: string) => void>())
vi.mock('./connection/registry', () => ({
  LOCAL_ENVIRONMENT_ID: 'local',
  registry: {
    onLink: (fn: (link: unknown, event: string) => void) => {
      linkListeners.add(fn)
      return () => linkListeners.delete(fn)
    }
  }
}))

const { asksOf, computerSessionsStore, entriesOf, startComputerSessions } = await import('./computerSessions')

const row = (threadId: string, over: Partial<ComputerSessionRow> = {}): ComputerSessionRow => ({
  threadId,
  since: 1,
  lastCallAt: 1,
  apps: [],
  running: null,
  tier: null,
  ...over
})

function fakeLink(environmentId: string, sessions: ComputerSessionRow[], fail = false): FakeLink {
  const link: FakeLink = {
    environmentId,
    connected: true,
    request: async (method) => {
      if (fail) throw new Error('unknown method')
      expect(method).toBe('computer.sessions')
      return { service: { state: 'unavailable', restarts: 0, permissions: null }, sessions }
    },
    onPush: (fn) => (link.push = fn),
    onOpen: (fn) => (link.open = fn)
  }
  return link
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('the computer sessions store', () => {
  it('reads each host once per link-up, follows its computer push, and forgets a host whose link went', async () => {
    startComputerSessions()
    const box = fakeLink('env_box', [row('b1', { macPeer: 'env_mac' })])
    const old = fakeLink('env_old', [], true)
    for (const l of linkListeners) {
      ;(l as Listener)(box, 'added')
      ;(l as Listener)(old, 'added')
    }
    await settle()
    expect(computerSessionsStore.getState().byHost.env_box?.map((r) => r.threadId)).toEqual(['b1'])
    expect(computerSessionsStore.getState().byHost.env_old).toBeUndefined()
    expect(computerSessionsStore.getState().serviceByHost.env_box).toMatchObject({ state: 'unavailable' })
    box.push!({ push: 'computer', sessions: [row('b2')], service: { state: 'up', restarts: 0, permissions: null } })
    expect(computerSessionsStore.getState().byHost.env_box?.map((r) => r.threadId)).toEqual(['b2'])
    expect(computerSessionsStore.getState().serviceByHost.env_box).toMatchObject({ state: 'up' })
    box.push!({ push: 'resources' })
    expect(computerSessionsStore.getState().byHost.env_box).toHaveLength(1)
    for (const l of linkListeners) (l as Listener)(box, 'removed')
    expect(computerSessionsStore.getState().byHost.env_box).toBeUndefined()
    expect(computerSessionsStore.getState().serviceByHost.env_box).toBeUndefined()
  })

  it('asks are the bridged rows with a card waiting, with the host that mirrors them', () => {
    const asking = row('b1', { macPeer: 'env_mac', macName: 'Studio', asking: { line: 'Click?' } })
    expect(asksOf({ env_box: [asking, row('b2', { macPeer: 'env_mac' }), row('m1', { asking: { line: 'local?' } })] })).toEqual([{ environmentId: 'env_box', row: asking }])
  })
})

describe('entriesOf', () => {
  const tree = new Set(['s1', 'sub1'])
  const mac = { macDesktop: true, localId: 'env_mac' }

  it("keeps the rows of the thread's tree, on the thread's host", () => {
    const entries = entriesOf([row('s1'), row('sub1'), row('other')], tree, 'local', mac)
    expect(entries.map((e) => [e.host, e.row.threadId])).toEqual([
      ['local', 's1'],
      ['local', 'sub1']
    ])
  })

  it("previews this Mac's own thread on its local link by the thread's id", () => {
    expect(entriesOf([row('s1')], tree, 'local', mac)[0]).toMatchObject({ previewable: true, previewHost: 'local', previewKey: 's1' })
  })

  it("previews a box thread that drives this Mac, on this Mac's link by the bridge's key", () => {
    const [e] = entriesOf([row('s1', { macPeer: 'env_mac', macName: 'Mac' })], tree, 'env_box', mac)
    expect(e).toMatchObject({ host: 'env_box', previewable: true, previewHost: 'local', previewKey: 'env_box:s1' })
  })

  it("never previews another Mac's session, a box row before this Mac's id is known, or anything off the Mac desktop", () => {
    expect(entriesOf([row('s1', { macPeer: 'env_other' })], tree, 'env_box', mac)[0].previewable).toBe(false)
    expect(entriesOf([row('s1', { macPeer: 'env_mac' })], tree, 'env_box', { macDesktop: true, localId: null })[0].previewable).toBe(false)
    expect(entriesOf([row('s1')], tree, 'local', { macDesktop: false, localId: 'env_mac' })[0]).toEqual({ host: 'local', row: row('s1'), previewable: false })
  })
})
