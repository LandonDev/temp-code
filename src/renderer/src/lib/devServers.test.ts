import { beforeEach, describe, expect, it } from 'vitest'
import type { DevRun } from '@server/shared/contract-devservers'
import { applyDevRunPush, devHosts, devLogKey, devServerStore, dueToOpen, openDevLog, openedDevLogs, resetOpenedDevLogs, targetLabel } from './devServers'
import { projectStore } from '../stores/project'
import { currentDock, terminals } from '../stores/terminals'
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

describe('the console opening on its own', () => {
  const PROJECT = '/srv/agents/work/site'
  const source = (resourceId: string) => ({ environmentId: 'env_box', resourceId })
  const dock = () => currentDock(PROJECT)
  beforeEach(() => {
    resetOpenedDevLogs()
    projectStore.setState({ projectCwd: PROJECT, selectedProjectId: null })
    terminals.setDocks([])
  })

  it('opens each server once, ever: a closed tab stays closed', () => {
    const servers = [{ source: source('r1') }, { source: source('r2') }]
    expect(dueToOpen(servers, openedDevLogs())).toEqual(servers)
    openDevLog(source('r1'), 'web :3001', { quiet: true })
    expect(dueToOpen(servers, openedDevLogs())).toEqual([servers[1]])
    // Closing the tab forgets nothing.
    terminals.setDocks([])
    expect(dueToOpen(servers, openedDevLogs()).map((s) => devLogKey(s.source))).toEqual(['env_box/r2'])
  })

  it('opens a closed dock on the new tab, and leaves the tab an open dock shows selected', () => {
    openDevLog(source('r1'), 'web :3001', { quiet: true })
    expect(dock()?.open).toBe(true)
    const first = dock()?.pane.activeFileId
    expect(dock()?.pane.files.find((f) => f.id === first)?.devLog).toEqual(source('r1'))
    openDevLog(source('r2'), 'expo :8081', { quiet: true })
    expect(dock()?.pane.files).toHaveLength(2)
    expect(dock()?.pane.activeFileId).toBe(first)
    // Asked again quietly, an existing tab is left alone; asked by a click, it is shown.
    openDevLog(source('r2'), 'expo :8081', { quiet: true })
    expect(dock()?.pane.files).toHaveLength(2)
    expect(dock()?.pane.activeFileId).toBe(first)
    openDevLog(source('r2'), 'expo :8081')
    expect(dock()?.pane.files.find((f) => f.id === dock()?.pane.activeFileId)?.devLog).toEqual(source('r2'))
  })

  it('selects the new tab when the dock was closed', () => {
    openDevLog(source('r1'), 'web :3001', { quiet: true })
    terminals.updateDock(PROJECT, (d) => ({ ...d, open: false }))
    openDevLog(source('r2'), 'expo :8081', { quiet: true })
    expect(dock()?.open).toBe(true)
    expect(dock()?.pane.files.find((f) => f.id === dock()?.pane.activeFileId)?.devLog).toEqual(source('r2'))
  })
})
