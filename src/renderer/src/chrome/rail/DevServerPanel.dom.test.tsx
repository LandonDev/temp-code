import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun, DevTarget } from '@server/shared/contract-devservers'
import { mountProbe } from '../../test/renderProbe'
import { registry } from '../../lib/connection/registry'
import { macBridgeStore } from '../../lib/macBridge'
import { applyDevRunPush, devServerStore, type DevHost } from '../../lib/devServers'
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
    localStorage.clear()
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

  it('runs the target on the chosen host and streams its console, with the forward to open', async () => {
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    const root = probe.container
    // Two hosts with a copy: the choice shows; this Mac has one target, so the menu reads as a label.
    const radios = [...root.querySelectorAll('[role="radio"]')]
    expect(radios.map((r) => r.textContent)).toEqual(['This Mac', 'box'])
    expect((root.querySelector('[aria-label="Dev server target"]') as HTMLButtonElement).disabled).toBe(true)
    await probe.act(async () => (radios[1] as HTMLButtonElement).click())
    await flush()
    expect((root.querySelector('[aria-label="Dev server target"]') as HTMLButtonElement).disabled).toBe(false)
    expect(root.textContent).toContain('bun run dev')

    const runButton = [...root.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith('Run')) as HTMLButtonElement
    await probe.act(async () => runButton.click())
    await flush()
    expect(requests.find((r) => r[1] === 'devServer.start')).toEqual(['env_box', 'devServer.start', { projectId: 'p2', targetId: 'apps/web#dev' }])

    probe.act(() => applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p2', run: run(), lines: ['  ➜  Local:   http://localhost:5173/'] }))
    expect(root.querySelector('[data-dev-console]')?.textContent).toContain('Local:   http://localhost:5173/')
    const open = root.querySelector('[data-dev-port]') as HTMLButtonElement
    expect(open.textContent).toBe('Open on the Mac:5174')
    expect(open.title).toBe('http://localhost:5174 · 5173 is taken here')
    expect([...root.querySelectorAll('button')].some((b) => b.textContent?.trim().startsWith('Stop'))).toBe(true)
  })

  it('says when there is nothing to serve, and shows no host choice for a project on one host', async () => {
    hosts = [{ environmentId: 'env_mac', name: 'This Mac', projectId: 'p1' }]
    vi.spyOn(registry, 'linkOf').mockImplementation(() => ({ request: async () => ({ targets: [], runs: [] }) }) as never)
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    expect(probe.container.querySelector('[role="radiogroup"]')).toBeNull()
    expect(probe.container.textContent).toContain('No dev script, Expo app or Xcode project here')
  })

  it('ends a finished run with its outcome', async () => {
    probe = mountProbe(<DevServerPanel projectId="p1" />)
    await flush()
    probe.act(() =>
      applyDevRunPush('env_mac', { push: 'dev-run', projectId: 'p1', run: run({ projectId: 'p1', status: 'failed', exitCode: 1, endedAt: Date.now(), ports: [] }), lines: ['boom'] })
    )
    expect(probe.container.textContent).toContain('Exited with 1')
  })
})
