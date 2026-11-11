import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { NOTES_MECHANICS, STEER_MECHANICS, isCommitCall, isNotesCall, wrapSteer } from './notesPrompts'
import { MASTER_MECHANICS, implementerSpawnPrompt, orchestratorPrompt } from './orchestration'
import { threadPreamble } from './threads'
import { appUpdateNotes, setAppBridge } from './apptools'
import { cancelMirrors, threadDigest, writeThreadDigest } from './mirror'
import { readFile } from 'node:fs/promises'

/** One controlled driver: every send is recorded, and the test drives
 *  the harness's events through the captured ctx. */
const sends: string[] = []
/** Host lines the registry put into a live turn (DriverHandle.whisper); the
 *  driver takes them while `whisperTaken`, else answers false. */
const whispers: string[] = []
let whisperTaken = true
let emit: ((e: AgentEvent) => void) | null = null
let returnWhispers: ((texts: string[]) => void) | null = null
vi.mock('./drivers', () => ({
  BUILT_IN_DRIVERS: {
    claude: {
      id: 'claude',
      start: async (ctx: { emit: (e: AgentEvent) => void; returnWhispers?: (texts: string[]) => void }) => {
        emit = ctx.emit
        returnWhispers = ctx.returnWhispers ?? null
        return {
          send: async (text: string) => {
            sends.push(text)
          },
          whisper: async (text: string) => {
            if (!whisperTaken) return false
            whispers.push(text)
            return true
          },
          interrupt: () => {},
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
  sends.length = 0
  whispers.length = 0
  whisperTaken = true
  emit = null
  returnWhispers = null
  root = await mkdtemp(join(tmpdir(), 'tc-notes-reg-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  const ws = join(root, 'repo')
  await mkdir(ws)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })
})
afterEach(async () => {
  await registry.close()
  cancelMirrors()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

async function startThread(): Promise<string> {
  const s = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
  await registry.send(s.id, 'build it')
  await flush()
  expect(sends.length).toBe(1)
  return s.id
}

const running = (): void => emit!({ type: 'status', status: 'running' })
const settle = (): void => {
  emit!({ type: 'turn-complete' })
  emit!({ type: 'status', status: 'idle' })
}

describe('the reminder after a commit', () => {
  it('a turn that committed without update_notes gets its own reminder turn, once', async () => {
    const id = await startThread()
    running()
    emit!({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'git commit -am "notes"' } })
    settle()
    await flush()
    expect(sends.length).toBe(2)
    expect(sends[1]).toContain('<notes-reminder reason="commit">')
    const rows = registry.eventsAfter(id, 0).map((r) => r.event)
    expect(rows.some((e) => e.type === 'turn-pass' && e.actions.join() === 'Notes')).toBe(true)
    // The reminder turn ends without a commit: nothing more is owed, and
    // even another commit-only turn before a user message is not nagged.
    running()
    emit!({ type: 'tool-call', callId: 'c2', name: 'Bash', input: { command: 'git merge feature' } })
    settle()
    await flush()
    expect(sends.length).toBe(2)
  })

  it('a turn that committed AND called update_notes owes nothing', async () => {
    await startThread()
    running()
    emit!({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'git commit -m x' } })
    emit!({ type: 'tool-call', callId: 'c2', name: 'mcp__app__update_notes', input: { section: 'State', content: 'landed' } })
    settle()
    await flush()
    expect(sends.length).toBe(1)
  })

  it("the tool's own write counts as the update, whatever the call was named", async () => {
    const id = await startThread()
    running()
    emit!({ type: 'tool-call', callId: 'c1', name: 'shell', input: { command: ['bash', '-lc', 'gh pr merge 12'] } })
    registry.notes.update(id, { section: 'State', content: 'merged' })
    settle()
    await flush()
    expect(sends.length).toBe(1)
  })

  it('with a queued message the reminder rides ahead of it instead of its own turn', async () => {
    const id = await startThread()
    running()
    emit!({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'git commit -m x' } })
    registry.queueAdd(id, 'next thing')
    settle()
    await flush()
    expect(sends.length).toBe(2)
    expect(sends[1].startsWith('<notes-reminder reason="commit">')).toBe(true)
    expect(sends[1]).toContain('next thing')
  })

  it('a subagent is never reminded', async () => {
    const parent = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
    const child = await registry.create({ projectId: 'p1', provider: 'claude', parentId: parent.id, agentType: 'implementer' })
    await registry.send(child.id, 'do it')
    await flush()
    running()
    emit!({ type: 'tool-call', callId: 'c1', name: 'Bash', input: { command: 'git commit -m x' } })
    settle()
    await flush()
    // The parent hears the settle; nobody hears a notes reminder.
    expect(sends.some((t) => t.includes('<notes-reminder'))).toBe(false)
  })
})

describe('the reminder before a compaction', () => {
  it('fires once into the live turn; a squeezed window re-arms it only after 15 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await startThread()
      running()
      emit!({ type: 'context', tokens: 100_000, window: 200_000 })
      await flush()
      expect(whispers).toHaveLength(0)
      emit!({ type: 'context', tokens: 141_000, window: 200_000 })
      await flush()
      expect(whispers).toHaveLength(1)
      expect(whispers[0]).toContain('<notes-reminder reason="context">')
      emit!({ type: 'context', tokens: 150_000, window: 200_000 })
      await flush()
      expect(whispers).toHaveLength(1)
      // Squeezed and refilled 5 minutes on: the same cause, no second reminder.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      emit!({ type: 'compaction', phase: 'done', trigger: 'auto', preTokens: 150_000, postTokens: 20_000 })
      emit!({ type: 'context', tokens: 20_000, window: 200_000 })
      emit!({ type: 'context', tokens: 145_000, window: 200_000 })
      await flush()
      expect(whispers.filter((t) => t.includes('<notes-reminder'))).toHaveLength(1)
      // 16 minutes after the first: armed again.
      vi.setSystemTime(Date.now() + 11 * 60_000)
      emit!({ type: 'context', tokens: 146_000, window: 200_000 })
      await flush()
      expect(whispers.filter((t) => t.includes('<notes-reminder'))).toHaveLength(2)
      // None of it was a send: no turn of its own.
      expect(sends).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never fires within 15 minutes of an update_notes call', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const id = await startThread()
      running()
      appUpdateNotes(registry, registry.get(id)!, { section: 'State', content: 'current' })
      vi.setSystemTime(Date.now() + 14 * 60_000)
      emit!({ type: 'context', tokens: 160_000, window: 200_000 })
      await flush()
      expect(whispers).toHaveLength(0)
      vi.setSystemTime(Date.now() + 2 * 60_000)
      emit!({ type: 'context', tokens: 161_000, window: 200_000 })
      await flush()
      expect(whispers.filter((t) => t.includes('<notes-reminder reason="context">'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a subagent's reminder follows the same rules", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const parent = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
      const child = await registry.create({ projectId: 'p1', provider: 'claude', parentId: parent.id, agentType: 'implementer' })
      await registry.send(child.id, 'do it')
      await flush()
      running()
      emit!({ type: 'context', tokens: 190_000, window: 200_000 })
      await flush()
      expect(whispers).toHaveLength(1)
      emit!({ type: 'compaction', phase: 'done', trigger: 'auto' })
      emit!({ type: 'context', tokens: 10_000, window: 200_000 })
      emit!({ type: 'context', tokens: 190_000, window: 200_000 })
      await flush()
      expect(whispers.filter((t) => t.includes('<notes-reminder'))).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('with no live turn the reminder waits for the next message', async () => {
    const id = await startThread()
    running()
    settle()
    await flush()
    emit!({ type: 'context', tokens: 160_000, window: 200_000 })
    await flush()
    expect(sends.length).toBe(1)
    expect(registry.heldNotices(id)).toHaveLength(1)
    await registry.send(id, 'carry on')
    await flush()
    expect(sends.length).toBe(2)
    expect(sends[1].startsWith('<notes-reminder reason="context">')).toBe(true)
    expect(sends[1].endsWith('carry on')).toBe(true)
    expect(registry.heldNotices(id)).toHaveLength(0)
  })
})

describe('the notes after a compaction', () => {
  it('the thread notes ride into the live turn right after the squeeze', async () => {
    const id = await startThread()
    registry.notes.update(id, { section: 'State', content: '- parser done\n- panel in flight' })
    running()
    emit!({ type: 'compaction', phase: 'done', trigger: 'auto' })
    await flush()
    // Into the turn as a host line, never a send that would run as a turn.
    expect(sends.length).toBe(1)
    expect(whispers).toHaveLength(1)
    expect(whispers[0]).toContain('<thread-notes>')
    expect(whispers[0]).toContain('## State\n\n- parser done\n- panel in flight')
    expect(registry.heldNotices(id)).toEqual([])
  })

  it('an idle thread gets them ahead of its next message; empty notes send nothing', async () => {
    const id = await startThread()
    running()
    settle()
    await flush()
    emit!({ type: 'compaction', phase: 'done', trigger: 'manual' })
    await flush()
    expect(registry.heldNotices(id)).toHaveLength(0)
    registry.notes.update(id, { section: 'Goal', content: 'Keep notes.' })
    emit!({ type: 'compaction', phase: 'done', trigger: 'manual' })
    await registry.send(id, 'resume')
    await flush()
    expect(sends[1].startsWith('<thread-notes>')).toBe(true)
    expect(sends[1]).toContain('## Goal\n\nKeep notes.')
    expect(sends[1].endsWith('resume')).toBe(true)
  })
})

describe('a host line never starts a turn', () => {
  it('a whisper the driver cannot place is held and rides the next send; the thread stays idle meanwhile', async () => {
    const id = await startThread()
    registry.notes.update(id, { section: 'State', content: 'in flight' })
    running()
    whisperTaken = false
    emit!({ type: 'compaction', phase: 'done', trigger: 'auto' })
    await flush()
    expect(whispers).toEqual([])
    expect(registry.heldNotices(id)).toHaveLength(1)
    settle()
    await flush()
    expect(sends.length).toBe(1)
    expect(registry.get(id)?.status).toBe('idle')
    await registry.send(id, 'next')
    await flush()
    expect(sends[1].startsWith('<thread-notes>')).toBe(true)
    expect(sends[1].endsWith('next')).toBe(true)
  })

  it("a dev-server line is held the same way, and so is what the driver hands back unread", async () => {
    const id = await startThread()
    running()
    whisperTaken = false
    registry.whisper(id, '<dev-server port="5173">\nlistening\n</dev-server>')
    await flush()
    expect(registry.heldNotices(id)).toEqual(['<dev-server port="5173">\nlistening\n</dev-server>'])
    whisperTaken = true
    registry.whisper(id, 'taken then returned')
    await flush()
    expect(whispers).toEqual(['taken then returned'])
    returnWhispers!(['taken then returned'])
    expect(registry.heldNotices(id)).toEqual(['<dev-server port="5173">\nlistening\n</dev-server>', 'taken then returned'])
    expect(sends.length).toBe(1)
  })

  it('a thread with no live turn holds the line without asking the driver', async () => {
    const id = await startThread()
    running()
    settle()
    await flush()
    registry.whisper(id, 'later')
    await flush()
    expect(whispers).toEqual([])
    expect(registry.heldNotices(id)).toEqual(['later'])
  })
})

describe('the mechanics text', () => {
  it('rides every claude system prompt and the preamble of a bridged codex thread', async () => {
    const impl = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
    expect(implementerSpawnPrompt(impl)).toContain(NOTES_MECHANICS)
    const orch = await registry.create({ projectId: 'p1', threadType: 'orchestration', provider: 'claude' })
    expect(orchestratorPrompt(orch)).toContain(NOTES_MECHANICS)
    // A claude preamble never repeats what its system prompt carries.
    expect(threadPreamble(impl)).not.toContain(NOTES_MECHANICS)
    setAppBridge({ port: 1, scriptPath: '/x', command: 'node', env: {} })
    try {
      const codex = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'codex' })
      expect(threadPreamble(codex)).toContain(NOTES_MECHANICS)
    } finally {
      setAppBridge(null)
    }
  })

  it('the steer rule rides beside the notes in every prompt, and the wrapper holds the text and the one-line answer', async () => {
    const impl = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
    expect(implementerSpawnPrompt(impl)).toContain(STEER_MECHANICS)
    const orch = await registry.create({ projectId: 'p1', threadType: 'orchestration', provider: 'claude' })
    expect(orchestratorPrompt(orch)).toContain(STEER_MECHANICS)
    expect(threadPreamble(impl)).not.toContain(STEER_MECHANICS)
    setAppBridge({ port: 1, scriptPath: '/x', command: 'node', env: {} })
    try {
      const codex = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'codex' })
      expect(threadPreamble(codex)).toContain(STEER_MECHANICS)
    } finally {
      setAppBridge(null)
    }
    expect(MASTER_MECHANICS).toMatch(/Answer a steer first in one short line/)
    const wrapped = wrapSteer('use the other table')
    expect(wrapped.startsWith('<user-steer>\nuse the other table\n</user-steer>\n')).toBe(true)
    expect(wrapped).toMatch(/answer it in one short line of your own words/)
  })

  it('tells a commit from any shell tool and the notes tool from any surface', () => {
    expect(isCommitCall('Bash', { command: 'git commit -m "x"' })).toBe(true)
    expect(isCommitCall('Bash', { command: 'git -C /repo merge main' })).toBe(true)
    expect(isCommitCall('shell', { command: ['bash', '-lc', 'gh pr merge 3 --squash'] })).toBe(true)
    expect(isCommitCall('Bash', { command: 'git status && git log' })).toBe(false)
    expect(isCommitCall('Read', { file_path: 'git commit' })).toBe(false)
    expect(isNotesCall('mcp__app__update_notes')).toBe(true)
    expect(isNotesCall('update_notes')).toBe(true)
    expect(isNotesCall('app.update_notes')).toBe(true)
    expect(isNotesCall('mcp__app__app_read_thread')).toBe(false)
  })
})

describe('successors start from the notes', () => {
  it('a digest carries the notes verbatim ahead of the outcome and the dialogue', async () => {
    const s = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude' })
    registry.append(s.id, { type: 'user-text', text: 'build the notes feature' })
    registry.append(s.id, { type: 'assistant-text', text: 'Done: the panel and the tool.', delta: false })
    registry.notes.update(s.id, { section: 'Goal', content: 'Per-thread notes.' })
    registry.notes.update(s.id, { section: 'Pointers', content: '- src/main/server/threadNotes.ts' })
    const digest = threadDigest(registry, registry.get(s.id)!)
    const notesAt = digest.indexOf('## Notes\n\n### Goal\n\nPer-thread notes.')
    expect(notesAt).toBeGreaterThan(0)
    expect(digest).toContain('### Pointers\n\n- src/main/server/threadNotes.ts')
    expect(notesAt).toBeLessThan(digest.indexOf('## Outcome'))
    expect(notesAt).toBeLessThan(digest.indexOf('## User'))
    // A thread without notes digests as before.
    const bare = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    expect(threadDigest(registry, registry.get(bare.id)!)).not.toContain('## Notes')
  })

  it('a seed digest file written for a new thread keeps the notes in its head', async () => {
    const src = await registry.create({ projectId: 'p1', threadType: 'chat', provider: 'claude' })
    registry.notes.update(src.id, { section: 'Decisions', content: '- SQLite mirror.' })
    for (let i = 0; i < 40; i++) {
      registry.append(src.id, { type: 'user-text', text: `turn ${i} ${'x'.repeat(400)}` })
      registry.append(src.id, { type: 'assistant-text', text: `reply ${i} ${'y'.repeat(400)}`, delta: false })
    }
    const cwd = store.getProject('p1')!.cwd
    const rel = writeThreadDigest(registry, registry.get(src.id)!, cwd)
    const text = await readFile(join(cwd, rel), 'utf8')
    expect(text).toContain('## Notes\n\n### Decisions\n\n- SQLite mirror.')
    expect(text).toContain('_[earlier turns trimmed]_')
    expect(text.indexOf('## Notes')).toBeLessThan(text.indexOf('_[earlier turns trimmed]_'))
  })

  it("a build thread's first message carries the planning thread's notes with the plan", async () => {
    const plan = await registry.create({ projectId: 'p1', threadType: 'planning', provider: 'claude', title: 'Notes plan' })
    registry.notes.update(plan.id, { section: 'Decisions', content: '- One file per thread.' })
    registry.notes.update(plan.id, { section: 'Open questions', content: '- Panel or segment?' })
    const build = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude', planPath: plan.planPath! })
    await registry.send(build.id, 'go')
    await flush()
    const first = sends[0]
    expect(first).toContain(`The plan for this work is in ${plan.planPath}`)
    expect(first).toContain('<planning-notes thread="Notes plan">')
    expect(first).toContain('## Decisions\n\n- One file per thread.')
    expect(first).toContain('## Open questions\n\n- Panel or segment?')
    // A build whose planner kept no notes gets the plan line alone.
    sends.length = 0
    const plan2 = await registry.create({ projectId: 'p1', threadType: 'planning', provider: 'claude' })
    const build2 = await registry.create({ projectId: 'p1', threadType: 'implementation', provider: 'claude', planPath: plan2.planPath! })
    await registry.send(build2.id, 'go')
    await flush()
    expect(sends[0]).not.toContain('<planning-notes')
  })
})

describe('a thrashing window (the update_notes loop)', () => {
  it('the context reminder stays bounded while the window refills and compacts on every request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const id = await startThread()
      running()
      const window = 200_000
      // Every line the host sends is answered with an update_notes call,
      // as the looping models did.
      const answered = (): number => [...sends, ...whispers].filter((t) => t.includes('<notes-reminder reason="context">')).length
      for (let cycle = 0; cycle < 10; cycle++) {
        emit!({ type: 'context', tokens: window * 0.95, window })
        await flush()
        appUpdateNotes(registry, registry.get(id)!, { section: 'State', content: `cycle ${cycle}` })
        emit!({ type: 'tool-call', callId: `n${cycle}`, name: 'mcp__app__update_notes', input: {} })
        emit!({ type: 'compaction', phase: 'done', trigger: 'auto', preTokens: window * 0.95, postTokens: window * 0.1 })
        emit!({ type: 'context', tokens: window * 0.1, window })
        await flush()
        vi.setSystemTime(Date.now() + 60_000)
      }
      // On master this was one reminder per cycle (10 in 10); now one per
      // 15 minutes at most, and never a send that starts a turn.
      expect(answered()).toBeLessThanOrEqual(1)
      expect(sends).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
