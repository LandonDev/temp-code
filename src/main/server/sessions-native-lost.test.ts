import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import type { DriverCtx } from './drivers/types'

/** One controlled claude driver: every start hands back its ctx, every send is recorded. */
const ctxs: DriverCtx[] = []
const sends: string[] = []
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx) => {
        ctxs.push(ctx)
        return {
          send: async (text: string) => {
            sends.push(text)
          },
          interrupt: () => {},
          dispose: async () => {}
        }
      }
    }
  }
}))

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('condition never held')
    await sleep(25)
  }
}

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  ctxs.length = 0
  sends.length = 0
  root = await mkdtemp(join(tmpdir(), 'tc-native-lost-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
})
afterEach(async () => {
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const emit = (ctx: DriverCtx, event: AgentEvent): void => ctx.emit(event)

/** A thread with one answered turn whose harness persisted a native id. */
async function answered(): Promise<{ id: string; ctx: DriverCtx }> {
  const session = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5-5' })
  await registry.send(session.id, 'what is the plan?')
  const ctx = ctxs[0]
  if (!ctx) throw new Error('driver never started')
  ctx.setNativeId('mac-session-1')
  emit(ctx, { type: 'assistant-text', text: 'ship the thing', delta: false })
  emit(ctx, { type: 'status', status: 'idle' })
  expect(registry.get(session.id)?.nativeId).toBe('mac-session-1')
  return { id: session.id, ctx }
}

/** The harness answers a later resume with "no such session", as the CLI
 *  does once the thread's history has moved hosts: the failed turn's
 *  result and the stream's own error land, then the driver reports the loss. */
function lose(ctx: DriverCtx): void {
  emit(ctx, { type: 'error', message: 'turn ended: error_during_execution' })
  emit(ctx, { type: 'error', message: 'Claude Code returned an error result: No conversation found with session ID: mac-session-1' })
  emit(ctx, { type: 'status', status: 'error' })
  ctx.nativeSessionLost?.()
}

it('a lost native session is forgotten, rebooted with the transcript as context, and continued', async () => {
  const { id, ctx } = await answered()
  await registry.send(id, 'and then?')
  lose(ctx)
  expect(registry.get(id)?.nativeId).toBeNull()
  await until(() => ctxs.length === 2 && sends.length === 3)
  const continued = sends[2]!
  expect(continued.startsWith('<conversation-handoff>')).toBe(true)
  expect(continued).toContain('what is the plan?')
  expect(continued).toContain('ship the thing')
  expect(continued).toContain('and then?')
  expect(continued).toContain('<continue-run>')
  expect(continued).toContain('no transcript for the thread')
  // The fresh harness persists its own id; the next user message rides plain.
  ctxs[1]!.setNativeId('box-session-1')
  emit(ctxs[1]!, { type: 'assistant-text', text: 'then we rest', delta: false })
  emit(ctxs[1]!, { type: 'status', status: 'idle' })
  await registry.send(id, 'good')
  expect(sends.at(-1)).toBe('good')
  expect(registry.get(id)?.nativeId).toBe('box-session-1')
})

it('a thread with history but no native id seeds its next send with the transcript; a new thread does not', async () => {
  const { id, ctx } = await answered()
  lose(ctx)
  await until(() => sends.length === 2)
  // Recovery already ran once; a user message sent before the new harness
  // reports its id goes to the live handle, which holds the context.
  await registry.send(id, 'still there?')
  expect(sends.at(-1)).toBe('still there?')
  // Drop the handle without a native id landing: the next send reseeds.
  await registry.disposeAll()
  await registry.send(id, 'and now?')
  expect(sends.at(-1)!.startsWith('<conversation-handoff>')).toBe(true)
  expect(sends.at(-1)).toContain('ship the thing')
  expect(sends.at(-1)!.endsWith('and now?')).toBe(true)
  // A brand-new thread has no assistant text: its first message is plain.
  const fresh = await registry.create({ cwd: root, provider: 'claude', model: 'claude-sonnet-5-5' })
  await registry.send(fresh.id, 'hello')
  expect(sends.at(-1)).toBe('hello')
  expect(store.hasAssistantText(fresh.id)).toBe(false)
  expect(store.hasAssistantText(id)).toBe(true)
})
