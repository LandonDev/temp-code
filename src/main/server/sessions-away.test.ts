import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, SessionMeta } from '@shared/events'
import { openDb, Store } from './db'
import { SessionRegistry } from './sessions'
import { AWAY_APPROVAL_REPLY, AWAY_MECHANICS, AWAY_OFF, AWAY_ON, AWAY_QUESTION_REPLY } from './awayPrompts'
import { implementerSpawnPrompt, MASTER_MECHANICS, setOrchestrationRegistry } from './orchestration'
import { setAppBridge } from './apptools'
import { cancelMirrors } from './mirror'

/**
 * Away from computer, the registry's side (CLAUDE.md "Away from computer"):
 * what each harness is told, when, and how the host answers for the person.
 */

interface Captured {
  emit: (e: AgentEvent) => void
  session: SessionMeta
  requestApproval: (req: { requestId?: string; toolName: string; input: unknown; title?: string }) => Promise<boolean>
}
const sends = new Map<string, string[]>()
const ctxs = new Map<string, Captured>()
const answers: { sessionId: string; requestId: string; answers: string[][] | null }[] = []
const approvals: { sessionId: string; requestId: string; allow: boolean; reason?: string }[] = []
/** false: the driver has no resolver for the request (registered too late). */
const knobs = { resolves: true }

vi.mock('./drivers', () => {
  const driver = (id: string) => ({
    id,
    start: async (ctx: Captured) => {
      const sid = ctx.session.id
      ctxs.set(sid, ctx)
      return {
        send: async (text: string) => {
          sends.set(sid, [...(sends.get(sid) ?? []), text])
        },
        answer: (requestId: string, a: string[][] | null) => {
          if (!knobs.resolves) return false
          answers.push({ sessionId: sid, requestId, answers: a })
          return true
        },
        approve: (requestId: string, allow: boolean, reason?: string) => {
          if (!knobs.resolves) return false
          approvals.push({ sessionId: sid, requestId, allow, reason })
          return true
        },
        interrupt: () => {},
        dispose: async () => {}
      }
    }
  })
  return { BUILT_IN_DRIVERS: { claude: driver('claude'), codex: driver('codex') } }
})

let root: string
let db: ReturnType<typeof openDb>
let store: Store
let registry: SessionRegistry
const away = { enabled: false, count: vi.fn() }

beforeEach(async () => {
  sends.clear()
  ctxs.clear()
  answers.length = 0
  approvals.length = 0
  knobs.resolves = true
  away.enabled = false
  away.count.mockClear()
  root = await mkdtemp(join(tmpdir(), 'tc-away-reg-'))
  db = openDb(join(root, 'test.db'))
  store = new Store(db)
  registry = new SessionRegistry(store)
  registry.away = away
  setOrchestrationRegistry(registry)
  const ws = join(root, 'repo')
  await mkdir(ws)
  store.insertWorkspace({ id: 'ws1', name: 'repo', path: ws, git: false, createdAt: 1 })
  store.insertProject({ id: 'p1', workspaceId: 'ws1', name: 'app', mode: 'local', branch: null, cwd: ws, archived: false, createdAt: 1 })
})
afterEach(async () => {
  await registry.disposeAll()
  cancelMirrors()
  db.close()
  await rm(root, { recursive: true, force: true })
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
const sent = (id: string): string[] => sends.get(id) ?? []
const ctx = (id: string): Captured => ctxs.get(id)!

async function startThread(provider: 'claude' | 'codex' = 'claude'): Promise<string> {
  const s = await registry.create({ projectId: 'p1', threadType: 'implementation', provider })
  await registry.send(s.id, 'build it')
  await flush()
  expect(sent(s.id).length).toBe(1)
  return s.id
}
const running = (id: string): void => ctx(id).emit({ type: 'status', status: 'running' })
const settle = (id: string): void => {
  ctx(id).emit({ type: 'turn-complete' })
  ctx(id).emit({ type: 'status', status: 'idle' })
}

describe('what a harness is told at spawn', () => {
  it("claude's mechanics carry the rule always and the block only while away", async () => {
    const id = await startThread()
    const meta = store.getSession(id)!
    expect(implementerSpawnPrompt(meta)).toContain(AWAY_MECHANICS)
    expect(implementerSpawnPrompt(meta)).not.toContain(AWAY_ON)
    away.enabled = true
    expect(implementerSpawnPrompt(meta)).toContain(AWAY_ON)
  })

  it('the away block points at the computer tools first, and a Mac subagent only without them', () => {
    expect(AWAY_ON).toContain("For anything that needs a Mac app's screen, use the computer tools when this thread has them")
    expect(AWAY_ON).toContain('otherwise spawn a gpt-6.1-sol subagent on the Mac')
    expect(AWAY_ON).not.toContain('use computer use')
    expect(AWAY_ON.split('\n').filter((l) => l.includes('computer tools'))).toHaveLength(1)
  })

  it("a master's mechanics ask its report to gather the batch's decisions", () => {
    expect(MASTER_MECHANICS).toContain('Decisions made while you were away')
  })

  it("another harness reads the rule and the block in its first message while away, and is not told again", async () => {
    setAppBridge({ port: 1, scriptPath: '/x', command: 'node', env: {} })
    try {
      away.enabled = true
      const id = await startThread('codex')
      expect(sent(id)[0]).toContain(AWAY_MECHANICS)
      expect(sent(id)[0].match(/<away state="on">/g)).toHaveLength(1)
      settle(id)
      await registry.send(id, 'next')
      await flush()
      expect(sent(id)[1]).not.toContain('<away')
    } finally {
      setAppBridge(null)
    }
  })

  it('another harness started while present reads the rule and no block', async () => {
    setAppBridge({ port: 1, scriptPath: '/x', command: 'node', env: {} })
    try {
      const id = await startThread('codex')
      expect(sent(id)[0]).toContain(AWAY_MECHANICS)
      expect(sent(id)[0]).not.toContain('<away state=')
    } finally {
      setAppBridge(null)
    }
  })

  it('a claude spawn while away is not sent the block again: its system prompt has it', async () => {
    away.enabled = true
    const id = await startThread()
    expect(sent(id)[0]).not.toContain('<away')
  })

  it('a resume after a restart reads the state at its spawn', async () => {
    const id = await startThread()
    settle(id)
    await registry.disposeAll()
    away.enabled = true
    await registry.send(id, 'carry on')
    await flush()
    // The new spawn's system prompt carries the block; the message does not repeat it.
    expect(implementerSpawnPrompt(ctx(id).session)).toContain(AWAY_ON)
    expect(sent(id).at(-1)).not.toContain('<away')
  })
})

describe('a flip', () => {
  it('is whispered into running turns only', async () => {
    const live = await startThread()
    const idle = await startThread()
    running(live)
    settle(idle)
    away.enabled = true
    registry.awayChanged(true)
    await flush()
    expect(sent(live).at(-1)).toBe(AWAY_ON)
    expect(sent(idle)).toHaveLength(1)
  })

  it('reaches an idle thread once, ahead of its next message', async () => {
    const id = await startThread()
    settle(id)
    away.enabled = true
    registry.awayChanged(true)
    await registry.send(id, 'next')
    await flush()
    expect(sent(id)[1].startsWith(AWAY_ON)).toBe(true)
    expect(sent(id)[1]).toContain('next')
  })

  it('on and off again while a thread idles tells it nothing', async () => {
    const id = await startThread()
    settle(id)
    away.enabled = true
    registry.awayChanged(true)
    away.enabled = false
    registry.awayChanged(false)
    await registry.send(id, 'next')
    await flush()
    expect(sent(id)[1]).not.toContain('<away')
  })

  it('off after a whisper sends the off block at the next turn', async () => {
    const id = await startThread()
    running(id)
    away.enabled = true
    registry.awayChanged(true)
    settle(id)
    away.enabled = false
    registry.awayChanged(false)
    await registry.send(id, 'next')
    await flush()
    expect(sent(id).at(-1)!.startsWith(AWAY_OFF)).toBe(true)
  })

  it("rides a settled thread's wake, the path a watching master's reports take", async () => {
    const id = await startThread()
    settle(id)
    away.enabled = true
    registry.awayChanged(true)
    registry.deliverAgentReport(id, { agentId: 'child', title: 'Child', status: 'idle', text: '<subagent-report>done</subagent-report>' })
    await flush()
    expect(sent(id).at(-1)!.startsWith(AWAY_ON)).toBe(true)
    expect(sent(id).at(-1)).toContain('<subagent-report>')
  })
})

const rows = (id: string): AgentEvent[] => store.eventsAfter(id, 0).map((r) => r.event)
const statuses = (): Map<string, string[]> => {
  const seen = new Map<string, string[]>()
  registry.onMeta((m) => seen.set(m.id, [...(seen.get(m.id) ?? []), m.status]))
  return seen
}
const question = (requestId: string): AgentEvent => ({
  type: 'question-request',
  requestId,
  questions: [
    { question: 'Tabs or spaces?\nPick one.', options: [{ label: 'Tabs' }, { label: 'Spaces' }] },
    { question: 'Which port?', options: [{ label: '3000' }] }
  ]
})
const approval = (requestId: string): AgentEvent => ({
  type: 'approval-request',
  requestId,
  toolName: 'Bash',
  input: { command: 'rm -rf build' }
})

describe('the host answers for an away person', () => {
  it('answers a question with the away line, writes one notice and never waits', async () => {
    const id = await startThread()
    running(id)
    const seen = statuses()
    away.enabled = true
    ctx(id).emit(question('q1'))
    ctx(id).emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
    await flush()
    expect(answers).toEqual([{ sessionId: id, requestId: 'q1', answers: [[AWAY_QUESTION_REPLY], [AWAY_QUESTION_REPLY]] }])
    ctx(id).emit({ type: 'question-resolved', requestId: 'q1', answers: [[AWAY_QUESTION_REPLY], [AWAY_QUESTION_REPLY]] })
    ctx(id).emit({ type: 'status', status: 'running' })
    const written = rows(id)
    expect(written.some((e) => e.type === 'question-request' || e.type === 'question-resolved')).toBe(false)
    const notices = written.filter((e) => e.type === 'notice')
    expect(notices).toEqual([
      { type: 'notice', kind: 'away', message: 'Decided without asking: Tabs or spaces?', away: { kind: 'question', text: 'Tabs or spaces?' } }
    ])
    expect(seen.get(id) ?? []).not.toContain('waiting')
    expect(store.getSession(id)!.status).toBe('running')
    expect(away.count).toHaveBeenCalledWith(id)
  })

  it('denies an approval with the reason and says what was skipped', async () => {
    const id = await startThread()
    running(id)
    away.enabled = true
    ctx(id).emit(approval('a1'))
    ctx(id).emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
    await flush()
    expect(approvals).toEqual([{ sessionId: id, requestId: 'a1', allow: false, reason: AWAY_APPROVAL_REPLY }])
    ctx(id).emit({ type: 'approval-resolved', requestId: 'a1', allow: false })
    const written = rows(id)
    expect(written.some((e) => e.type === 'approval-request' || e.type === 'approval-resolved')).toBe(false)
    expect(written.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message)).toEqual([
      'Skipped while away: Run rm -rf build?'
    ])
    expect(store.getSession(id)!.status).toBe('running')
  })

  it("denies a requestApproval card at once, with no card", async () => {
    const id = await startThread()
    running(id)
    away.enabled = true
    await expect(ctx(id).requestApproval({ toolName: 'mcp__linear__save', input: {} })).resolves.toBe(false)
    const written = rows(id)
    expect(written.some((e) => e.type === 'approval-request')).toBe(false)
    expect(written.filter((e) => e.type === 'notice').map((e) => (e as { message: string }).message)).toEqual(['Skipped while away: Use linear?'])
  })

  it('intercepts nothing while the person is here', async () => {
    const id = await startThread()
    running(id)
    ctx(id).emit(question('q1'))
    ctx(id).emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
    await flush()
    expect(answers).toEqual([])
    expect(rows(id).some((e) => e.type === 'question-request')).toBe(true)
    expect(store.getSession(id)!.status).toBe('waiting')
  })

  it('writes the card as usual when the driver has no resolver for it', async () => {
    const id = await startThread()
    running(id)
    away.enabled = true
    knobs.resolves = false
    ctx(id).emit(question('q1'))
    ctx(id).emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
    await flush()
    expect(rows(id).some((e) => e.type === 'question-request')).toBe(true)
    expect(store.getSession(id)!.status).toBe('waiting')
  })

  it('answers the cards already waiting when away turns on', async () => {
    const q = await startThread()
    const a = await startThread()
    running(q)
    running(a)
    ctx(q).emit(question('q1'))
    ctx(q).emit({ type: 'status', status: 'waiting', detail: 'awaiting answer' })
    ctx(a).emit(approval('a1'))
    ctx(a).emit({ type: 'status', status: 'waiting', detail: 'awaiting approval' })
    away.enabled = true
    registry.awayChanged(true)
    await flush()
    expect(answers).toEqual([{ sessionId: q, requestId: 'q1', answers: [[AWAY_QUESTION_REPLY], [AWAY_QUESTION_REPLY]] }])
    expect(approvals).toEqual([{ sessionId: a, requestId: 'a1', allow: false, reason: AWAY_APPROVAL_REPLY }])
    expect(rows(q).filter((e) => e.type === 'notice')).toHaveLength(1)
    expect(rows(a).filter((e) => e.type === 'notice')).toHaveLength(1)
  })
})

describe('a noted decision', () => {
  it('is one away row that counts toward the tally, away or not', async () => {
    const id = await startThread()
    registry.awayNotice(id, 'decision', 'Chose port 3000: the README names it')
    expect(rows(id).filter((e) => e.type === 'notice')).toEqual([
      { type: 'notice', kind: 'away', message: 'Chose port 3000: the README names it', away: { kind: 'decision', text: 'Chose port 3000: the README names it' } }
    ])
    expect(away.count).toHaveBeenCalledWith(id)
  })
})
