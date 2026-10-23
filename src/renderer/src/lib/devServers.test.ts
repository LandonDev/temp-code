import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import { applyDevRunPush, applyHostRuns, devHosts, devServerStore, liveServers, shownServer, targetLabel, type LiveServerSources } from './devServers'
import { devPane, devPaneStore, resetDevPane } from './devPane'
import { pairWorkspaces } from './projectPairs'

const run = (over: Partial<DevRun> = {}): DevRun => ({
  id: 'a',
  projectId: 'p1',
  targetId: '.#dev',
  name: 'site',
  script: 'dev',
  kind: 'web',
  command: 'bun run dev',
  cwd: '/x',
  status: 'running',
  pid: 1,
  startedAt: 1,
  endedAt: null,
  exitCode: null,
  ports: [],
  ...over
})

describe('devServers', () => {
  beforeEach(() => devServerStore.setState({ targets: {}, runs: {}, logs: {} }))

  it('appends a run’s lines and lets a target’s new run replace its finished one', () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run(), lines: ['one'] })
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run(), lines: ['two'] })
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run({ status: 'stopped' }), lines: [] })
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run({ id: 'b', startedAt: 2 }), lines: [] })
    const s = devServerStore.getState()
    expect(s.logs.a).toEqual(['one', 'two'])
    expect(s.runs['env_box/p1'].map((r) => r.id)).toEqual(['b'])
  })

  it('offers the project’s own host first, then each open host with a copy', () => {
    const workspaces = [
      { id: 'w1', environmentId: 'env_mac', path: '/Users/l/site', name: 'site', githubRepo: 'l/site' },
      { id: 'w2', environmentId: 'env_box', path: '/srv/agents/work/site', name: 'site', githubRepo: 'l/site' },
      { id: 'w3', environmentId: 'env_far', path: '/far/site', name: 'site', githubRepo: 'l/site' }
    ] as never
    const projects = [
      { id: 'p1', environmentId: 'env_mac', cwd: '/Users/l/site' },
      { id: 'p2', environmentId: 'env_box', cwd: '/srv/agents/work/site/' }
    ]
    const envs = [
      { id: 'env_box', name: 'box' },
      { id: 'env_mac', name: 'This Mac' },
      { id: 'env_far', name: 'far' },
      { id: 'web', name: 'web' }
    ]
    expect(devHosts(projects[0], envs, (id) => id !== 'env_off', pairWorkspaces(workspaces), projects)).toEqual([
      { environmentId: 'env_mac', name: 'This Mac', projectId: 'p1' },
      { environmentId: 'env_box', name: 'box', projectId: 'p2' },
      { environmentId: 'env_far', name: 'far', projectId: null }
    ])
    expect(devHosts(projects[0], envs, (id) => id === 'env_mac', pairWorkspaces(workspaces), projects).map((h) => h.environmentId)).toEqual(['env_mac'])
  })

  it('labels a target by its package and script, an iOS one by its scheme', () => {
    expect(targetLabel({ name: 'web', script: 'dev', framework: 'vite', kind: 'web' })).toBe('web · dev')
    expect(targetLabel({ name: 'TempCode', script: 'TempCode', framework: 'xcode', kind: 'ios' })).toBe('TempCode · iOS')
  })
})

const port = (over: Partial<ThreadResource> = {}): ThreadResource =>
  ({
    id: 'res1',
    sessionId: 't1',
    environmentId: 'env_box',
    kind: 'port',
    identifier: '3007',
    label: 'cd apps/web && bun run dev',
    branch: null,
    createdAt: 5,
    removeRequestedAt: null,
    removedAt: null,
    note: null,
    ...over
  }) as ThreadResource

const sources = (over: Partial<LiveServerSources> = {}): LiveServerSources => ({
  runs: {},
  resources: {},
  thread: (id) => (id === 't1' ? { environmentId: 'env_box', projectId: 'p9', title: 'Coins page' } : null),
  projectName: (env, id) => (env === 'env_box' && id === 'p9' ? 'cosmicweb' : null),
  ...over
})

describe('the live dev servers', () => {
  it('lists running runs and listening ports, newest first, titled by target or project and port', () => {
    const list = liveServers(
      sources({
        runs: { 'env_mac/p1': [run({ id: 'r1', startedAt: 9, ports: [{ port: 5173, url: 'http://localhost:5173' }] }), run({ id: 'r0', status: 'stopped' })] },
        resources: { t1: [port()] }
      })
    )
    expect(list.map((s) => [s.key, s.title, s.port?.number])).toEqual([
      ['env_mac/r1', 'site · dev', 5173],
      ['env_box/res1', 'cosmicweb :3007', 3007]
    ])
    expect(list[1]).toMatchObject({ environmentId: 'env_box', thread: 'Coins page', resource: { id: 'res1', sessionId: 't1' }, runId: null })
  })

  it('drops a row the moment the host does: removed, being removed, or a finished run', () => {
    const list = liveServers(
      sources({
        runs: { 'env_box/p9': [run({ status: 'failed' }), run({ id: 'b', status: 'stopped' })] },
        resources: { t1: [port({ removedAt: 10 }), port({ id: 'res2', removeRequestedAt: 10 })] }
      })
    )
    expect(list).toEqual([])
  })

  it('never lists databases, MCP servers, proxies or other resource kinds', () => {
    const list = liveServers(
      sources({
        resources: {
          t1: [
            port({ id: 'db', identifier: '5432', label: 'postgres -D data' }),
            port({ id: 'mcp', identifier: '3333', label: 'npx -y chrome-devtools-mcp@latest' }),
            port({ id: 'proxy', identifier: '8080', label: 'caddy reverse-proxy --to :3000' }),
            port({ id: 'wt', kind: 'worktree', identifier: '/srv/x' }),
            port({ id: 'web', identifier: '3002', label: 'python3 -m http.server 3002' })
          ]
        }
      })
    )
    expect(list.map((s) => s.key)).toEqual(['env_box/web'])
  })

  it('skips a thread this window does not know', () => {
    expect(liveServers(sources({ resources: { gone: [port({ sessionId: 'gone' })] } }))).toEqual([])
  })

  it('shows the picked row while it lives, else the newest', () => {
    const list = liveServers(sources({ resources: { t1: [port(), port({ id: 'res2', createdAt: 9 })] } }))
    expect(shownServer(list, 'env_box/res1')?.key).toBe('env_box/res1')
    expect(shownServer(list, 'env_box/gone')?.key).toBe('env_box/res2')
    expect(shownServer([], 'env_box/res1')).toBeNull()
  })

  it('takes a host’s running runs as the truth for that host, keeping finished ones', () => {
    devServerStore.setState({ targets: {}, runs: {}, logs: {} })
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run({ id: 'gone' }), lines: [] })
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run({ id: 'old', targetId: 'x', status: 'stopped' }), lines: [] })
    applyDevRunPush('env_mac', { push: 'dev-run', projectId: 'p1', run: run({ id: 'mac' }), lines: [] })
    applyHostRuns('env_box', [run({ id: 'new', projectId: 'p2', targetId: 'y' })])
    const runs = devServerStore.getState().runs
    expect(runs['env_box/p1'].map((r) => r.id)).toEqual(['old'])
    expect(runs['env_box/p2'].map((r) => r.id)).toEqual(['new'])
    expect(runs['env_mac/p1'].map((r) => r.id)).toEqual(['mac'])
  })
})

describe('the Dev servers pane', () => {
  beforeEach(() => {
    const saved = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k)
    })
    resetDevPane()
  })

  it('is closed by default and nothing in the model opens it', () => {
    expect(devPaneStore.getState().open).toBe(false)
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p1', run: run({ id: 'z' }), lines: ['ready'] })
    applyHostRuns('env_box', [run({ id: 'y' })])
    expect(devPaneStore.getState().open).toBe(false)
  })

  it('remembers open and its height across launches, not the picked row', () => {
    devPane.open('env_box/r1')
    devPane.size(300)
    expect(devPaneStore.getState()).toMatchObject({ open: true, picked: 'env_box/r1', size: 300 })
    resetDevPane()
    expect(devPaneStore.getState()).toMatchObject({ open: true, picked: null, size: 300 })
    devPane.close()
    resetDevPane()
    expect(devPaneStore.getState().open).toBe(false)
  })
})
