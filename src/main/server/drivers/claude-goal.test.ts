import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { setLagForTests } from '../stalls'

vi.mock('electron', () => ({ nativeImage: {} }))

const { goalWatcher, GOAL_POLL_MS, GOAL_SKIP_LAG_MS } = await import('./claude')

/**
 * The goal watcher tails the CLI's transcript JSONL for goal_status
 * entries: through fs.promises every GOAL_POLL_MS, never while the loop is
 * busy, each entry once by byte offset.
 */

let root: string
let events: AgentEvent[]
const cwd = '/work/my repo'
const slug = cwd.replace(/[^a-zA-Z0-9-_]/g, '-')
const entry = (attachment: Record<string, unknown>, at = new Date().toISOString()): string =>
  `${JSON.stringify({ type: 'attachment', timestamp: at, attachment: { type: 'goal_status', ...attachment } })}\n`
const watcher = (session: Partial<SessionMeta> = {}, everyMs = 20) =>
  goalWatcher({ emit: (e) => events.push(e), session: { cwd, nativeId: null, goal: null, ...session } as SessionMeta }, { root, everyMs })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tc-goal-'))
  mkdirSync(join(root, slug))
  events = []
})
afterEach(() => {
  setLagForTests(null)
  rmSync(root, { recursive: true, force: true })
})

it('polls every two seconds and skips a look while the loop is busy', () => {
  expect(GOAL_POLL_MS).toBe(2_000)
  expect(GOAL_SKIP_LAG_MS).toBe(50)
})

it('reads set, check and met entries once each, across appends and a torn last line', async () => {
  const file = join(root, slug, 's1.jsonl')
  writeFileSync(file, '{"type":"user"}\n' + entry({ met: false, sentinel: true, condition: 'tests pass' }))
  const w = watcher()
  w.arm('s1')
  await vi.waitFor(() => expect(events).toHaveLength(1))
  expect(events[0]).toMatchObject({ type: 'goal', phase: 'set', condition: 'tests pass' })
  const check = entry({ met: false, condition: 'tests pass', reason: 'two failing' })
  appendFileSync(file, check.slice(0, 20))
  await new Promise((r) => setTimeout(r, 80))
  appendFileSync(file, check.slice(20) + entry({ met: true, condition: 'tests pass', reason: 'green', iterations: 3 }))
  await vi.waitFor(() => expect(events).toHaveLength(3))
  expect(events.slice(1)).toMatchObject([
    { phase: 'updated', iterations: 1, reason: 'two failing' },
    { phase: 'met', iterations: 3, reason: 'green' }
  ])
  await new Promise((r) => setTimeout(r, 80))
  expect(events).toHaveLength(3)
  w.close()
})

it('a busy loop skips the look; the next quiet one reads what it missed', async () => {
  const file = join(root, slug, 's2.jsonl')
  writeFileSync(file, entry({ met: false, sentinel: true, condition: 'ship it' }))
  setLagForTests({ meanMs: GOAL_SKIP_LAG_MS + 30, maxMs: 200, ewmaMs: 80 })
  const w = watcher()
  w.arm('s2')
  await new Promise((r) => setTimeout(r, 120))
  expect(events).toEqual([])
  setLagForTests(null)
  await vi.waitFor(() => expect(events).toMatchObject([{ phase: 'set', condition: 'ship it' }]))
  w.close()
})

it('finds a transcript that appears later and under a drifted slug; a resume skips history older than the driver', async () => {
  const w = watcher({ nativeId: 's3' })
  w.arm('s3')
  await new Promise((r) => setTimeout(r, 60))
  mkdirSync(join(root, 'other-slug'))
  writeFileSync(
    join(root, 'other-slug', 's3.jsonl'),
    entry({ met: false, sentinel: true, condition: 'old' }, new Date(Date.now() - 60_000).toISOString()) +
      entry({ met: false, sentinel: true, condition: 'new' })
  )
  await vi.waitFor(() => expect(events).toMatchObject([{ phase: 'set', condition: 'new' }]))
  w.close()
  appendFileSync(join(root, 'other-slug', 's3.jsonl'), entry({ met: true, condition: 'new', reason: 'done' }))
  await new Promise((r) => setTimeout(r, 80))
  expect(events).toHaveLength(1)
})
