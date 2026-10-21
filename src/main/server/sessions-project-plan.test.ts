import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

const sends: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async () => ({
        send: async (text: string) => {
          sends.push(text)
        },
        interrupt: () => {},
        dispose: async () => {}
      })
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let cwd: string

beforeEach(async () => {
  sends.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-project-plan-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  cwd = join(root, 'repo')
  await mkdir(cwd)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: cwd, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'acme', mode: 'local', branch: null, cwd, archived: false, createdAt: 1 })
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const projectMd = (): string => join(cwd, '.temp-code', 'plans', 'project.md')

describe('project-plan threads', () => {
  it('own the project plan file and the type title', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'project-plan', provider: 'claude' })
    expect(s.planPath).toBe(projectMd())
    expect(s.title).toBe('Project plan')
    expect(s.agentType).toBe('implementer')
  })

  it('the first message carries the project-plan brief and never a plan seed', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'project-plan', provider: 'claude' })
    await registry.send(s.id, 'plan it')
    const text = sends[0]
    expect(text).toContain('PROJECT PLAN thread')
    expect(text).toContain(`Write the plan to ${projectMd()}`)
    for (const section of ['## Goals', '## Current state', '## Milestones', '## Risks', '## Open questions']) {
      expect(text).toContain(section)
    }
    expect(text).toContain('call plan_complete once')
    expect(text).toContain('never start an implementation, planning or orchestration thread from here')
    expect(text).not.toContain('The plan for this work is in')
  })

  it('retyping into project-plan points at the project file; retyping away releases it', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    await registry.retype(s.id, 'project-plan')
    expect(registry.get(s.id)?.planPath).toBe(projectMd())
    await registry.retype(s.id, 'planning')
    expect(registry.get(s.id)?.planPath).toBe(join(cwd, '.temp-code', `plan-${s.id}.md`))
    await registry.retype(s.id, 'project-plan')
    await registry.retype(s.id, 'chat')
    expect(registry.get(s.id)?.planPath).toBeNull()
  })

  it('a build started from a project plan archives no planning thread and seeds nothing from it', async () => {
    const pp = await registry.create({ projectId: 'p1', threadType: 'project-plan', provider: 'claude' })
    const build = await registry.create({
      projectId: 'p1',
      threadType: 'implementation',
      provider: 'claude',
      planPath: pp.planPath ?? undefined
    })
    expect(registry.get(pp.id)?.archived).toBe(false)
    expect(build.planPath).toBe(projectMd())
  })
})
