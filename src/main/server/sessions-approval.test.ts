import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { DriverCtx } from './drivers/types'
import type { AgentEvent } from '../../shared/events'
import type { Principal } from '../../shared/capabilities'
import { ADDON_APPROVE_REFUSAL, approverOf, assertMayAnswer } from '../../shared/addons'

/** A fake second-class driver: every send asks for approval and reports the answer. */
const answers: boolean[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    /** A claude-shaped fake: a send asks a question ('ask') or an approval
     *  ('run it') the way drivers/claude.ts does, and its interrupt aborts
     *  the wait with the CLI's own sequence: the card's resolution, the
     *  cleanup's `running`, then the result row and idle. */
    cursor: {
      id: 'cursor',
      start: async (ctx: DriverCtx) => {
        let abort: (() => void) | null = null
        return {
          send: async (text: string) => {
            ctx.emit({ type: 'status', status: 'running' })
            if (text === 'ask') {
              ctx.emit({ type: 'question-request', requestId: 'q1', questions: [{ question: 'Tabs or spaces?', options: [{ label: 'Tabs' }] }] } as AgentEvent)
              ctx.emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
              await new Promise<void>((resolve) => (abort = resolve))
              ctx.emit({ type: 'question-resolved', requestId: 'q1', answers: null } as AgentEvent)
            } else {
              ctx.emit({ type: 'approval-request', requestId: 'a1', toolName: 'Bash', input: { command: 'ls' } } as AgentEvent)
              ctx.emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
              await new Promise<void>((resolve) => (abort = resolve))
              ctx.emit({ type: 'approval-resolved', requestId: 'a1', allow: false, auto: true } as AgentEvent)
            }
            ctx.emit({ type: 'status', status: 'running' })
            ctx.emit({ type: 'error', message: 'turn ended: error_during_execution' })
            ctx.emit({ type: 'status', status: 'idle' })
          },
          interrupt: () => abort?.(),
          dispose: async () => {}
        }
      }
    },
    grok: {
      id: 'grok',
      start: async (ctx: DriverCtx) => ({
        send: async (text: string) => {
          const edit = text === 'edit'
          if (edit) ctx.emit({ type: 'tool-call', callId: 'c1', name: 'Edit', input: { file_path: 'a.js' } } as AgentEvent)
          const allow = await ctx.requestApproval(
            text === 'add it' ? { toolName: 'addon_add', title: 'Add the add-on github', input: {} } : { toolName: 'shell', input: { cmd: 'ls' } }
          )
          answers.push(allow)
          if (edit) ctx.emit({ type: 'tool-result', callId: 'c1', output: '', isError: false } as AgentEvent)
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
  await registry.close()
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

it('keeps the tool each pending approval guards: an add-on card is allowed only by a person with admin, and denied by anyone', async () => {
  const nonAdmin: Principal = { kind: 'remote', keyId: 'k', name: 'Phone', audience: 'client', caps: ['read', 'operate', 'approve'] }
  const admin: Principal = { ...nonAdmin, caps: ['read', 'admin'] }
  const s = await registry.create({ cwd: root, provider: 'grok' })
  const turn = registry.send(s.id, 'add it')
  await settle()
  const id = requestOf(s.id)!.requestId
  const tool = registry.pendingApprovalTool(s.id, id)
  expect(tool).toBe('addon_add')
  // session.approve's guard, as index.ts runs it.
  expect(() => assertMayAnswer(tool, true, approverOf(nonAdmin))).toThrow(ADDON_APPROVE_REFUSAL)
  expect(() => assertMayAnswer(tool, true, approverOf(admin))).not.toThrow()
  expect(() => assertMayAnswer(tool, true, approverOf({ kind: 'local' }))).not.toThrow()
  expect(() => assertMayAnswer(tool, false, approverOf(nonAdmin))).not.toThrow()
  await registry.approve(s.id, id, false)
  await turn
  expect(answers).toEqual([false])
  expect(registry.pendingApprovalTool(s.id, id)).toBeNull()
  // Any other card is the approve capability's, as before.
  const next = registry.send(s.id, 'run it')
  await settle()
  const other = registry.eventsAfter(s.id, 0).map((r) => r.event).filter((e) => e.type === 'approval-request').at(-1) as { requestId: string }
  expect(() => assertMayAnswer(registry.pendingApprovalTool(s.id, other.requestId), true, approverOf(nonAdmin))).not.toThrow()
  await registry.approve(s.id, other.requestId, true)
  await next
})

for (const [what, text, resolved] of [
  ['question', 'ask', { type: 'question-resolved', requestId: 'q1', answers: null }],
  ['approval', 'run it', { type: 'approval-resolved', requestId: 'a1', allow: false, auto: true }]
] as const) {
  it(`a Stop while a ${what} waits: the card resolves, the running in between keeps the stop, and the row idles stopped, not failed`, async () => {
    const s = await registry.create({ cwd: root, provider: 'cursor' })
    const turn = registry.send(s.id, text)
    await settle()
    expect(types(s.id).at(-1)).toBe('status:waiting')
    await registry.interrupt(s.id)
    await turn
    await settle()
    const evs = registry.eventsAfter(s.id, 0).map((r) => r.event)
    expect(evs).toContainEqual(expect.objectContaining(resolved))
    expect(types(s.id).slice(-3)).toEqual(['status:running', 'error', 'status:idle'])
    const error = evs.find((e) => e.type === 'error')
    expect(error).toMatchObject({ message: 'turn ended: error_during_execution', stopped: true })
    expect(error).not.toHaveProperty('failure')
    expect(registry.get(s.id)?.status).toBe('idle')
    expect(registry.get(s.id)?.failure ?? null).toBeNull()
    // The next turn is never the old stop: its own ending is classified.
    const next = registry.send(s.id, text)
    await settle()
    await registry.answer(s.id, 'q1', null).catch(() => {})
    void next
  })
}

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

it('keeps a disk tool call open while its approval waits, so a late write still has an owner', async () => {
  vi.useFakeTimers()
  const s = await registry.create({ cwd: root, provider: 'grok' })
  const turn = registry.send(s.id, 'edit')
  await vi.advanceTimersByTimeAsync(50)
  expect(types(s.id)).toContain('status:waiting')
  // Well past the post-result grace: the call has not run yet, so it must still count.
  await vi.advanceTimersByTimeAsync(30_000)
  expect(registry.diskActiveAt(s.id, Date.now())).toBe(true)
  await registry.approve(s.id, requestOf(s.id)!.requestId, true)
  await turn
  await vi.advanceTimersByTimeAsync(50)
  expect(registry.diskActiveAt(s.id, Date.now())).toBe(true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(registry.diskActiveAt(s.id, Date.now())).toBe(false)
})

it("writes a card's choices when it names them, and none otherwise", async () => {
  const s = await registry.create({ cwd: root, provider: 'grok' })
  await settle()
  const asked = registry.requestApproval(s.id, {
    toolName: 'computer_session',
    input: { app: 'TextEdit' },
    title: 'Use your pointer and keyboard to click in TextEdit',
    choices: 'run-skip'
  })
  const req = requestOf(s.id) as { requestId: string; choices?: string; toolName: string }
  expect(req).toMatchObject({ toolName: 'computer_session', choices: 'run-skip' })
  await registry.approve(s.id, req.requestId, true)
  expect(await asked).toBe(true)
  const plain = registry.requestApproval(s.id, { toolName: 'shell', input: { cmd: 'ls' } })
  const second = registry.eventsAfter(s.id, 0).map((r) => r.event).filter((e) => e.type === 'approval-request').at(-1)!
  expect('choices' in second).toBe(false)
  await registry.approve(s.id, (second as { requestId: string }).requestId, false)
  expect(await plain).toBe(false)
})
