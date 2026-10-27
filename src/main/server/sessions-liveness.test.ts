import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { Batches, setBatches } from './batch'
import { cancelMirrors } from './mirror'
import { orchWaitForAgent, setOrchestrationRegistry } from './orchestration'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * The liveness of the watching state (plan S4), on the research's probe
 * suite with each hole turned into the rule: a fake claude driver whose
 * handle can be marked dead, on the real registry, batch engine and
 * orchestration. P1-P12 are the probe's numbers.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
const spawns = new Map<string, number>()
const dead = new Set<string>()

vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        spawns.set(id, (spawns.get(id) ?? 0) + 1)
        dead.delete(id)
        emits.set(id, ctx.emit)
        return {
          send: async (text: string) => {
            if (dead.has(id)) throw new Error('harness gone')
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => !dead.has(id),
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
let gateRelease: (() => void) | null = null
const hangGate = { on: false }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-liveness-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  setOrchestrationRegistry(registry)
  batches = new Batches({
    registry,
    store,
    runGate: () =>
      hangGate.on
        ? new Promise((r) => (gateRelease = () => r({ ok: true, log: 'stub', ms: 1, exitCode: 0 })))
        : Promise.resolve({ ok: true, log: 'stub', ms: 1, exitCode: 0 }),
    branchOf: async () => 'master'
  })
  batches.attach()
  setBatches(batches)
  emits.clear()
  sends.clear()
  spawns.clear()
  dead.clear()
  hangGate.on = false
})
afterEach(async () => {
  gateRelease?.()
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
const finish = (id: string): void => {
  emit(id, { type: 'turn-complete' } as AgentEvent)
  idle(id)
}
const sent = (id: string): number => (sends.get(id) ?? []).length
/** Two sweeps a minute apart: the grace, then the flip. */
const sweepTwice = (): string[] => {
  registry.sweepLiveness(0, Date.now())
  return registry.sweepLiveness(0, Date.now() + 60_000)
}

async function pinnedMaster(): Promise<{ projectId: string; master: string }> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  const master = await registry.create({ cwd: root, provider: 'claude', projectId: project.id, threadType: 'chat', title: 'Master' })
  registry.setMaster(master.id, true)
  await registry.send(master.id, 'open the batch')
  await settle()
  return { projectId: project.id, master: master.id }
}
async function child(masterId: string, title: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', masterId, title })
  await registry.send(s.id, `work ${title}`)
  await settle()
  return s.id
}

describe('the watching master', () => {
  it('P1 Stop idles a watching master for real: no slot, and a later report wakes it, after which it watches again', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    expect(registry.liveIds().has(master)).toBe(true)
    await registry.interrupt(master)
    await settle()
    expect(status(master)).toBe('idle')
    expect(registry.liveIds().has(master)).toBe(false)
    // The child's settle wakes it: a turn, then watching again (the batch is still open: A reported but the engine's end is not run yet).
    const before = sent(master)
    finish(a)
    await settle(150)
    expect(sent(master)).toBeGreaterThan(before)
    expect(sends.get(master)?.some((t, i) => i >= before && t.includes('<subagent-report>'))).toBe(true)
    // Awake, it holds a slot again; its next settle with the batch open watches.
    expect(registry.liveIds().has(master)).toBe(true)
  })

  it('P2 the sweep flips a watching master with a dead harness to stopped; the child report parks; Resume delivers it', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    dead.add(master)
    await settle()
    expect(status(master)).toBe('watching')
    const flipped = sweepTwice()
    expect(flipped).toContain(master)
    expect(status(master)).toBe('stopped')
    expect(registry.liveIds().has(master)).toBe(false)
    const rows = registry.eventsAfter(master, 0).map((r) => r.event)
    expect(rows.at(-1)).toMatchObject({ type: 'status', status: 'stopped', detail: 'The harness behind this master is gone; Resume brings it back' })
    // The child's report parks on the stopped master.
    const before = sent(master)
    const spawnedBefore = spawns.get(master)
    finish(a)
    await settle(150)
    expect(sent(master)).toBe(before)
    expect(spawns.get(master)).toBe(spawnedBefore)
    // Resume: a fresh harness, the restart nudge, then the parked report as its own turn on the settle.
    expect(await registry.resumeStopped(master)).toBe(true)
    await settle(60)
    expect(spawns.get(master)).toBe((spawnedBefore ?? 0) + 1)
    expect(sends.get(master)?.at(-1)).toContain('<host-restarted>')
    idle(master)
    await settle(120)
    expect(sends.get(master)?.some((t) => t.includes('<subagent-report>'))).toBe(true)
  })

  it('P2b a dead watching master still gets a report delivered when drainReports finds the harness gone', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    // The harness dies between sweeps: the report arrives first.
    dead.add(master)
    const spawnedBefore = spawns.get(master) ?? 0
    finish(a)
    await settle(150)
    expect(spawns.get(master)).toBe(spawnedBefore + 1)
    expect(sends.get(master)?.at(-1)).toContain('<subagent-report>')
  })

  it('P3 a gate running at a restart is failed, the master told, and the batch closes', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    hangGate.on = true
    finish(a)
    await settle(150)
    expect(batches.get(master).steps.map((s) => `${s.id}:${s.status}`)).toContain('gate:running')
    const b2 = new Batches({ registry, store, runGate: async () => ({ ok: true, log: 'stub', ms: 1, exitCode: 0 }), branchOf: async () => 'master' })
    await b2.resumeAfterBoot()
    const gate = b2.get(master).steps.find((s) => s.id === 'gate')
    expect(gate).toMatchObject({ status: 'failed', detail: 'the host restarted during the step' })
    expect(b2.open(master)).toBe(false)
    // The master was mid-turn on A's report: the batch's word parks and goes in at its settle.
    idle(master)
    await settle(120)
    expect(sends.get(master)?.some((t) => t.includes('was running when this host restarted'))).toBe(true)
    b2.dispose()
  })

  it('P4 a paused child blocks the batch as paused and the master is told once', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    const before = sent(master)
    await registry.pauseRun(a)
    await settle(120)
    expect(batches.get(master).blocked).toEqual({ sessionId: a, why: 'paused' })
    expect(sends.get(master)!.slice(before).filter((t) => t.includes('is paused: Resume it or remove it'))).toHaveLength(1)
    expect(batches.open(master)).toBe(true)
  })

  it('P5 unpinning a watching master idles it', async () => {
    const { master } = await pinnedMaster()
    await child(master, 'A')
    idle(master)
    await settle()
    expect(status(master)).toBe('watching')
    registry.setMaster(master, false)
    await settle(80)
    expect(status(master)).toBe('idle')
  })

  it('P6 an errored child blocks; the master is told once and watches again, its row saying so', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    emit(a, { type: 'status', status: 'error' })
    await settle(100)
    const blocked = batches.get(master).blocked
    expect(blocked).toEqual({ sessionId: a, why: 'errored' })
    if (status(master) === 'running') {
      idle(master)
      await settle(80)
    }
    expect(status(master)).toBe('watching')
    expect(registry.get(master)?.activity).toBe('Blocked: A errored')
  })

  it('P11 a child whose only turn ended without completing blocks as no-turn and the master is told', async () => {
    const { master } = await pinnedMaster()
    const a = await child(master, 'A')
    idle(master)
    await settle()
    const before = sent(master)
    emit(a, { type: 'error', message: 'turn ended: error_max_turns' })
    idle(a)
    await settle(120)
    expect(batches.get(master).blocked).toEqual({ sessionId: a, why: 'no-turn' })
    expect(sends.get(master)!.slice(before).filter((t) => t.includes('ended its turn without completing'))).toHaveLength(1)
    if (status(master) === 'running') {
      idle(master)
      await settle(80)
    }
    expect(registry.get(master)?.activity).toBe('Blocked: A ended its turn without completing')
  })

  it('P10 a planning child whose plan is complete and whose build never starts holds the batch open, unblocked (documented)', async () => {
    const { master } = await pinnedMaster()
    const p = await registry.create({ cwd: root, provider: 'claude', masterId: master, title: 'Plan', threadType: 'planning' })
    await registry.send(p.id, 'plan it')
    await settle()
    idle(master)
    await settle()
    store.updateSession(p.id, { planCompletedAt: Date.now() } as never)
    emit(p.id, { type: 'turn-complete' } as AgentEvent)
    idle(p.id)
    await settle(120)
    expect(batches.open(master)).toBe(true)
    expect(batches.get(master).blocked).toBeNull()
  })
})

describe('a watching thread of its own', () => {
  it('the sweep settles a thread watching its own background work with a dead harness idle: the tasks died with it', async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    await registry.send(parent.id, 'go')
    await settle()
    emit(parent.id, { type: 'background-tasks', tasks: ['bun test --watch'] })
    emit(parent.id, { type: 'status', status: 'watching' })
    dead.add(parent.id)
    const flipped = sweepTwice()
    await settle()
    expect(flipped).toContain(parent.id)
    expect(status(parent.id)).toBe('idle')
    expect(registry.get(parent.id)?.background ?? null).toBeNull()
    expect(registry.liveIds().has(parent.id)).toBe(false)
  })

  it('P8 a wait on a watching child whose harness died returns stopped once the sweep flips it', async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    await registry.send(parent.id, 'go')
    await settle()
    const kid = await registry.create({ cwd: root, provider: 'claude', parentId: parent.id, title: 'Kid' })
    await registry.send(kid.id, 'work')
    await settle()
    // A watching child settles the wait at once now (S1); wait again on a dead one.
    emit(kid.id, { type: 'background-tasks', tasks: ['bun test --watch'] })
    emit(kid.id, { type: 'status', status: 'watching' })
    const first = JSON.parse(await orchWaitForAgent(registry.get(parent.id)!, { agentId: kid.id }))
    expect(first).toMatchObject({ status: 'watching', waitingOn: expect.any(String) })
    emit(kid.id, { type: 'status', status: 'running' })
    const waiting = orchWaitForAgent(registry.get(parent.id)!, { agentId: kid.id })
    await settle()
    dead.add(kid.id)
    sweepTwice()
    const report = JSON.parse(await waiting)
    expect(report).toMatchObject({ status: 'stopped', note: 'its harness died; Resume it or start another' })
  })

  it('P12 a child the liveness sweep flips to stopped reports to its dormant parent', async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    await registry.send(parent.id, 'go')
    await settle()
    const kid = await registry.create({ cwd: root, provider: 'claude', parentId: parent.id, title: 'Kid' })
    await registry.send(kid.id, 'work')
    await settle()
    idle(parent.id)
    await settle()
    dead.add(kid.id)
    const before = sent(parent.id)
    const flipped = sweepTwice()
    await settle(100)
    expect(flipped).toContain(kid.id)
    expect(status(kid.id)).toBe('stopped')
    expect(sent(parent.id)).toBe(before + 1)
    expect(sends.get(parent.id)?.at(-1)).toContain('Its harness died; Resume it or start another')
  })

  it('the meta says when the thread last moved', async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    const before = Date.now()
    await registry.send(parent.id, 'go')
    await settle()
    expect(registry.get(parent.id)?.lastEventAt).toBeGreaterThanOrEqual(before)
  })
})
