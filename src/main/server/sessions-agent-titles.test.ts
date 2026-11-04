import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { DriverCtx } from './drivers/types'

/**
 * A subagent's title and the wait's words through the registry: the title
 * a spawn without one gets from its task, and the status line of a turn a
 * wait_for_agent holds on its agents.
 */
const titles: { text: string; resolve: (title: string | null) => void }[] = []
vi.mock('./drivers/title', () => ({
  generateTitle: (text: string) => new Promise<string | null>((resolve) => titles.push({ text, resolve }))
}))
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => ({
        send: async () => ctx.emit({ type: 'status', status: 'running' }),
        alive: () => true,
        interrupt: () => {},
        dispose: async () => {}
      })
    }
  }
}))

let root: string
let db: ReturnType<typeof openDb>
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-agent-titles-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
  titles.length = 0
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

async function child(title: string, parentId?: string): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude', title, ...(parentId ? { parentId } : {}) })
  return s.id
}

it('titleFromTask replaces the first line with the written title', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway\nevery forward path')
  expect(titles.map((t) => t.text)).toEqual(['Audit the gateway\nevery forward path'])
  expect(registry.get(id)?.title).toBe('Audit the gateway')
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(id)?.title).toBe('Gateway deadline audit')
})

it('a rename before the title lands wins', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  await registry.rename(id, 'My own name')
  titles[0].resolve('Gateway deadline audit')
  await settle()
  expect(registry.get(id)?.title).toBe('My own name')
})

it('no title back keeps the first line', async () => {
  const id = await child('Audit the gateway')
  registry.titleFromTask(id, 'Audit the gateway')
  titles[0].resolve(null)
  await settle()
  expect(registry.get(id)?.title).toBe('Audit the gateway')
})

it('a turn held by a wait says the agents it waits on, by title, until the wait releases', async () => {
  const parent = await child('Parent')
  await registry.send(parent, 'go')
  await settle()
  const a = await child('Review the payment flow', parent)
  const b = await child('Audit the gateway', parent)
  expect(registry.get(parent)?.statusDetail).not.toMatch(/^Waiting on/)

  registry.setAwaiting(parent, [a], true)
  expect(registry.get(parent)?.statusDetail).toBe('Waiting on Review the payment flow')
  expect(registry.get(parent)?.activity).toBe('Waiting on Review the payment flow')

  registry.setAwaiting(parent, [b], true)
  expect(registry.get(parent)?.statusDetail).toBe('Waiting on 2 subagents')

  registry.setAwaiting(parent, [a, b], false)
  expect(registry.get(parent)?.statusDetail ?? '').not.toMatch(/^Waiting on/)
})
