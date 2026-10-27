import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun, DevTarget } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import { mountProbe } from '../test/renderProbe'
import { registry } from '../lib/connection/registry'
import { devPane, devPaneStore, resetDevPane } from '../lib/devPane'
import { applyDevRunPush, devServerStore, type DevHost } from '../lib/devServers'
import { newTerminalFile } from '../lib/layout'
import { createProjectTerminal } from '../lib/projectTerminal'
import { initialProjectState, projectStore } from '../stores/project'
import { initialTerminalsState, currentDock, terminalsStore } from '../stores/terminals'
import { macBridgeStore } from '../lib/macBridge'
import { threadResourcesStore } from '../lib/threadResources'
import { commandLine, DevServersPane } from './DevServersPane'

const CWD = '/srv/agents/work/cosmicweb'
let targets: DevTarget[] | null = []
let hosts: DevHost[] = []
const requests: [string, string, unknown][] = []
const request = (env: string) => async (method: string, params: unknown) => {
  requests.push([env, method, params])
  if (method === 'devServer.stop') return { run: run({ status: 'stopped', ports: [] }) }
  if (method === 'resources.remove') return { results: [] }
  if (method === 'devServer.targets') return { targets, runs: devServerStore.getState().runs['env_box/p9'] ?? [] }
  return { runs: [], resources: [] }
}

vi.mock('./DevConsole', () => ({
  DevConsole: ({ source }: { source: { runId?: string; resourceId?: string } }) => <div data-console={source.runId ?? source.resourceId} />
}))
vi.mock('../lib/tcserver/workspaces', () => ({
  useProjects: () => [{ id: 'p9', environmentId: 'env_box', cwd: '/srv/agents/work/cosmicweb', workspaceId: 'w', name: 'cosmicweb', archived: false }],
  useWorkspaces: () => []
}))
vi.mock('../lib/devServers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/devServers')>()),
  useDevHosts: () => hosts
}))
vi.mock('../lib/tcserver/store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/tcserver/store')>()
  return {
    ...real,
    useServerSessions: () => [{ id: 't1', projectId: 'p9', title: 'Coins page' }],
    sessionStore: { ...real.sessionStore, environmentOf: () => 'env_box', linkFor: () => ({ request: request('env_box') }) }
  }
})

const target = (over: Partial<DevTarget> = {}): DevTarget => ({ id: 'apps/web#dev', name: 'web', script: 'dev', kind: 'web', framework: 'vite', dir: 'apps/web', command: 'bun run dev', macOnly: false, ...over })
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
  const onShowTerminal = vi.fn()
  const onSizeCommit = vi.fn()
  const mount = () => {
    probe = mountProbe(<DevServersPane onSizePaint={() => {}} onSizeCommit={onSizeCommit} onShowTerminal={onShowTerminal} />)
  }
  const flush = async () => {
    for (let i = 0; i < 5; i++) await probe!.act(async () => {})
  }
  const rows = () => [...probe!.container.querySelectorAll('[data-dev-server]')].map((r) => r.getAttribute('data-dev-server'))
  const shown = () => probe!.container.querySelector('[data-console]')?.getAttribute('data-console')

  beforeEach(() => {
    // jsdom has no Web Animations; Base UI asks for them on close.
    Element.prototype.getAnimations ??= () => []
    localStorage.clear()
    resetDevPane()
    devPane.open()
    targets = [target()]
    hosts = [{ environmentId: 'env_box', name: 'box', projectId: 'p9' }]
    onShowTerminal.mockReset()
    onSizeCommit.mockReset()
    projectStore.setState(initialProjectState({ projectCwd: CWD }), true)
    terminalsStore.setState(initialTerminalsState(), true)
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

  it('says nothing runs and shows the command Run would start', async () => {
    mount()
    await flush()
    const empty = probe!.container.querySelector('[data-slot="empty"]')!
    expect(empty.textContent).toBe('No dev servers running' + 'bun run dev')
    expect(probe!.container.querySelector('[data-dev-server]')).toBeNull()
  })

  it('says why nothing can run: no target, or a host that cannot say', async () => {
    targets = []
    mount()
    await flush()
    expect(probe!.container.querySelector('[data-slot="empty"]')!.textContent).toContain('Nothing to serve here')
    probe!.unmount()
    devServerStore.setState({ targets: {}, runs: {}, logs: {} })
    targets = null
    vi.spyOn(registry, 'linkOf').mockImplementation(() => ({ request: async () => { throw new Error('no method') } }) as never)
    mount()
    await flush()
    expect(probe!.container.querySelector('[data-slot="empty"]')!.textContent).toContain("This host can't run dev servers")
  })

  it('shortens an Xcode target to xcodebuild and its scheme', () => {
    expect(commandLine({ command: 'cd ios\nxcodebuild -scheme App', script: 'App' })).toBe('xcodebuild  App')
    expect(commandLine({ command: 'bun run dev', script: 'dev' })).toBe('bun run dev')
  })

  it('lists live servers newest first and shows the newest one’s console', async () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    threadResourcesStore.setState({ bySession: { t1: [port()] } })
    mount()
    expect(rows()).toEqual(['env_box/res1', 'env_box/run1'])
    expect(probe!.container.textContent).toContain('cosmicweb :3007')
    expect(probe!.container.textContent).toContain('web · dev')
    expect(shown()).toBe('res1')
    await probe!.act(async () => (probe!.container.querySelector('[data-dev-server="env_box/run1"]') as HTMLElement).click())
    expect(shown()).toBe('run1')
    expect(probe!.container.querySelector('[data-dev-server="env_box/run1"]')!.getAttribute('aria-current')).toBe('true')
  })

  it('opens the forwarded URL from a link reading "Open on the Mac :5174"', async () => {
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null)
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    mount()
    const link = [...probe!.container.querySelectorAll('[data-dev-server] button')].find((b) => b.textContent === 'Open on the Mac :5174') as HTMLElement
    await probe!.act(async () => link.click())
    expect(opened).toHaveBeenCalledWith('http://localhost:5174', '_blank', 'noopener')
    expect(probe!.container.textContent).toContain('5173 is taken here')
  })

  it('a terminal tab selects that terminal and shows the terminals', async () => {
    const a = { ...newTerminalFile(CWD, 'zsh'), id: 'ta' }
    const b = { ...newTerminalFile(CWD, 'build'), id: 'tb' }
    const dock = createProjectTerminal(CWD, a)
    terminalsStore.setState(initialTerminalsState([{ ...dock, pane: { ...dock.pane, files: [a, b] } }]), true)
    mount()
    const tab = [...probe!.container.querySelectorAll('[role="tab"]')].find((t) => t.textContent === 'build') as HTMLElement
    await probe!.act(async () => tab.click())
    expect(currentDock(CWD)?.pane.activeFileId).toBe('tb')
    expect(onShowTerminal).toHaveBeenCalledTimes(1)
  })

  it('hide closes the pane and the dock under it', async () => {
    terminalsStore.setState(initialTerminalsState([createProjectTerminal(CWD, newTerminalFile(CWD))]), true)
    mount()
    await probe!.act(async () => (probe!.container.querySelector('[aria-label="Hide panel"]') as HTMLElement).click())
    expect(devPaneStore.getState().open).toBe(false)
    expect(currentDock(CWD)?.open).toBe(false)
  })

  it('takes the dock’s height, and a resize sets both', async () => {
    terminalsStore.setState(initialTerminalsState([{ ...createProjectTerminal(CWD, newTerminalFile(CWD)), size: 300 }]), true)
    mount()
    expect(devPaneStore.getState().size).toBe(300)
    const sash = probe!.container.querySelector('[role="separator"]') as HTMLElement
    await probe!.act(async () => sash.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))
    expect(onSizeCommit).toHaveBeenCalledWith(220)
    expect(currentDock(CWD)?.size).toBe(220)
  })

  it('drops a row the moment its host does, with no ending left behind', async () => {
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: [] })
    threadResourcesStore.setState({ bySession: { t1: [port()] } })
    mount()
    await flush()
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
    localStorage.clear()
    resetDevPane()
    applyDevRunPush('env_box', { push: 'dev-run', projectId: 'p9', run: run(), lines: ['ready'] })
    expect(devPaneStore.getState().open).toBe(false)
  })
})
