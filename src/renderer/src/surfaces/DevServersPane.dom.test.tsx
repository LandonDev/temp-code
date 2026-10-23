import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import { mountProbe } from '../test/renderProbe'
import { registry } from '../lib/connection/registry'
import { devPane, devPaneStore, resetDevPane } from '../lib/devPane'
import { applyDevRunPush, devServerStore } from '../lib/devServers'
import { macBridgeStore } from '../lib/macBridge'
import { threadResourcesStore } from '../lib/threadResources'
import { DevServersPane } from './DevServersPane'

const requests: [string, string, unknown][] = []
const request = (env: string) => async (method: string, params: unknown) => {
  requests.push([env, method, params])
  if (method === 'devServer.stop') return { run: run({ status: 'stopped', ports: [] }) }
  if (method === 'resources.remove') return { results: [] }
  return { runs: [], resources: [] }
}

vi.mock('./DevConsole', () => ({
  DevConsole: ({ source }: { source: { runId?: string; resourceId?: string } }) => <div data-console={source.runId ?? source.resourceId} />
}))
vi.mock('../lib/tcserver/workspaces', () => ({
  useProjects: () => [{ id: 'p9', environmentId: 'env_box', cwd: '/srv/agents/work/cosmicweb', workspaceId: 'w', name: 'cosmicweb' }],
  useWorkspaces: () => []
}))
vi.mock('../lib/tcserver/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tcserver/store')>()
  return {
    ...real,
    useServerSessions: () => [{ id: 't1', projectId: 'p9', title: 'Coins page' }],
    sessionStore: { ...real.sessionStore, environmentOf: () => 'env_box', linkFor: () => ({ request: request('env_box') }) }
  }
})

const run = (over: Partial<DevRun> = {}): DevRun => ({
  id: 'run1',
  projectId: 'p9',
  targetId: 'apps/web#dev',
  name: 'web',
  script: 'dev',
  kind: 'web',
  command: 'bun run dev',
  cwd: '/srv/agents/work/cosmicweb/apps/web',
  status: 'running',
  pid: 9,
  startedAt: 1,
  endedAt: null,
  exitCode: null,
  ports: [{ port: 5173, url: 'http://localhost:5173', forwards: [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 5174, error: null }] }],
  ...over
})
const port = (over: Partial<ThreadResource> = {}): ThreadResource => ({
  id: 'res1',
  sessionId: 't1',
  environmentId: 'env_box',
  kind: 'port',
  identifier: '3007',
  label: 'bun run dev',
  branch: null,
  createdAt: 5,
  removeRequestedAt: null,
  removedAt: null,
  note: null,
  forwards: [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 3007, error: null }],
  ...over
})

describe('DevServersPane', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  const mount = () => {
    probe = mountProbe(<DevServersPane onSizePaint={() => {}} onSizeCommit={() => {}} onShowTerminal={() => {}} />)
  }
  const rows = () => [...probe!.container.querySelectorAll('[data-dev-server]')].map((r) => r.getAttribute('data-dev-server'))
  const shown = () => probe!.container.querySelector('[data-console]')?.getAttribute('data-console')

  beforeEach(() => {
    localStorage.clear()
    resetDevPane()
    requests.length = 0
    devServerStore.setState({ targets: {}, runs: {}, logs: {} })
    threadResourcesStore.setState({ bySession: {} })
    macBridgeStore.setState({ localId: 'env_mac' })
    vi.spyOn(registry, 'linkOf').mockImplementation((env: string) => ({ request: request(env) }) as never)
  })
  afterEach(() => {
    probe?.unmount()
    probe = null
    vi.restoreAllMocks()
  })

  it('says one quiet line when nothing runs', () => {
    mount()
    expect(probe!.container.textContent).toContain('No dev servers running')
    expect(probe!.container.querySelector('[role="listbox"]')).toBeNull()
  })

  it('lists live servers newest first and shows the newest one’s console', async () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    threadResourcesStore.setState({ bySession: { t1: [port()] } })
    mount()
    expect(rows()).toEqual(['env_box/res1', 'env_box/run1'])
    expect(probe!.container.textContent).toContain('cosmicweb :3007')
    expect(probe!.container.textContent).toContain('web · dev')
    expect(shown()).toBe('res1')
    const open = [...probe!.container.querySelectorAll('button')].map((b) => b.textContent)
    expect(open).toContain('Open on the Mac :5174')
    expect(open).toContain('Open on the Mac :3007')

    await probe!.act(async () => (probe!.container.querySelector('[data-dev-server="env_box/run1"] [role="option"]') as HTMLElement).click())
    expect(shown()).toBe('run1')
  })

  it('drops a row the moment its host does, with no ending left behind', async () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    threadResourcesStore.setState({ bySession: { t1: [port()] } })
    mount()
    devPane.pick('env_box/run1')
    await probe!.act(async () => applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run({ status: 'stopped', ports: [] }), lines: [] }))
    expect(rows()).toEqual(['env_box/res1'])
    expect(shown()).toBe('res1')
    await probe!.act(async () => threadResourcesStore.setState({ bySession: { t1: [port({ removedAt: 10, note: 'stopped listening' })] } }))
    expect(rows()).toEqual([])
    expect(probe!.container.textContent).toContain('No dev servers running')
    expect(probe!.container.textContent).not.toContain('Exited')
  })

  it('stops a run on its host and an agent’s server through its ledger', async () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    threadResourcesStore.setState({ bySession: { t1: [port()] } })
    mount()
    for (const key of ['env_box/run1', 'env_box/res1'])
      await probe!.act(async () => (probe!.container.querySelector(`[data-dev-server="${key}"] [aria-label="Stop"]`) as HTMLElement).click())
    expect(requests).toContainEqual(['env_box', 'devServer.stop', { runId: 'run1' }])
    expect(requests).toContainEqual(['env_box', 'resources.remove', { sessionId: 't1', ids: ['res1'] }])
  })

  it('never opens itself', () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: ['ready'] })
    expect(devPaneStore.getState().open).toBe(false)
  })
})
