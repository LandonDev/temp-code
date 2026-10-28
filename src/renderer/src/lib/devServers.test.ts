import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DevRun } from '@server/shared/contract-devservers'
import type { ThreadResource } from '@server/shared/contract-resources'
import { commandWords, listenerWords } from '@server/shared/devServerWords'
import { applyDevRunPush, applyHostRuns, devHosts, devTabOf, runChoice, serverGroups, threadRoot, devServerStore, liveServers, shownServer, targetLabel, type LiveServerSources } from './devServers'
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

  it('labels a target by its app and what it starts', () => {
    expect(targetLabel({ name: 'web', what: 'Vite dev server' })).toBe('web (Vite dev server)')
    expect(targetLabel({ name: 'TempCode', what: 'iOS app in the Simulator' })).toBe('TempCode (iOS app in the Simulator)')
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
  it('lists running runs and listening ports, newest first, each in plain words under its thread', () => {
    const list = liveServers(
      sources({
        runs: { 'env_mac/p1': [run({ id: 'r1', startedAt: 9, what: 'Vite dev server', ports: [{ port: 5173, url: 'http://localhost:5173' }] }), run({ id: 'r0', status: 'stopped' })] },
        resources: { t1: [port()] }
      })
    )
    expect(list.map((s) => [s.key, s.title, s.port?.number, s.owner])).toEqual([
      ['env_mac/r1', 'Vite dev server', 5173, 'site'],
      ['env_box/res1', 'Dev server', 3007, 'Coins page']
    ])
    expect(list[1]).toMatchObject({ environmentId: 'env_box', sessionId: 't1', resource: { id: 'res1', sessionId: 't1' }, runId: null })
  })

  it("carries a ledger row's call and command, and a run's command with no call", () => {
    const list = liveServers(
      sources({
        runs: { 'env_mac/p1': [run({ id: 'r1', startedAt: 9, ports: [{ port: 5173, url: 'http://localhost:5173' }] })] },
        resources: { t1: [port({ callId: 'toolu_7' })] }
      })
    )
    expect(list[0]).toMatchObject({ key: 'env_mac/r1', callId: null, command: run({}).command })
    expect(list[1]).toMatchObject({ key: 'env_box/res1', callId: 'toolu_7', command: 'cd apps/web && bun run dev' })
    expect(liveServers(sources({ resources: { t1: [port()] } }))[0].callId).toBeNull()
    // A label that is the server's URL or its port names no command; a guarded call's label loses the host's marks.
    const command = (label: string) => liveServers(sources({ resources: { t1: [port({ label })] } }))[0].command
    expect(command('http://localhost:3007')).toBeNull()
    expect(command(':3007')).toBeNull()
    expect(command('node :3007')).toBeNull()
    expect(command("export TEMP_CODE_THREAD='t1' TEMP_CODE_CALL='toolu_1'; bun run dev")).toBe('bun run dev')
    // A URL-labelled row takes the command of the background task that shares its call.
    const announced = liveServers(sources({ resources: { t1: [port({ label: 'http://localhost:3007', callId: 'toolu_7' })] }, callCommand: (id) => (id === 'toolu_7' ? 'bun run dev' : null) }))
    expect(announced[0].command).toBe('bun run dev')
  })

  it('titles a port row by what the host says its process is, else by its label', () => {
    const list = liveServers(sources({ resources: { t1: [port({ what: 'Bun server' }), port({ id: 'res2', identifier: '3008', label: 'npx vite --port 3008' })] } }))
    expect(Object.fromEntries(list.map((s) => [s.key, s.title]))).toEqual({ 'env_box/res1': 'Bun server', 'env_box/res2': 'Vite dev server' })
  })

  it('names a listener by its process first, then the command that opened it', () => {
    expect(listenerWords('bun src/server.ts', 'http://localhost:3000')).toBe('Bun server')
    expect(listenerWords('/usr/bin/node /w/node_modules/.bin/vite', 'bun run dev')).toBe('Vite dev server')
    expect(listenerWords('bun run dev', 'npx next dev')).toBe('Next.js dev server')
    expect(listenerWords(null, 'http://localhost:3000')).toBe('Dev server')
  })

  it('reads a command past its package runner', () => {
    expect(commandWords('cd apps/web && bun run dev')).toBe('Dev server')
    expect(commandWords('npx vite --port 3007')).toBe('Vite dev server')
    expect(commandWords('pnpm next dev')).toBe('Next.js dev server')
    expect(commandWords('bun --hot src/index.ts')).toBe('Bun server')
  })

  it('files a run under the thread it was started for, and a port a run holds once', () => {
    const list = liveServers(
      sources({
        runs: { 'env_box/p9': [run({ id: 'r1', sessionId: 't1', startedAt: 9, ports: [{ port: 3007, url: 'http://localhost:3007' }] })] },
        resources: { t1: [port()] }
      })
    )
    expect(list.map((s) => [s.key, s.sessionId, s.owner])).toEqual([['env_box/r1', 't1', 'Coins page']])
  })

  it('groups the servers under their threads, the group with the newest server first', () => {
    const list = liveServers(
      sources({
        runs: { 'env_box/p9': [run({ id: 'mine', projectId: 'p9', startedAt: 20, ports: [] }), run({ id: 'r2', projectId: 'p9', sessionId: 't1', startedAt: 10, ports: [] })] },
        resources: { t1: [port({ createdAt: 15 })] }
      })
    )
    expect(serverGroups(list).map((g) => [g.owner, g.servers.map((s) => s.key)])).toEqual([
      ['cosmicweb', ['env_box/mine']],
      ['Coins page', ['env_box/res1', 'env_box/r2']]
    ])
  })

  it('asks before a second server for the same thread, and only then', () => {
    const list = liveServers(sources({ resources: { t1: [port()] } }))
    expect(runChoice(list, 't1')).toBe('ask')
    expect(runChoice(list, 't2')).toBe('start')
    expect(runChoice(list, null)).toBe('start')
    expect(runChoice([], 't1')).toBe('start')
  })

  it('files a subagent’s server under its root thread', () => {
    const parents: Record<string, string> = { sub2: 'sub1', sub1: 'root' }
    expect(threadRoot('sub2', (id) => parents[id])).toBe('root')
    expect(threadRoot('root', (id) => parents[id])).toBe('root')
  })

  it('drops a row the moment the host does: removed, or a finished run', () => {
    const list = liveServers(
      sources({
        runs: { 'env_box/p9': [run({ status: 'failed' }), run({ id: 'b', status: 'stopped' })] },
        resources: { t1: [port({ removedAt: 10 })] }
      })
    )
    expect(list).toEqual([])
  })

  it('keeps a server whose stop waits on its host, saying why, until the host drops it', () => {
    const list = liveServers(sources({ resources: { t1: [port({ id: 'res2', removeRequestedAt: 10, note: 'Mac offline, waiting' })] } }))
    expect(list.map((s) => [s.key, s.stopping])).toEqual([['env_box/res2', 'Mac offline, waiting']])
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
            port({ id: 'gate', identifier: '44575', label: '/srv/agents/home/.bun/bin/bun scripts/gate.ts --tier commit --since ee6c899' }),
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

describe('devTabOf', () => {
  it('shows the tab when a host can serve the project, a server runs, or the pane is open', () => {
    expect(devTabOf({ servable: true, count: 0, open: false })).toEqual({ count: 0 })
    expect(devTabOf({ servable: false, count: 2, open: false })).toEqual({ count: 2 })
    expect(devTabOf({ servable: false, count: 0, open: true })).toEqual({ count: 0 })
  })

  it('hides it when none of them holds', () => {
    expect(devTabOf({ servable: false, count: 0, open: false })).toBeNull()
  })
})
