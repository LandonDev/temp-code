/**
 * M8 exit test (docs/PLAN-2.md): project-global shared context.
 * Create a project → PROJECT.md seeded. Planning thread turn → mirror file
 * with frontmatter + dialogue + tool lines; plan doc exists. Chat thread →
 * its first message carries the <project-context> block (verified by the
 * model quoting it). Codex child of a project thread mirrors into the
 * project cwd. Deleting the planning thread removes its mirror and appends
 * a journal entry. Cap: an over-long transcript head-trims.
 * Run: bun run script:e2e-shared-context
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { journalPath, renderMirror } from '../src/main/server/mirror'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ctx-')), 'ctx.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function waitFor(
  sessionId: string,
  pred: (e: AgentEvent) => boolean,
  timeoutMs = 300_000
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, 0).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error('timeout'))
    }, timeoutMs)
    const off = registry.subscribe(sessionId, (row: EventRow) => {
      if (pred(row.event)) {
        clearTimeout(timer)
        off()
        resolve(row.event)
      }
    })
  })
}
const settled = (id: string): Promise<AgentEvent> =>
  waitFor(id, (e) => e.type === 'turn-complete' || e.type === 'error')
const finalText = (id: string): string =>
  registry
    .eventsAfter(id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')

// ── cap: an over-long transcript head-trims (pure) ───────────────────
const bigRows: EventRow[] = [
  { sessionId: 'x', seq: 1, ts: 1, event: { type: 'user-text', text: 'go' } },
  {
    sessionId: 'x',
    seq: 2,
    ts: 2,
    event: { type: 'assistant-text', text: 'y'.repeat(80_000), delta: false }
  }
]
const fakeMeta = {
  id: 'x',
  parentId: null,
  title: 'big',
  threadType: 'chat',
  provider: 'claude',
  model: 'm',
  status: 'idle',
  updatedAt: Date.now(),
  planPath: null,
  agentType: 'implementer'
} as unknown as SessionMeta
const big = renderMirror(fakeMeta, bigRows)
check(
  'mirror head-trims past the cap',
  big.length < 62_000 && big.includes('[earlier turns trimmed]'),
  `len ${big.length}`
)

// ── project seeding ──────────────────────────────────────────────────
const wsDir = mkdtempSync(join(tmpdir(), 'tc-ctx-ws-'))
const ws = await registry.createWorkspace(wsDir, 'ctx-ws')
const project = await registry.createProject(ws.id, 'Zeta', 'local')
check('PROJECT.md seeded at createProject', existsSync(journalPath(project.cwd)))
const seeded = readFileSync(journalPath(project.cwd), 'utf8')
check(
  'journal has title + creation entry',
  seeded.includes('# Zeta') && seeded.includes('project created'),
  seeded.split('\n').at(-2) ?? ''
)

// ── planning thread: plan doc + mirror with tool lines ───────────────
const plan = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: project.id,
  threadType: 'planning',
  parentId: null
})
await registry.send(
  plan.id,
  'Write the plan document now with title "Zeta Feature", a one-line overview, and a single task "- [ ] build the zeta widget". Then reply with exactly: PLAN WRITTEN'
)
await settled(plan.id)
check('plan doc exists', existsSync(plan.planPath!), plan.planPath ?? '')
await sleep(3_000) // mirror debounce
const threadsDir = join(project.cwd, '.temp-code', 'threads')
const planMirrorName = readdirSync(threadsDir).find((f) => f.includes(plan.id))
check('planning thread mirrored', !!planMirrorName, readdirSync(threadsDir).join(','))
const planMirror = planMirrorName ? readFileSync(join(threadsDir, planMirrorName), 'utf8') : ''
check(
  'mirror has frontmatter',
  planMirror.includes('type: planning') && planMirror.includes(`sessionId: ${plan.id}`)
)
check('mirror has dialogue', planMirror.includes('## User') && planMirror.includes('## Assistant'))
check(
  'mirror shows one-line tool actions',
  /- (Write|Edit) .*plan-/.test(planMirror),
  planMirror.split('\n').find((l) => l.startsWith('- ')) ?? '(none)'
)

// ── chat thread: the <project-context> block arrives ─────────────────
const chat = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: project.id,
  threadType: 'chat',
  parentId: null
})
await registry.send(
  chat.id,
  'Look at the <project-context> block in this message. Reply with: the project name, then the mirror path of the planning thread it lists, verbatim. Do not read any files.'
)
await settled(chat.id)
const chatReply = finalText(chat.id)
check('chat thread received project name', chatReply.includes('Zeta'), chatReply.slice(-200))
check(
  'chat thread received the planning mirror path',
  planMirrorName ? chatReply.includes(planMirrorName) : false,
  chatReply.slice(-200)
)

// ── codex child mirrors into the project cwd ─────────────────────────
const child = await registry.create({
  provider: 'codex',
  model: 'gpt-5.6-sol',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: project.id,
  threadType: null,
  parentId: plan.id,
  cwd: mkdtempSync(join(tmpdir(), 'tc-ctx-wt-')) // simulated throwaway worktree
})
await registry.send(child.id, 'Reply with exactly: CHILD OK')
await settled(child.id)
await sleep(3_000)
const childMirror = readdirSync(threadsDir).find((f) => f.startsWith(`agent-${child.id}`))
check(
  'codex child mirror lands in the PROJECT cwd',
  !!childMirror,
  readdirSync(threadsDir).join(',')
)
check(
  'child mirror content is codex dialogue',
  childMirror ? readFileSync(join(threadsDir, childMirror), 'utf8').includes('CHILD OK') : false
)

// ── delete: mirror gone, journal entry appended ──────────────────────
await registry.delete(plan.id)
check(
  'deleted thread mirrors removed (incl. child)',
  readdirSync(threadsDir).every((f) => !f.includes(plan.id) && !f.includes(child.id))
)
const journal = readFileSync(journalPath(project.cwd), 'utf8')
check(
  'journal records the deleted plan thread',
  journal.includes('thread deleted'),
  journal.split('\n').at(-2) ?? ''
)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
