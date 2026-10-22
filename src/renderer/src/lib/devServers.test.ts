import { beforeEach, describe, expect, it } from 'vitest'
import type { DevRun } from '@server/shared/contract-devservers'
import { applyDevRunPush, devHosts, devServerStore, targetLabel } from './devServers'
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
