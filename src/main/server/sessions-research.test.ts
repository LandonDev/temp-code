import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'

/** One controlled driver: every send is recorded. */
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
let wsPath: string
let wtPath: string

beforeEach(async () => {
  sends.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-research-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  wsPath = join(root, 'repo')
  wtPath = join(root, 'worktree')
  await mkdir(wsPath)
  await mkdir(wtPath)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: wsPath, git: true, createdAt: 1 })
  // A worktree project: its threads run in the worktree, not the checkout.
  store.insertProject({
    id: 'p1',
    workspaceId: 'ws1',
    name: 'feature',
    mode: 'worktree',
    branch: 'tc/feature',
    cwd: wtPath,
    archived: false,
    createdAt: 1
  })
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const reportsDir = (): string => join(wsPath, '.temp-code', 'reports')

describe('reports root', () => {
  it('a research thread in a worktree project mints its report under the workspace root', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'research', provider: 'claude' })
    expect(s.cwd).toBe(wtPath)
    expect(s.planPath).toBe(join(reportsDir(), `${s.id}.md`))
    expect(registry.reportsRootFor(s)).toBe(wsPath)
  })

  it('retyping into research mints the workspace-rooted path and retyping out releases it', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    expect(s.planPath).toBeNull()
    await registry.retype(s.id, 'research')
    expect(store.getSession(s.id)?.planPath).toBe(join(reportsDir(), `${s.id}.md`))
    await registry.retype(s.id, 'implementation')
    expect(store.getSession(s.id)?.planPath).toBeNull()
    await registry.retype(s.id, 'research')
    await registry.retype(s.id, 'planning')
    // A plan lives in the project cwd; a report path never masquerades as one.
    expect(store.getSession(s.id)?.planPath).toBe(join(wtPath, '.temp-code', `plan-${s.id}.md`))
  })

  it('an older cwd-rooted report path is still released on retype', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'research', provider: 'claude' })
    store.updateSession(s.id, { planPath: join(wtPath, '.temp-code', 'reports', `${s.id}.md`) })
    await registry.retype(s.id, 'chat')
    expect(store.getSession(s.id)?.planPath).toBeNull()
  })

  it('a loose research session falls back to its cwd', async () => {
    const s = await registry.create({ cwd: root, threadType: 'research', provider: 'claude' })
    expect(s.planPath).toBe(join(root, '.temp-code', 'reports', `${s.id}.md`))
    expect(registry.reportsRootFor(s)).toBe(root)
  })

  it('a workspace chat without a project uses the workspace path', async () => {
    const s = await registry.create({ workspaceId: 'ws1', threadType: 'research', provider: 'claude' })
    expect(s.planPath).toBe(join(reportsDir(), `${s.id}.md`))
  })
})

describe('plan seed', () => {
  it('a child with a planPath (its angle file) gets no plan seed, a root with one does', async () => {
    const root = await registry.create({ projectId: 'p1', threadType: 'research', provider: 'claude' })
    const child = await registry.create({
      projectId: 'p1',
      provider: 'claude',
      parentId: root.id,
      agentType: 'explorer',
      planPath: join(wsPath, '.temp-code', 'reports', root.id, 'angle-abc123.md')
    })
    await registry.send(child.id, 'investigate the angle')
    expect(sends).toHaveLength(1)
    expect(sends[0]).not.toContain('The plan for this work is in')
    expect(sends[0]).toContain('investigate the angle')
    const impl = await registry.create({
      projectId: 'p1',
      threadType: 'implementation',
      provider: 'claude',
      planPath: join(wtPath, '.temp-code', 'plan-x.md')
    })
    await registry.send(impl.id, 'build it')
    expect(sends[1]).toContain('The plan for this work is in')
  })
})
