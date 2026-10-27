import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun, DevTarget } from '@server/shared/contract-devservers'
import { mountProbe } from '../test/renderProbe'
import { registry } from '../lib/connection/registry'
import { macBridgeStore } from '../lib/macBridge'
import { applyDevRunPush, devServerStore, type DevHost } from '../lib/devServers'
import { sessionStore } from '../lib/tcserver/store'
import { devPaneStore, resetDevPane } from '../lib/devPane'
import { selectChunk } from './chunks'
import { DevStarter, useDevStarter } from './DevStarter'

/** The starter for one project, as the Dev servers pane mounts it. */
function DevServerPanel({ projectId }: { projectId: string }) {
  return <DevStarter starter={useDevStarter(projectId)} />
}

const project = { id: 'p1', environmentId: 'env_mac', cwd: '/Users/l/site', workspaceId: 'w', name: 'site' }
let hosts: DevHost[] = []
vi.mock('../lib/tcserver/workspaces', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tcserver/workspaces')>()),
  useProjects: () => [project],
  useWorkspaces: () => []
}))
vi.mock('../stores/project', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../stores/project')>()),
  useActivePane: () => ({ activeTab: undefined, active: { id: 't1', parentId: null } })
}))
vi.mock('../lib/tcserver/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/tcserver/store')>()),
  useServerSessions: () => [{ id: 't1', projectId: 'p1', title: 'Coins page', parentId: null }]
}))
vi.mock('../lib/devServers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/devServers')>()),
  useDevHosts: () => hosts
}))

const target = (id: string, over: Partial<DevTarget> = {}): DevTarget => ({ id, name: 'web', script: 'dev', kind: 'web', framework: 'vite', dir: 'apps/web', command: 'bun run dev', macOnly: false, what: 'Vite dev server', ...over })
const run = (over: Partial<DevRun> = {}): DevRun => ({
  id: 'run1',
  projectId: 'p2',
  targetId: 'apps/web#dev',
  name: 'web',
  script: 'dev',
  kind: 'web',
  command: 'bun run dev',
  cwd: '/srv/agents/work/site/apps/web',
  status: 'running',
  pid: 9,
  startedAt: Date.now() - 5_000,
  endedAt: null,
  exitCode: null,
  ports: [{ port: 5173, url: 'http://localhost:5173', forwards: [{ environmentId: 'env_mac', hostName: 'Mac', macPort: 5174, error: null }] }],
  ...over
})

describe('DevStarter', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  const requests: [string, string, unknown][] = []
  /** What the fake host answers `devServer.start` with when set (the one-per-thread question). */
  let startAnswer: unknown = null
  beforeEach(async () => {
    // The target Select rides its own chunk; load it so it mounts at once.
    await selectChunk.load()
    // jsdom has no scrolling; the console follows its tail through scrollTo.
    Element.prototype.scrollTo = () => {}
    Element.prototype.getAnimations ??= () => []
    localStorage.clear()
    resetDevPane()
    devServerStore.setState({ targets: {}, runs: {}, logs: {} })
    macBridgeStore.setState({ localId: 'env_mac' })
    hosts = [
      { environmentId: 'env_mac', name: 'This Mac', projectId: 'p1' },
      { environmentId: 'env_box', name: 'box', projectId: 'p2' }
    ]
    requests.length = 0
    startAnswer = null
    vi.spyOn(registry, 'linkOf').mockImplementation(
      (env: string) =>
        ({
          request: async (method: string, params: unknown) => {
            requests.push([env, method, params])
            if (method === 'devServer.targets')
              return env === 'env_box'
                ? { targets: [target('apps/web#dev'), target('apps/docs#dev', { name: 'docs', dir: 'apps/docs', framework: 'astro' })], runs: [] }
                : { targets: [target('apps/web#dev')], runs: devServerStore.getState().runs[`${env}/${(params as { projectId: string }).projectId}`] ?? [] }
            if (method === 'devServer.start') return startAnswer ?? { run: run({ projectId: (params as { projectId: string }).projectId, ports: [] }) }
            if (method === 'devServer.log') return { run: run(), lines: [] }
            if (method === 'devServer.stop') return { run: run({ status: 'stopped', endedAt: Date.now(), ports: [] }) }
            throw new Error(method)
          }
        }) as never
    )
  })
  afterEach(() => {
    probe?.unmount()
    probe = null
    vi.restoreAllMocks()
  })
  const flush = async () => {
    for (let i = 0; i < 5; i++) await probe!.act(async () => {})
  }

  it('says when there is nothing to serve, and shows no host choice for a project on one host', async () => {
    hosts = [{ environmentId: 'env_mac', name: 'This Mac', projectId: 'p1' }]
    vi.spyOn(registry, 'linkOf').mockImplementation(() => ({ request: async () => ({ targets: [], runs: [] }) }) as never)
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    expect(probe.container.querySelector('[aria-label="Run on"]')).toBeNull()
    expect(probe.container.textContent).toContain('No targets')
    const run = [...probe.container.querySelectorAll('button')].find((b) => b.textContent === 'Run') as HTMLButtonElement
    expect(run.disabled).toBe(true)
  })

  it('shows a skeleton in the target field while the host answers', async () => {
    vi.spyOn(registry, 'linkOf').mockImplementation(() => ({ request: () => new Promise(() => {}) }) as never)
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    expect(probe.container.querySelector('[data-dev-target-skeleton]')).not.toBeNull()
    expect(probe.container.querySelector('[aria-label="Dev server target"]')).toBeNull()
  })

  it('offers each host with a copy of the project, this one picked', async () => {
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const group = probe.container.querySelector('[aria-label="Run on"]')!
    const items = [...group.querySelectorAll('button')]
    expect(items.map((b) => b.textContent)).toEqual(['This Mac', 'box'])
    expect(items[0].getAttribute('aria-pressed')).toBe('true')
  })

  it('starts the target and shows the run in the Dev servers pane, listing nothing itself', async () => {
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const button = [...probe.container.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Run')) as HTMLElement
    await probe.act(async () => button.click())
    await flush()
    expect(requests).toContainEqual(['env_mac', 'devServer.start', { projectId: 'p1', targetId: 'apps/web#dev', sessionId: 't1' }])
    expect(devPaneStore.getState()).toMatchObject({ open: true, picked: 'env_mac/run1' })
    expect(probe.container.querySelector('[aria-label="Stop"]')).toBeNull()
  })

  it('asks before a second dev server for the thread on screen, and Replace stops the first', async () => {
    vi.spyOn(sessionStore, 'environmentOf').mockReturnValue('env_mac')
    applyDevRunPush('env_mac', { push: 'dev-run', projectId: 'p1', run: run({ projectId: 'p1', sessionId: 't1' }), lines: [] })
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const button = (name: string) => [...probe!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLElement
    await probe.act(async () => button('Run').click())
    expect(probe.container.textContent).toContain('This thread already runs a dev server. Replace it, or start another for a different feature?')
    expect(requests.some(([, m]) => m === 'devServer.start')).toBe(false)
    await probe.act(async () => button('Replace').click())
    await flush()
    expect(requests.map(([, m, p]) => [m, p])).toEqual(
      expect.arrayContaining([
        ['devServer.stop', { runId: 'run1' }],
        ['devServer.start', { projectId: 'p1', targetId: 'apps/web#dev', sessionId: 't1', replace: true }]
      ])
    )
    expect(requests.findIndex(([, m]) => m === 'devServer.stop')).toBeLessThan(requests.findIndex(([, m]) => m === 'devServer.start'))
    expect(probe.container.querySelector('[data-dev-replace]')).toBeNull()
  })

  it('starts another beside the first when the person says it is for a different feature', async () => {
    vi.spyOn(sessionStore, 'environmentOf').mockReturnValue('env_mac')
    applyDevRunPush('env_mac', { push: 'dev-run', projectId: 'p1', run: run({ projectId: 'p1', sessionId: 't1' }), lines: [] })
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const button = (name: string) => [...probe!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLElement
    await probe.act(async () => button('Run').click())
    await probe.act(async () => button('Start another').click())
    await flush()
    expect(requests.some(([, m]) => m === 'devServer.stop')).toBe(false)
    expect(requests).toContainEqual(['env_mac', 'devServer.start', { projectId: 'p1', targetId: 'apps/web#dev', sessionId: 't1', another: true }])
  })

  it("asks the same question when the host answers Run with the thread's existing server this pane did not know of", async () => {
    vi.spyOn(sessionStore, 'environmentOf').mockReturnValue('env_mac')
    startAnswer = { replace: true, existing: [{ runId: null, resourceId: 'res9', label: 'npx vite' }] }
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const button = (name: string) => [...probe!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLElement
    await probe.act(async () => button('Run').click())
    await flush()
    expect(requests).toContainEqual(['env_mac', 'devServer.start', { projectId: 'p1', targetId: 'apps/web#dev', sessionId: 't1' }])
    expect(probe.container.textContent).toContain('This thread already runs a dev server. Replace it, or start another for a different feature?')
    expect(devPaneStore.getState().open).toBe(false)
    startAnswer = null
    await probe.act(async () => button('Start another').click())
    await flush()
    expect(requests).toContainEqual(['env_mac', 'devServer.start', { projectId: 'p1', targetId: 'apps/web#dev', sessionId: 't1', another: true }])
    expect(devPaneStore.getState()).toMatchObject({ open: true, picked: 'env_mac/run1' })
  })

  it('does not start the new server when the old one did not stop, and says why', async () => {
    vi.spyOn(sessionStore, 'environmentOf').mockReturnValue('env_mac')
    const { threadResourcesStore } = await import('../lib/threadResources')
    threadResourcesStore.setState({
      bySession: {
        t1: [{ id: 'res1', sessionId: 't1', environmentId: 'env_mac', kind: 'port', identifier: '3007', label: 'npx vite', branch: null, createdAt: 5, removeRequestedAt: null, removedAt: null, note: null }]
      }
    })
    const real = registry.linkOf
    vi.spyOn(registry, 'linkOf').mockImplementation((env: string) => {
      const link = (real as unknown as (e: string) => { request: (m: string, p: unknown) => Promise<unknown> })(env)
      return {
        request: async (method: string, params: unknown) => {
          if (method === 'resources.remove') {
            requests.push([env, method, params])
            return { results: [{ id: 'res1', outcome: 'failed', note: 'kill: permission denied' }] }
          }
          return link.request(method, params)
        }
      } as never
    })
    vi.spyOn(sessionStore, 'linkFor').mockImplementation(() => registry.linkOf('env_mac') as never)
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const button = (name: string) => [...probe!.container.querySelectorAll('button')].find((b) => b.textContent?.trim() === name) as HTMLElement
    await probe.act(async () => button('Run').click())
    await probe.act(async () => button('Replace').click())
    await flush()
    expect(requests.some(([, m]) => m === 'resources.remove')).toBe(true)
    expect(requests.some(([, m]) => m === 'devServer.start')).toBe(false)
    expect(probe.container.textContent).toContain('kill: permission denied')
    threadResourcesStore.setState({ bySession: {} })
  })
})
