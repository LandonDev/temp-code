import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { Batches, setBatches } from './batch'
import { cancelMirrors } from './mirror'
import { orchWaitForAgent, setOrchestrationRegistry, isMasterSession } from './orchestration'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { SessionMeta, AgentEvent } from '../../shared/events'

/**
 * The master thread on a real registry with a fake claude driver
 * (CLAUDE.md "Master threads", wave 3): a master with an open batch takes
 * watching for idle and idles when the batch closes; a person's message
 * reaches a watching master at once and a running one as a steer that a
 * wait_for_agent in flight returns on; Pause and Resume cascade to the
 * batch's roots.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const interrupts: string[] = []
/** The session each spawn was handed: the harness boots eagerly at create, before the pin. */
const spawnedWith = new Map<string, SessionMeta>()

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        spawnedWith.set(id, ctx.session)
        emits.set(id, ctx.emit)
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => void interrupts.push(id),
          alive: () => true,
          dispose: async () => {}
        }
      }
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
let batches: Batches
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-master-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  batches = new Batches({ registry, store, runGate: async () => ({ ok: true, log: 'stub', ms: 1, exitCode: 0 }), branchOf: async () => 'master' })
  batches.attach()
  setBatches(batches)
  emits.clear()
  sends.clear()
  interrupts.length = 0
})
afterEach(async () => {
  // A turn-complete arms the shared-context mirror's timer; it must not fire on a closed database.
  cancelMirrors()
  setBatches(null)
  batches.dispose()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const status = (id: string): string | undefined => store.getSession(id)?.status
const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
const idle = (id: string): void => emit(id, { type: 'status', status: 'idle' })
/** A child's turn ends the way the real driver ends it: turn-complete, then idle. */
const finish = (id: string): void => {
  emit(id, { type: 'turn-complete' } as AgentEvent)
  idle(id)
}

/** A project with a pinned master that has run one turn. */
async function pinnedMaster(): Promise<{ projectId: string; master: string }> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  const master = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, threadType: 'chat', title: 'Master' })
  registry.setMaster(master.id, true)
  await registry.send(master.id, 'open the batch')
  await settle()
  return { projectId: project.id, master: master.id }
}
/** A batch child. No projectId: a turn-complete on a project thread arms the
 *  shared-context mirror's timer, which would fire after this test's database
 *  closed; the batch reads masterId alone. */
async function child(_projectId: string, masterId: string, title: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', masterId, title })
  await registry.send(s.id, `work ${title}`)
  await settle()
  return s.id
}

describe('the watching master', () => {
  it('a master with no children idles as any thread; its harness was spawned with the pin', async () => {
    const { master } = await pinnedMaster()
    // The harness booted at create, before setMaster: the meta it holds has no pin, and the live read has it.
    expect(spawnedWith.get(master)?.isMaster).toBe(false)
    expect(isMasterSession(spawnedWith.get(master)!)).toBe(true)
    expect(status(master)).toBe('running')
    idle(master)
    await settle()
    expect(status(master)).toBe('idle')
  })

  it('with a child not done the master takes watching for idle; the batch closing idles it', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    expect(status(a)).toBe('running')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    // The ledger keeps a watching master for the boot resume.
    expect(store.listResumeAfterBoot().some((r) => r.sessionId === master)).toBe(true)
    // The child settles: its report wakes the master; the engine runs with
    // nothing landed and reports done; the master's next turn end is idle.
    finish(a)
    await settle(80)
    expect(status(master)).toBe('running')
    expect(sends.get(master)?.some((t) => t.includes('<subagent-report>'))).toBe(true)
    idle(master)
    await settle(80)
    // The batch-done report wakes it once more, then it idles for good.
    const last = sends.get(master)?.at(-1) ?? ''
    if (status(master) === 'running') {
      expect(last).toContain('<batch-report>')
      idle(master)
      await settle()
    }
    expect(status(master)).toBe('idle')
    expect(batches.open(master)).toBe(false)
  })

  it('a watching master whose children are all deleted idles without a wake', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    await registry.delete(a)
    await settle(50)
    expect(status(master)).toBe('idle')
  })

  it("a person's message to a watching master starts a turn at once", async () => {
    const { projectId, master } = await pinnedMaster()
    await child(projectId, master, 'A')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    await registry.send(master, 'how is it going?')
    await settle()
    expect(status(master)).toBe('running')
    expect(sends.get(master)?.at(-1)).toContain('how is it going?')
    expect(registry.queueList(master)).toEqual([])
  })
})

describe('the steer into a live master', () => {
  it('a queued message to a running master goes straight in as a user-steer, with its user row, and wakes a waiting wait_for_agent', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    expect(status(master)).toBe('running')
    const waiting = orchWaitForAgent(registry.get(master)!, { agentId: a })
    await settle()
    // The wait names the child on the master's meta while it holds.
    expect(registry.get(master)?.awaiting).toEqual([a])
    const added = registry.queueAdd(master, 'stop and report')
    expect(added.kind).toBe('steered')
    expect(registry.queueList(master)).toEqual([])
    expect(sends.get(master)?.at(-1)).toBe('<user-steer>\nstop and report\n</user-steer>')
    const rows = registry.eventsAfter(master, 0).filter((r) => r.event.type === 'user-text')
    expect((rows.at(-1)!.event as { text: string }).text).toBe('stop and report')
    const report = JSON.parse(await waiting) as { status: string; message: string }
    expect(report).toMatchObject({ status: 'steered', message: 'stop and report' })
    expect(registry.get(master)?.awaiting).toBeUndefined()
    // The child still runs; a later wait sees its settle.
    expect(status(a)).toBe('running')
  })

  it('a message with an attachment, and a plain queue to a non-master mid-turn, still queue', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    const withFile = registry.queueAdd(master, 'see this', { attachments: [{ path: '/x.png', name: 'x.png', kind: 'image' }] })
    expect(withFile.kind).toBe('queued')
    expect(registry.queueList(master)).toHaveLength(1)
    const plain = registry.queueAdd(a, 'later')
    expect(plain).toMatchObject({ kind: 'queued', item: { text: 'later' } })
    expect(registry.queueList(a)).toHaveLength(1)
    expect(sends.get(a)?.at(-1)).not.toContain('later')
  })

  it("a steer into a non-master mid-turn goes in with its user row and releases the parent's pending wait_for_agent", async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    await registry.send(parent.id, 'go')
    await settle()
    const kid = await registry.create({ cwd: root, provider: 'claude', parentId: parent.id, title: 'Kid' })
    await registry.send(kid.id, 'work')
    await settle()
    const waiting = orchWaitForAgent(registry.get(parent.id)!, { agentId: kid.id })
    await settle()
    expect(registry.get(parent.id)?.awaiting).toEqual([kid.id])
    const added = registry.queueAdd(parent.id, 'look at this first', { steer: true })
    expect(added.kind).toBe('steered')
    expect(registry.queueList(parent.id)).toEqual([])
    expect(sends.get(parent.id)?.at(-1)).toBe('<user-steer>\nlook at this first\n</user-steer>')
    const rows = registry.eventsAfter(parent.id, 0).filter((r) => r.event.type === 'user-text')
    expect((rows.at(-1)!.event as { text: string }).text).toBe('look at this first')
    expect(JSON.parse(await waiting)).toMatchObject({ status: 'steered', message: 'look at this first' })
    expect(registry.get(parent.id)?.awaiting).toBeUndefined()
    expect(status(kid.id)).toBe('running')
  })

  it("a send into a running thread releases a pending wait too; a settle report carries the child's status", async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    await registry.send(parent.id, 'go')
    await settle()
    const kid = await registry.create({ cwd: root, provider: 'claude', parentId: parent.id, title: 'Kid' })
    await registry.send(kid.id, 'work')
    await settle()
    const waiting = orchWaitForAgent(registry.get(parent.id)!, { agentId: kid.id })
    await settle()
    await registry.send(parent.id, 'and this')
    expect(JSON.parse(await waiting)).toMatchObject({ status: 'steered', message: 'and this' })
    const again = orchWaitForAgent(registry.get(parent.id)!, { agentId: kid.id })
    await settle()
    finish(kid.id)
    expect(JSON.parse(await again)).toMatchObject({ agentId: kid.id, status: 'idle' })
  })
})

describe('pause and resume cascade', () => {
  it('pausing the master pauses every root of its batch; resuming resumes them; a subagent of a child follows its root', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    const b = await child(projectId, master, 'B')
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: a })
    await registry.send(sub.id, 'sub work')
    await settle()
    const plain = await registry.create({ cwd: root, provider: 'claude', title: 'Plain' })
    await registry.send(plain.id, 'unrelated')
    await settle()
    await registry.pauseRun(master)
    expect([master, a, b, sub.id].map(status)).toEqual(['paused', 'paused', 'paused', 'paused'])
    expect(status(plain.id)).toBe('running')
    expect(interrupts).toEqual(expect.arrayContaining([master, a, b, sub.id]))
    await registry.resumePausedRun(master)
    await settle(50)
    expect([master, a, b].map(status).every((s) => s !== 'paused')).toBe(true)
  })

  it("pausing and resuming the master reach the batch's threads on other hosts through the engine's cascade", async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    const acts: string[] = []
    const far = {
      children: () => [{ environmentId: 'env_m', sessionId: 'x', title: 'Far', kind: 'started' as const, status: 'running' as const, cwd: '/x', provider: 'codex', model: 'g', agentType: 'implementer', masterId: master, seenAt: 1 }],
      refresh: async () => ({ children: [], unreachable: [] }),
      act: async (_m: string, action: string) => (acts.push(action), { succeeded: ['env_m:x'], failed: [] }),
      adopt: async () => ({ adopted: [], refused: [] })
    }
    batches.dispose()
    batches = new Batches({ registry, store, runGate: async () => ({ ok: true, log: 'stub', ms: 1, exitCode: 0 }), branchOf: async () => 'master', remote: far })
    batches.attach()
    setBatches(batches)
    await registry.pauseRun(master)
    expect([master, a].map(status)).toEqual(['paused', 'paused'])
    await registry.resumePausedRun(master)
    await settle(50)
    expect(acts).toEqual(['pause', 'resume'])
    // A child alone never cascades.
    await registry.pauseRun(a)
    expect(acts).toEqual(['pause', 'resume'])
  })

  it('pausing a child alone never touches its master or its siblings', async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    const b = await child(projectId, master, 'B')
    await registry.pauseRun(a)
    expect([master, a, b].map(status)).toEqual(['running', 'paused', 'running'])
  })
})

describe('the batch follows the starter', () => {
  it("create from a master carries the master's id; from a batch root it inherits; from a plain thread nothing; an explicit masterId wins", async () => {
    const { master } = await pinnedMaster()
    const plan = await registry.create({ cwd: root, provider: 'claude', startedBy: master, title: 'Plan' })
    expect(plan).toMatchObject({ masterId: master, startedBy: master })
    const build = await registry.create({ cwd: root, provider: 'claude', startedBy: plan.id, title: 'Build' })
    expect(build).toMatchObject({ masterId: master, startedBy: plan.id })
    const chat = await registry.create({ cwd: root, provider: 'claude', title: 'Chat' })
    const loose = await registry.create({ cwd: root, provider: 'claude', startedBy: chat.id, title: 'Loose' })
    expect(loose).toMatchObject({ masterId: null, startedBy: chat.id })
    const other = await registry.create({ cwd: root, provider: 'claude', startedBy: plan.id, masterId: chat.id, title: 'Other' })
    expect(other.masterId).toBe(chat.id)
  })

  it('setMaster pins and unpins a root, refuses a subagent, and pushes the meta', async () => {
    const t = await registry.create({ cwd: root, provider: 'claude', title: 'T' })
    const pushed: boolean[] = []
    const off = registry.onMeta((m) => {
      if (m.id === t.id) pushed.push(!!m.isMaster)
    })
    registry.setMaster(t.id, true)
    expect(registry.isMaster(t.id)).toBe(true)
    registry.setMaster(t.id, true)
    registry.setMaster(t.id, false)
    expect(registry.isMaster(t.id)).toBe(false)
    expect(pushed).toEqual([true, false])
    off()
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: t.id, title: 'Sub' })
    expect(() => registry.setMaster(sub.id, true)).toThrow(/subagent/)
    expect(() => registry.setMaster('nope', true)).toThrow(/unknown session/)
  })
})

describe('archive a batch', () => {
  it("done archives the children idle after a turn; all stops the live ones first and archives every one; the master stays", async () => {
    const { projectId, master } = await pinnedMaster()
    const a = await child(projectId, master, 'A')
    const b = await child(projectId, master, 'B')
    finish(a)
    await settle(80)
    const done = await batches.archive(master, 'done')
    expect(done.succeeded).toEqual([a])
    expect(store.getSession(a)?.archived).toBe(true)
    expect(store.getSession(b)?.archived).toBe(false)
    expect(status(b)).toBe('running')
    const all = await batches.archive(master, 'all')
    expect(all.succeeded).toEqual([b])
    expect(interrupts).toContain(b)
    expect(store.getSession(b)?.archived).toBe(true)
    expect(store.getSession(master)?.archived).toBe(false)
  })
})
