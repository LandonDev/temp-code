import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { THRASH } from '@shared/contextThrash'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { cancelMirrors } from './mirror'

/** One controlled driver per session: the test emits the harness's events,
 *  and an interrupt settles the turn the way the CLI does (its own row for
 *  the cut turn, then idle). */
const emits = new Map<string, (e: AgentEvent) => void>()
const interrupts: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: { session: { id: string }; emit: (e: AgentEvent) => void }) => {
        emits.set(ctx.session.id, ctx.emit)
        return {
          send: async () => {},
          interrupt: () => {
            interrupts.push(ctx.session.id)
            ctx.emit({ type: 'error', message: 'turn ended: error_during_execution' })
            ctx.emit({ type: 'status', status: 'idle' })
          },
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

beforeEach(async () => {
  emits.clear()
  interrupts.length = 0
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-10T15:00:00Z'))
  root = await mkdtemp(join(tmpdir(), 'tc-thrash-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  const ws = join(root, 'repo')
  await mkdir(ws)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.close()
  cancelMirrors()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))
const minutes = (n: number): void => {
  vi.setSystemTime(Date.now() + n * 60_000)
}

async function start(opts: { parentId?: string; masterId?: string } = {}): Promise<string> {
  const s = await registry.create({ projectId: 'p1', provider: 'claude', threadType: 'implementation', ...opts })
  await registry.send(s.id, 'build it')
  await flush()
  emits.get(s.id)!({ type: 'status', status: 'running' })
  emits.get(s.id)!({ type: 'context', tokens: 167_400, window: 200_000 })
  return s.id
}

/** `n` compactions, `gap` minutes apart. */
async function compact(id: string, n: number, gap: number): Promise<void> {
  const emit = emits.get(id)!
  for (let i = 0; i < n; i++) {
    if (i) minutes(gap)
    emit({ type: 'compaction', phase: 'start', trigger: 'auto' })
    emit({ type: 'compaction', phase: 'done', trigger: 'auto', preTokens: 170_000, postTokens: 11_500 })
    await flush()
  }
}

const rows = (id: string): AgentEvent[] => registry.eventsAfter(id, 0).map((r) => r.event)
const errors = (id: string) => rows(id).filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')

describe('the thrash guard', () => {
  it('four compactions inside ten minutes stop the running turn with one context_thrash row', async () => {
    const id = await start()
    await compact(id, THRASH.compactions, 2)
    await flush()
    expect(interrupts).toEqual([id])
    const errs = errors(id)
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toBe('context thrash: 4 compactions in 6 min; first request 167k of 200k')
    expect(errs[0].stopped).toBeUndefined()
    expect(errs[0].failure).toMatchObject({ kind: 'context_thrash', summary: 'The context window keeps filling up', cause: '4 compactions in 6 minutes; the first request held 167k of a 200k window' })
    expect(registry.get(id)?.status).toBe('error')
  })

  it('three compactions do not', async () => {
    const id = await start()
    await compact(id, 3, 2)
    expect(interrupts).toEqual([])
    expect(registry.get(id)?.status).toBe('running')
  })

  it('four spread over more than ten minutes do not', async () => {
    const id = await start()
    await compact(id, 4, 4)
    expect(interrupts).toEqual([])
  })

  it('a send starts the count over', async () => {
    const id = await start()
    await compact(id, 3, 1)
    emits.get(id)!({ type: 'status', status: 'idle' })
    await registry.send(id, 'go on')
    await flush()
    emits.get(id)!({ type: 'status', status: 'running' })
    await compact(id, 3, 1)
    expect(interrupts).toEqual([])
  })

  it('guards a subagent the same way', async () => {
    const parent = await registry.create({ projectId: 'p1', provider: 'claude', threadType: 'implementation' })
    const id = await start({ parentId: parent.id })
    await compact(id, 4, 1)
    await flush()
    expect(interrupts).toEqual([id])
    expect(errors(id).at(-1)?.failure?.kind).toBe('context_thrash')
  })

  it('a compaction on a row that is not running stops nothing', async () => {
    const id = await start()
    emits.get(id)!({ type: 'status', status: 'idle' })
    await compact(id, 4, 1)
    expect(interrupts).toEqual([])
    expect(errors(id)).toEqual([])
  })

  it('a batch child stopped this way fails with the words, so its batch reads the cause', async () => {
    const master = await registry.create({ projectId: 'p1', provider: 'claude', threadType: 'chat' })
    const id = await start({ masterId: master.id })
    await compact(id, 4, 1)
    await flush()
    const meta = registry.get(id)!
    expect(meta.status).toBe('error')
    expect(meta.masterId).toBe(master.id)
    expect(errors(id).at(-1)?.failure?.summary).toBe('The context window keeps filling up')
  })
})
