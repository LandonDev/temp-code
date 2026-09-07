import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/** A fake second-class driver: every send asks for approval and reports the answer. */
const answers: boolean[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    grok: {
      id: 'grok',
      start: async (ctx: DriverCtx) => ({
        send: async () => {
          const allow = await ctx.requestApproval({ toolName: 'shell', input: { cmd: 'ls' } })
          answers.push(allow)
          ctx.emit({ type: 'turn-complete' } as AgentEvent)
        },
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
  root = await mkdtemp(join(tmpdir(), 'tc-approval-'))
  db = openDb(join(root, 'test.db'))
  registry = new SessionRegistry(new Store(db))
  answers.length = 0
})
afterEach(async () => {
  vi.useRealTimers()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const types = (id: string): string[] =>
  registry.eventsAfter(id, 0).map((r) => `${r.event.type}${'status' in r.event ? ':' + r.event.status : ''}`)
const requestOf = (id: string) =>
  registry.eventsAfter(id, 0).map((r) => r.event).find((e) => e.type === 'approval-request') as
    | { requestId: string }
    | undefined
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

it('emits approval-request/waiting, then approval-resolved/running once approve() answers', async () => {
  const s = await registry.create({ cwd: root, provider: 'grok' })
  const turn = registry.send(s.id, 'run it')
  await settle()
  const req = requestOf(s.id)
  expect(req?.requestId).toMatch(/^a-/)
  expect(types(s.id)).toEqual(expect.arrayContaining(['approval-request', 'status:waiting']))
  await registry.approve(s.id, req!.requestId, true)
  await turn
  await settle()
  expect(answers).toEqual([true])
  const evs = registry.eventsAfter(s.id, 0).map((r) => r.event)
  expect(evs).toContainEqual(expect.objectContaining({ type: 'approval-resolved', requestId: req!.requestId, allow: true, auto: false }))
  expect(evs).toContainEqual(expect.objectContaining({ type: 'status', status: 'running' }))
  // A second answer for the same request is ignored.
  await registry.approve(s.id, req!.requestId, false)
  expect(answers).toEqual([true])
})

it('auto-denies after five minutes', async () => {
  vi.useFakeTimers()
  const s = await registry.create({ cwd: root, provider: 'grok' })
  const turn = registry.send(s.id, 'run it')
  await vi.advanceTimersByTimeAsync(50)
  expect(requestOf(s.id)).toBeDefined()
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1000)
  expect(answers).toEqual([])
  await vi.advanceTimersByTimeAsync(2000)
  await turn
  expect(answers).toEqual([false])
  expect(registry.eventsAfter(s.id, 0).map((r) => r.event)).toContainEqual(
    expect.objectContaining({ type: 'approval-resolved', allow: false, auto: true })
  )
})

it('denies pending approvals when the session handle drops', async () => {
  const s = await registry.create({ cwd: root, provider: 'grok' })
  const turn = registry.send(s.id, 'run it')
  await settle()
  expect(requestOf(s.id)).toBeDefined()
  await registry.disposeAll()
  await turn.catch(() => {})
  await settle()
  expect(answers).toEqual([false])
})
