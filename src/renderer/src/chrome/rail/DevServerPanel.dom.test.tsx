import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun, DevTarget } from '@server/shared/contract-devservers'
import { mountProbe } from '../../test/renderProbe'
import { registry } from '../../lib/connection/registry'
import { macBridgeStore } from '../../lib/macBridge'
import { devServerStore, type DevHost } from '../../lib/devServers'
import { devPaneStore, resetDevPane } from '../../lib/devPane'
import { DevServerPanel } from './DevServerPanel'

const project = { id: 'p1', environmentId: 'env_mac', cwd: '/Users/l/site', workspaceId: 'w', name: 'site' }
let hosts: DevHost[] = []
vi.mock('../../lib/tcserver/workspaces', () => ({ useProjects: () => [project], useWorkspaces: () => [] }))
vi.mock('../../lib/devServers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/devServers')>()),
  useDevHosts: () => hosts
}))

const target = (id: string, over: Partial<DevTarget> = {}): DevTarget => ({ id, name: 'web', script: 'dev', kind: 'web', framework: 'vite', dir: 'apps/web', command: 'bun run dev', macOnly: false, ...over })
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

describe('DevServerPanel', () => {
  let probe: ReturnType<typeof mountProbe> | null = null
  const requests: [string, string, unknown][] = []
  beforeEach(() => {
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
    vi.spyOn(registry, 'linkOf').mockImplementation(
      (env: string) =>
        ({
          request: async (method: string, params: unknown) => {
            requests.push([env, method, params])
            if (method === 'devServer.targets')
              return env === 'env_box'
                ? { targets: [target('apps/web#dev'), target('apps/docs#dev', { name: 'docs', dir: 'apps/docs', framework: 'astro' })], runs: [] }
                : { targets: [target('apps/web#dev')], runs: [] }
            if (method === 'devServer.start') return { run: run({ projectId: (params as { projectId: string }).projectId, ports: [] }) }
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
    expect(requests).toContainEqual(['env_mac', 'devServer.start', { projectId: 'p1', targetId: 'apps/web#dev' }])
    expect(devPaneStore.getState()).toMatchObject({ open: true, picked: 'env_mac/run1' })
    expect(probe.container.querySelector('[aria-label="Stop"]')).toBeNull()
  })

})
