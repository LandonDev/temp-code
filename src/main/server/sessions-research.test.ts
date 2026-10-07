import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry, shellReadUrls } from './sessions'

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

// ── the board: shell reads and citations ────────────────────────────

type Source = Extract<import('@shared/events').AgentEvent, { type: 'research-source' }>
const sourcesOf = (id: string): Source[] =>
  store.eventsAfter(id, 0).map((r) => r.event).filter((e): e is Source => e.type === 'research-source')

async function tree(): Promise<{ root: string; child: string }> {
  const root = await registry.create({ projectId: 'p1', threadType: 'research', provider: 'claude' })
  const child = await registry.create({ projectId: 'p1', provider: 'claude', parentId: root.id, agentType: 'explorer', title: 'Pricing angle' })
  return { root: root.id, child: child.id }
}

describe('shellReadUrls', () => {
  it('boards what curl and wget read, never other commands or private hosts', () => {
    expect(shellReadUrls('curl -sL https://a.dev/page | head -50')).toEqual(['https://a.dev/page'])
    expect(shellReadUrls('wget -qO- "https://b.org/x?y=1" > /tmp/x')).toEqual(['https://b.org/x?y=1'])
    expect(shellReadUrls('cd /tmp && curl https://a.dev/1 https://a.dev/2 https://a.dev/1')).toEqual(['https://a.dev/1', 'https://a.dev/2'])
    expect(shellReadUrls('git clone https://github.com/x/y.git')).toEqual([])
    expect(shellReadUrls('bun install https://registry.npmjs.org/x')).toEqual([])
    expect(shellReadUrls('gh api https://api.github.com/repos/x')).toEqual([])
    expect(shellReadUrls('curl http://localhost:3000/api')).toEqual([])
    expect(shellReadUrls('curl http://127.0.0.1:8787/x https://10.0.0.5/y http://192.168.1.2/ http://box.local/')).toEqual([])
    expect(shellReadUrls('echo "see curl docs at https://curl.se"')).toEqual(['https://curl.se'])
    expect(shellReadUrls('ls')).toEqual([])
  })
})

describe('shell reads on the board', () => {
  it('a curl in a research tree boards its url once per agent and takes the title from the whole result', async () => {
    const { root, child } = await tree()
    registry.append(child, { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'curl -sL https://a.dev/page' } })
    registry.append(child, { type: 'tool-call', callId: 'c2', name: 'Bash', input: { command: 'curl -sL https://a.dev/page | wc' } })
    const filler = `<html><head><style>${'x'.repeat(5000)}</style><title>A page</title></head></html>`
    registry.append(child, { type: 'tool-result', callId: 'c1', output: filler, isError: false })
    const rows = sourcesOf(root)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ callId: `${child}:c1`, url: 'https://a.dev/page', agentId: child, agentLabel: 'Pricing angle' })
    expect(rows[1]).toMatchObject({ callId: `${child}:c1`, title: 'A page' })
    // wget boards too (codex's shell tool name as well); git clone and localhost never.
    registry.append(child, { type: 'tool-call', callId: 'c3', name: 'shell', input: { command: 'wget -qO- https://b.org/doc' } })
    registry.append(child, { type: 'tool-call', callId: 'c4', name: 'Bash', input: { command: 'git clone https://github.com/x/y' } })
    registry.append(child, { type: 'tool-call', callId: 'c5', name: 'Bash', input: { command: 'curl http://localhost:5173/' } })
    expect(sourcesOf(root).map((r) => r.url)).toEqual(['https://a.dev/page', 'https://a.dev/page', 'https://b.org/doc'])
    // Several urls in one command board bare rows, no title registration.
    registry.append(child, { type: 'tool-call', callId: 'c6', name: 'Bash', input: { command: 'curl https://c.io/1 https://c.io/2' } })
    registry.append(child, { type: 'tool-result', callId: 'c6', output: '<title>nope</title>', isError: false })
    const tail = sourcesOf(root).slice(-2)
    expect(tail.map((r) => [r.callId, r.url])).toEqual([[`${child}:c6:0`, 'https://c.io/1'], [`${child}:c6:1`, 'https://c.io/2']])
    expect(tail.some((r) => r.title)).toBe(false)
  })

  it('nothing boards outside a research tree', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    registry.append(s.id, { type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'curl https://a.dev' } })
    expect(sourcesOf(s.id)).toEqual([])
  })
})

describe('citeSource', () => {
  it('refuses outside a research tree', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    expect(registry.citeSource(s.id, { url: 'https://a.dev', claim: 'x' })).toMatch(/^refused/)
    expect(sourcesOf(s.id)).toEqual([])
  })

  it('merges the first claim onto a fetched row, then adds cite: rows', async () => {
    const { root, child } = await tree()
    registry.append(child, { type: 'tool-call', callId: 'f1', name: 'WebFetch', input: { url: 'https://a.dev/x' } })
    expect(registry.citeSource(child, { url: 'https://a.dev/x', claim: 'A charges $42 a seat', title: 'A pricing' })).toContain('on its fetched row')
    let rows = sourcesOf(root)
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ callId: `${child}:f1`, url: 'https://a.dev/x', claim: 'A charges $42 a seat', title: 'A pricing' })
    // A second claim for the same url is its own row; so is an uncited url.
    registry.citeSource(child, { url: 'https://a.dev/x', claim: 'A has a free tier' })
    registry.citeSource(child, { url: 'https://b.org/y', claim: '  B  \n has none ' })
    rows = sourcesOf(root)
    expect(rows).toHaveLength(4)
    expect(rows[2].callId).toMatch(/^cite:/)
    expect(rows[2]).toMatchObject({ url: 'https://a.dev/x', claim: 'A has a free tier' })
    expect(rows[3]).toMatchObject({ url: 'https://b.org/y', claim: 'B has none', agentId: child })
    expect(rows[3].callId).not.toBe(rows[2].callId)
    // A fetch of the cited url after the citation does not add a bare twin.
    registry.append(child, { type: 'tool-call', callId: 'f2', name: 'WebFetch', input: { url: 'https://b.org/y' } })
    expect(sourcesOf(root)).toHaveLength(4)
    // The root itself can cite.
    expect(registry.citeSource(root, { url: 'https://c.io', claim: 'C' })).toContain('cited')
    expect(sourcesOf(root).at(-1)).toMatchObject({ agentId: root, claim: 'C' })
    // An empty claim is refused.
    expect(registry.citeSource(child, { url: 'https://d.io', claim: '  ' })).toMatch(/^refused/)
  })
})
