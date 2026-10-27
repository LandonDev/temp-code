import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { cancelMirrors } from './mirror'
import { NOTES_REMINDER_COMMIT } from './notesPrompts'
import type { DriverCtx, DriverHandle } from './drivers/types'
import type { AgentEvent } from '../../shared/events'

/**
 * The person's message is never behind the app's own turns (plan S2): what
 * waits for a settling thread — the held notices, the parked subagent
 * reports, the notes reminder — rides ahead of the person's queued text in
 * ONE send, and a report never wakes the thread alone while that text waits.
 */
const emits = new Map<string, (e: AgentEvent) => void>()
const sends = new Map<string, string[]>()
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: DriverCtx): Promise<DriverHandle> => {
        const id = ctx.session.id
        emits.set(id, ctx.emit)
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
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tc-queue-order-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  emits.clear()
  sends.clear()
})
afterEach(async () => {
  cancelMirrors()
  await registry.disposeAll()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))
const emit = (id: string, e: AgentEvent): void => emits.get(id)!(e)
const types = (id: string): string[] => registry.eventsAfter(id, 0).map((r) => r.event.type)
const report = (n: number) => ({ text: `<subagent-report>R${n}</subagent-report>`, agentId: `c${n}`, title: `kid ${n}`, status: 'idle' })

async function live(): Promise<string> {
  const s = await registry.create({ cwd: root, provider: 'claude' })
  await registry.send(s.id, 'go')
  await settle()
  return s.id
}

describe('the order of what waits for a settling thread', () => {
  it('a report and a queued message settle into one turn: notices, the report row, the user text last', async () => {
    const id = await live()
    // A line the app held (whisper into a thread that is not running holds it).
    emit(id, { type: 'status', status: 'waiting', detail: 'awaiting approval' })
    registry.whisper(id, '<notes-reminder reason="context"/>')
    expect(registry.heldNotices(id)).toEqual(['<notes-reminder reason="context"/>'])
    expect(registry.queueAdd(id, 'and then this').kind).toBe('queued')
    registry.deliverAgentReport(id, report(1))
    registry.deliverAgentReport(id, report(2))
    expect(sends.get(id)).toEqual(['go'])
    emit(id, { type: 'status', status: 'idle' })
    await settle()
    expect(sends.get(id)).toHaveLength(2)
    const sent = sends.get(id)![1]
    const at = (s: string) => sent.indexOf(s)
    expect(at('<notes-reminder')).toBeGreaterThanOrEqual(0)
    expect(at('<notes-reminder')).toBeLessThan(at('R1'))
    expect(at('R1')).toBeLessThan(at('R2'))
    expect(at('R2')).toBeLessThan(at('and then this'))
    expect(sent.endsWith('and then this')).toBe(true)
    // The rows: both report rows, then the user row.
    const tail = types(id).filter((t) => t === 'agent-report' || t === 'user-text')
    expect(tail.slice(-3)).toEqual(['agent-report', 'agent-report', 'user-text'])
    expect(registry.queueList(id)).toEqual([])
    expect(registry.heldNotices(id)).toEqual([])
  })

  it('a report arriving while user text waits never wakes the thread alone', async () => {
    const id = await live()
    expect(registry.queueAdd(id, 'next').kind).toBe('queued')
    registry.deliverAgentReport(id, report(1))
    emit(id, { type: 'status', status: 'idle' })
    await settle()
    // One send carrying both, not a report turn and then the message.
    expect(sends.get(id)).toHaveLength(2)
    expect(sends.get(id)![1]).toContain('R1')
    expect(sends.get(id)![1].endsWith('next')).toBe(true)
    // A second report while that turn runs waits; the next settle with nothing queued sends it alone.
    registry.deliverAgentReport(id, report(2))
    expect(sends.get(id)).toHaveLength(2)
    emit(id, { type: 'status', status: 'idle' })
    await settle()
    expect(sends.get(id)).toHaveLength(3)
    expect(sends.get(id)![2]).toBe('<subagent-report>R2</subagent-report>')
  })

  it('a report into a watching thread with nothing queued still goes in alone, the held notices ahead of it', async () => {
    const id = await live()
    emit(id, { type: 'status', status: 'waiting', detail: 'awaiting approval' })
    registry.whisper(id, '<held/>')
    emit(id, { type: 'background-tasks', tasks: ['serve'] })
    emit(id, { type: 'status', status: 'watching' })
    registry.deliverAgentReport(id, report(3))
    await settle()
    expect(sends.get(id)!.at(-1)).toBe('<held/>\n\n<subagent-report>R3</subagent-report>')
    expect(types(id).filter((t) => t === 'agent-report')).toHaveLength(1)
  })

  it('a notes reminder due with a queued message rides as a notice, never as its own turn', async () => {
    const id = await live()
    // A commit this turn without a notes update: the reminder is owed at the settle.
    emit(id, { type: 'tool-call', callId: 'b1', name: 'Bash', input: { command: 'git commit -m "x"' } })
    emit(id, { type: 'turn-complete' } as AgentEvent)
    expect(registry.queueAdd(id, 'carry on').kind).toBe('queued')
    emit(id, { type: 'status', status: 'idle' })
    await settle()
    expect(sends.get(id)).toHaveLength(2)
    const sent = sends.get(id)![1]
    expect(sent.startsWith(NOTES_REMINDER_COMMIT)).toBe(true)
    expect(sent.endsWith('carry on')).toBe(true)
    expect(types(id)).not.toContain('turn-pass')
  })
})
