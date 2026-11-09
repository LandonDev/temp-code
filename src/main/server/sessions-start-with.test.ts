import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { cancelMirrors } from './mirror'
import type { DriverCtx, DriverHandle } from './drivers/types'

/**
 * `startWith` (Stability 1): a thread and its first message are one step.
 * The message is the thread's first row, on disk with the meta, or the
 * thread is removed and the caller hears why; no host lists a titled
 * thread with no rows.
 */
const boot = { fail: false }
const sends = new Map<string, string[]>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        if (boot.fail) throw new Error('claude: not logged in')
        const id = ctx.session.id
        return {
          send: async (text: string) => {
            sends.set(id, [...(sends.get(id) ?? []), text])
            ctx.emit({ type: 'status', status: 'running' })
          },
          interrupt: () => {},
          alive: () => true,
          dispose: async () => {}
        }
      }
    }
  }
}))

let root: string
let path: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-start-with-'))
  path = join(root, 'test.db')
  db = openDb(path)
  store = new Store(db)
  registry = new SessionRegistry(store)
  boot.fail = false
  sends.clear()
})
afterEach(async () => {
  cancelMirrors()
  await registry.close()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const userTexts = (s: Store, id: string): string[] =>
  s.eventsAfter(id, 0).flatMap((r) => (r.event.type === 'user-text' ? [r.event.text] : []))

describe('startWith', () => {
  it('creates the thread with its first message as its first user row, and delivers it', async () => {
    const meta = await registry.startWith({ cwd: root, provider: 'claude', title: 'Build it' }, 'do the work')
    await settle()
    expect(registry.get(meta.id)?.title).toBe('Build it')
    expect(userTexts(store, meta.id)).toEqual(['do the work'])
    expect(sends.get(meta.id)?.at(-1)).toContain('do the work')
  })

  it('a failure before the row is stored leaves no thread and pushes session-removed', async () => {
    const removed: string[][] = []
    registry.onRemoved((ids) => removed.push([...ids]))
    vi.spyOn(registry as unknown as { applyRunSettings: () => Promise<never> }, 'applyRunSettings').mockRejectedValueOnce(
      new Error('refused: no such model')
    )
    await expect(registry.startWith({ cwd: root, provider: 'claude', title: 'Doomed' }, 'hello')).rejects.toThrow(
      'refused: no such model'
    )
    expect(registry.list({ archived: undefined }).filter((s) => s.title === 'Doomed')).toEqual([])
    expect(removed).toHaveLength(1)
  })

  it('a boot failure after the row keeps the row and holds the message at the front of the queue', async () => {
    boot.fail = true
    const meta = await registry.startWith({ cwd: root, provider: 'claude', title: 'Logged out' }, 'start here')
    await settle()
    expect(registry.get(meta.id)).not.toBeNull()
    expect(userTexts(store, meta.id)).toEqual(['start here'])
    expect(registry.queueList(meta.id).map((q) => q.text)).toEqual(['start here'])
  })

  it('the first row is on disk with the meta: a registry rebuilt over the same file lists it', async () => {
    const meta = await registry.startWith({ cwd: root, provider: 'claude', title: 'Durable' }, 'remember me')
    // A second connection reads the file, not this store's pending batch.
    const other = openDb(path)
    try {
      const again = new SessionRegistry(new Store(other))
      expect(again.get(meta.id)?.title).toBe('Durable')
      expect(userTexts(new Store(other), meta.id)).toEqual(['remember me'])
      await again.close()
    } finally {
      other.close()
    }
  })

  it('a thread started under a paused parent lists with its user row, and the row survives a rebuilt registry', async () => {
    const parent = await registry.create({ cwd: root, provider: 'claude', title: 'Parent' })
    store.updateSession(parent.id, { status: 'paused' })
    const child = await registry.startWith({ cwd: root, provider: 'claude', parentId: parent.id, title: 'Child' }, 'the brief')
    expect(userTexts(store, child.id)).toEqual(['the brief'])
    // Held for the resume, marked as already on the transcript.
    expect(registry.queueList(child.id)).toEqual([expect.objectContaining({ text: 'the brief', stored: true })])
    expect(sends.get(child.id)).toBeUndefined()
    const other = openDb(path)
    try {
      expect(userTexts(new Store(other), child.id)).toEqual(['the brief'])
    } finally {
      other.close()
    }
  })

  it('session.create with a firstMessage is the one-step start; without one it creates as before', async () => {
    const started = await registry.createSession({ cwd: root, provider: 'claude', title: 'With brief', firstMessage: 'go' })
    expect(userTexts(store, started.id)).toEqual(['go'])
    const bare = await registry.createSession({ cwd: root, provider: 'claude', title: 'Bare' })
    expect(userTexts(store, bare.id)).toEqual([])
    vi.spyOn(registry as unknown as { applyRunSettings: () => Promise<never> }, 'applyRunSettings').mockRejectedValueOnce(
      new Error('refused')
    )
    await expect(registry.createSession({ cwd: root, provider: 'claude', title: 'Refused', firstMessage: 'x' })).rejects.toThrow('refused')
    expect(registry.list().map((s) => s.title).sort()).toEqual(['Bare', 'With brief'])
  })
})
