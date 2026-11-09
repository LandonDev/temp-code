import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { Batches, setBatches } from './batch'
import { cancelMirrors } from './mirror'
import { INTERRUPT_WORDS, MASTER_MECHANICS, orchCheckAgent, orchInterruptAgent, orchSendToAgent, setOrchestrationRegistry } from './orchestration'
import { ARCHIVE_THREADS_TOOL_DESCRIPTION } from '@shared/gate'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent, SessionMeta } from '../../shared/events'
import type { BatchState } from '@shared/contract-batch'

/**
 * Stop, archive and delete on a master's batch children, every action over
 * every kind of child, on a real registry with a fake claude driver: the
 * master's own tools (interrupt_agent, archive_threads, batch.archive) and
 * the person's (session.interrupt as stopRun/stopSubtree, session.archive,
 * session.delete, the fleet's Remove from queue). docs/master-threads.md
 * "Stopping, archiving and deleting a batch thread".
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const interrupts: string[] = []
const gate: { boot: Promise<void> | null } = { boot: null }

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
        if (gate.boot && ctx.session.title === 'booting') await gate.boot
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          // A turn the driver is told to stop ends the way the CLI's does.
          interrupt: () => {
            interrupts.push(id)
            ctx.emit({ type: 'error', message: 'turn ended: interrupted' } as AgentEvent)
            ctx.emit({ type: 'status', status: 'idle' })
          },
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
  root = await mkdtemp(join(tmpdir(), 'tc-batch-actions-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  batches = new Batches({ registry, store, pushEveryMs: 0, runGate: async () => ({ ok: true, log: 'stub', ms: 1, exitCode: 0 }), branchOf: async () => 'master' })
  batches.attach()
  setBatches(batches)
  emits.clear()
  sends.clear()
  interrupts.length = 0
  gate.boot = null
})
afterEach(async () => {
  cancelMirrors()
  setBatches(null)
  batches.dispose()
  await registry.close()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const meta = (id: string): SessionMeta | null => registry.get(id)
const finish = (id: string): void => {
  emits.get(id)!({ type: 'turn-complete' } as AgentEvent)
  emits.get(id)!({ type: 'status', status: 'idle' })
}

async function pinnedMaster(): Promise<SessionMeta> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  const master = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, threadType: 'chat', title: 'Master' })
  registry.setMaster(master.id, true)
  await registry.send(master.id, 'open the batch')
  await settle()
  return registry.get(master.id)!
}

/** A batch child the way each path makes one; `after` makes it queued. */
async function child(masterId: string, title: string, opts: { after?: string; startedBy?: string; adopt?: boolean } = {}): Promise<string> {
  const s = await registry.create({
    cwd: root,
    provider: 'claude',
    title,
    ...(opts.adopt ? {} : { masterId }),
    ...(opts.after ? { after: opts.after } : {}),
    ...(opts.startedBy ? { startedBy: opts.startedBy } : {})
  })
  if (opts.adopt) expect(batches.adopt(masterId, [s.id]).adopted).toEqual([s.id])
  await registry.send(s.id, `work ${title}`)
  await settle()
  return s.id
}

/** A child that has finished a turn: the `after` a queued sibling waits on is met by it. */
async function doneChild(masterId: string, title: string): Promise<string> {
  const id = await child(masterId, title)
  finish(id)
  await settle()
  return id
}

describe("the master's interrupt_agent on each kind of batch thread", () => {
  it('a working thread stops; a thread a batch thread started and one adopted stop the same way', async () => {
    const master = await pinnedMaster()
    const working = await child(master.id, 'working')
    const plan = await child(master.id, 'plan')
    const build = await child(master.id, 'build', { startedBy: plan })
    const adopted = await child(master.id, 'adopted', { adopt: true })
    for (const id of [working, build, adopted]) {
      expect(meta(id)?.status).toBe('running')
      expect(await orchInterruptAgent(master, id)).toBe(INTERRUPT_WORDS.thread)
      await settle()
      expect(meta(id)?.status).toBe('idle')
    }
    expect(meta(build)?.masterId).toBe(master.id)
  })

  it('a queued thread leaves the queue unstarted and archived: it never gets its message, even once its `after` is met', async () => {
    const master = await pinnedMaster()
    const first = await child(master.id, 'first')
    const queued = await child(master.id, 'queued', { after: first })
    expect(meta(queued)?.status).toBe('queued')
    expect(await orchInterruptAgent(master, queued)).toBe(INTERRUPT_WORDS.dequeued)
    await settle()
    expect(meta(queued)).toMatchObject({ archived: true })
    expect(sends.get(queued)).toBeUndefined()
    // Its sibling finishing never releases it.
    finish(first)
    await settle(60)
    expect(sends.get(queued)).toBeUndefined()
    expect(registry.batchChildren(master.id).map((s) => s.id)).toEqual([first])
  })

  it('a thread whose harness is still booting is put down unsent', async () => {
    const master = await pinnedMaster()
    let release!: () => void
    gate.boot = new Promise((r) => (release = r))
    const s = await registry.create({ cwd: root, provider: 'claude', masterId: master.id, title: 'booting' })
    const sent = registry.send(s.id, 'go').catch(() => {})
    await settle()
    expect(meta(s.id)?.status).toBe('starting')
    expect(await orchInterruptAgent(master, s.id)).toBe(INTERRUPT_WORDS.thread)
    release()
    await sent
    await settle()
    expect(meta(s.id)?.status).toBe('idle')
    expect(sends.get(s.id)).toBeUndefined()
  })

  it("a batch thread stops with its own subagents, which would otherwise report back and wake it", async () => {
    const master = await pinnedMaster()
    const batchThread = await child(master.id, 'with a subagent')
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: batchThread, title: 'sub' })
    await registry.send(sub.id, 'dig')
    await settle()
    expect(meta(sub.id)?.status).toBe('running')
    await orchInterruptAgent(master, batchThread)
    await settle()
    expect(meta(batchThread)?.status).toBe('idle')
    expect(meta(sub.id)?.status).toBe('idle')
    expect(interrupts).toEqual(expect.arrayContaining([batchThread, sub.id]))
  })

  it('refusals say why and what to do instead', async () => {
    const master = await pinnedMaster()
    const batchThread = await child(master.id, 'Payments')
    const grandchild = await registry.create({ cwd: root, provider: 'claude', parentId: batchThread, title: 'grandchild' })
    const other = await registry.create({ cwd: root, provider: 'claude', title: 'Other master' })
    registry.setMaster(other.id, true)
    const theirs = await registry.create({ cwd: root, provider: 'claude', masterId: other.id, title: 'theirs' })
    const loose = await registry.create({ cwd: root, provider: 'claude', title: 'loose' })
    expect(await orchInterruptAgent(master, grandchild.id)).toBe(
      `refused: ${grandchild.id} is a subagent of your batch thread "Payments" (${batchThread}); act on that thread instead (interrupt_agent stops it with its subagents, send_to_agent redirects it).`
    )
    expect(await orchInterruptAgent(master, theirs.id)).toContain("belongs to another master's batch")
    expect(await orchSendToAgent(master, loose.id, 'hi')).toContain('is not in your batch; adopt_thread brings it in')
    expect(await orchCheckAgent(master, 'nope')).toBe("refused: there is no thread nope on this host. list_agents shows the ids you can act on.")
    expect(await orchInterruptAgent(master, master.id)).toBe('refused: that is this thread itself.')
    // Nothing refused was touched.
    expect(meta(theirs.id)?.status).not.toBe('stopped')
  })
})

describe("the master's archive_threads", () => {
  it('by id: a running thread stops then archives, a queued one never starts, a done one archives; refusals are named', async () => {
    const master = await pinnedMaster()
    const done = await doneChild(master.id, 'Done one')
    const working = await child(master.id, 'Working one')
    const queued = await child(master.id, 'Queued one', { after: working })
    const loose = await registry.create({ cwd: root, provider: 'claude', title: 'loose' })
    const answer = await batches.archiveTool(master, { threadIds: [done, working, queued, loose.id] })
    expect(answer).toBe(`Archived 3: "Done one", "Working one", "Queued one". Refused: ${loose.id} (not in your batch).`)
    await settle(60)
    for (const id of [done, working, queued]) expect(meta(id)?.archived).toBe(true)
    expect(interrupts).toContain(working)
    expect(sends.get(queued)).toBeUndefined()
    expect(registry.batchChildren(master.id)).toEqual([])
  })

  it('which: done leaves the live ones; all takes the queued ones out before stopping their siblings', async () => {
    const master = await pinnedMaster()
    const done = await doneChild(master.id, 'Finished')
    const working = await doneChild(master.id, 'Again')
    await registry.send(working, 'one more turn')
    await settle()
    const queued = await child(master.id, 'Waits on Again', { after: working })
    expect(meta(queued)?.status).toBe('queued')
    expect(await batches.archiveTool(master, { which: 'done' })).toBe('Archived 1: "Finished".')
    expect(meta(working)?.archived).toBe(false)
    // Stopping `working` meets the queued thread's `after` (it completed a turn): it must not start first.
    expect(await batches.archiveTool(master, { which: 'all' })).toBe('Archived 2: "Waits on Again", "Again".')
    await settle(60)
    expect(sends.get(queued)).toBeUndefined()
    expect([done, working, queued].map((id) => meta(id)?.archived)).toEqual([true, true, true])
    expect(await batches.archiveTool(master, { which: 'done' })).toBe('Nothing to archive: no thread of your batch is done.')
  })

  it('asks for exactly one of which and threadIds, and only a master may call it', async () => {
    const master = await pinnedMaster()
    expect(await batches.archiveTool(master, {})).toBe('refused: pass `which` (done or all) or `threadIds`, one of them')
    expect(await batches.archiveTool(master, { which: 'all', threadIds: ['x'] })).toBe('refused: pass `which` (done or all) or `threadIds`, one of them')
    const plain = await registry.create({ cwd: root, provider: 'claude', title: 'plain' })
    expect(await batches.archiveTool(plain, { which: 'all' })).toContain('is for a master thread')
  })

  it('the master is told it archives and never deletes', () => {
    expect(MASTER_MECHANICS).toContain('archive_threads takes threads out')
    expect(MASTER_MECHANICS).toContain('You never delete a thread')
    expect(ARCHIVE_THREADS_TOOL_DESCRIPTION).toContain('You cannot delete a thread')
  })
})

describe("the person's Stop, Archive, Delete and Remove from queue on a batch thread", () => {
  it('Stop (session.interrupt) on each kind: running stops, queued leaves the queue, a subagent line stops alone', async () => {
    const master = await pinnedMaster()
    const working = await child(master.id, 'working')
    const queued = await child(master.id, 'queued', { after: working })
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: working, title: 'sub' })
    await registry.send(sub.id, 'dig')
    await settle()
    // A menu's Stop on the subagent line stops it and leaves the batch thread working.
    await registry.stopSubtree(sub.id)
    await settle()
    expect(meta(sub.id)?.status).toBe('idle')
    expect(meta(working)?.status).toBe('running')
    await registry.stopRun(queued)
    await settle()
    expect(meta(queued)).toMatchObject({ archived: true })
    expect(sends.get(queued)).toBeUndefined()
    await registry.stopRun(working)
    await settle()
    expect(meta(working)?.status).toBe('idle')
    expect(meta(master.id)?.status).not.toBe('idle') // a batch thread's Stop never reaches its master
  })

  it('Remove from queue is the fleet Stop on a queued root: archived, never started, every id answered', async () => {
    const master = await pinnedMaster()
    const working = await child(master.id, 'working')
    const queued = await child(master.id, 'queued', { after: working })
    const result = await registry.batch('stop', [queued])
    expect(result).toEqual({ attempted: [queued], succeeded: [queued], failed: [] })
    expect(meta(queued)?.archived).toBe(true)
    finish(working)
    await settle(60)
    expect(sends.get(queued)).toBeUndefined()
  })

  it('Archive stops a running thread first; a queued subagent of an archived thread never starts later', async () => {
    const master = await pinnedMaster()
    const working = await child(master.id, 'working')
    // At the running cap (the master and this thread hold the two slots) a subagent queues.
    registry.admission = { cap: () => 2, memoryLow: () => false }
    const sub = await registry.create({ cwd: root, provider: 'claude', parentId: working, title: 'queued sub' })
    await registry.send(sub.id, 'later')
    await settle()
    expect(meta(sub.id)?.status).toBe('queued')
    await registry.setArchived(working, true)
    await settle(60)
    expect(meta(working)).toMatchObject({ archived: true, status: 'idle' })
    expect(meta(sub.id)?.archived).toBe(true)
    // A slot frees: the archived tree's subagent is not what takes it.
    registry.admission = { cap: () => 10, memoryLow: () => false }
    registry.scheduler.schedule()
    await settle(60)
    expect(sends.get(sub.id)).toBeUndefined()
  })

  it('Delete on a running, a queued and a done thread: each is gone, the running one stopped first, and the board hears it at once', async () => {
    const master = await pinnedMaster()
    const done = await doneChild(master.id, 'done')
    const working = await child(master.id, 'working')
    const queued = await child(master.id, 'queued', { after: working })
    expect(batches.get(master.id).children?.map((c) => c.sessionId)).toEqual([done, working, queued])
    const pushes: BatchState[] = []
    batches.onChange((state) => state.masterId === master.id && pushes.push(state))
    // The queued one first: a deleted `after` sibling would free it to start.
    for (const id of [queued, working, done]) await registry.delete(id)
    await settle()
    expect(interrupts).toContain(working)
    expect([working, queued, done].map(meta)).toEqual([null, null, null])
    expect(sends.get(queued)).toBeUndefined()
    // The board's list never names a deleted child again: a push came without it.
    expect(pushes.at(-1)?.children ?? []).toEqual([])
  })
})
