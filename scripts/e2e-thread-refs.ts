/**
 * M9 exit test (docs/PLAN-2.md): thread references. A thread in project A
 * does distinctive work; a thread in project B references it with a
 * kind:'thread' attachment → B/.temp-code/refs/<id>.md exists, carries A's
 * dialogue and names project A; the model's reply quotes the distinctive
 * fact (proving it followed the rewritten local path). A planning thread's
 * digest carries its plan path. A projectless session gets the inline
 * fallback. Run: bun run script:e2e-thread-refs
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import type { AgentEvent, EventRow } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ref-')), 'ref.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

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

const wsA = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-ref-a-')), 'ws-a')
const wsB = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-ref-b-')), 'ws-b')
const projA = await registry.createProject(wsA.id, 'Alpha', 'local')
const projB = await registry.createProject(wsB.id, 'Beta', 'local')

// The referenced thread: distinctive work in project A (planning → it also
// has a plan file, so the digest's frontmatter carries the plan path).
const source = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: projA.id,
  threadType: 'planning',
  parentId: null
})
await registry.send(
  source.id,
  'For this test, skip the plan document. Just reply with exactly: the launch codeword is PELICAN-42'
)
await settled(source.id)
check('source thread produced the fact', finalText(source.id).includes('PELICAN-42'))

// Reference it from a thread in project B.
const reader = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: projB.id,
  threadType: 'chat',
  parentId: null
})
await registry.send(
  reader.id,
  `Read the referenced thread digest @thread:${source.id} and reply with the launch codeword it mentions, exactly.`,
  {
    attachments: [
      { path: `thread:${source.id}`, name: source.title, kind: 'thread', sessionId: source.id }
    ]
  }
)
const refPath = join(projB.cwd, '.temp-code', 'refs', `${source.id}.md`)
check('digest written into project B', existsSync(refPath), refPath)
const digest = existsSync(refPath) ? readFileSync(refPath, 'utf8') : ''
check('digest names project A', digest.includes('project: "Alpha"'))
check(
  'digest carries the dialogue',
  digest.includes('PELICAN-42') && digest.includes('## Assistant')
)
check('digest carries the plan path', digest.includes(`plan: ${source.planPath}`))
await settled(reader.id)
const readerReply = finalText(reader.id)
check(
  'model read the digest via the local path',
  readerReply.includes('PELICAN-42'),
  readerReply.slice(-160)
)

// Same-project reference also lands in refs/ (one uniform shape).
const sibling = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  projectId: projA.id,
  threadType: 'chat',
  parentId: null
})
await registry.send(sibling.id, `Reply OK. (context: @thread:${source.id})`, {
  attachments: [
    { path: `thread:${source.id}`, name: source.title, kind: 'thread', sessionId: source.id }
  ]
})
check(
  'same-project reference digests into refs/',
  existsSync(join(projA.cwd, '.temp-code', 'refs', `${source.id}.md`))
)
await settled(sibling.id)

// Projectless session: inline fallback, and the reply still proves receipt.
const loose = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'edits',
  cwd: mkdtempSync(join(tmpdir(), 'tc-ref-loose-')),
  parentId: null
})
await registry.send(
  loose.id,
  `A thread is referenced inline below as <thread-reference>. Reply with the launch codeword it mentions, exactly. @thread:${source.id}`,
  {
    attachments: [
      { path: `thread:${source.id}`, name: source.title, kind: 'thread', sessionId: source.id }
    ]
  }
)
await settled(loose.id)
check(
  'projectless session got the inline digest',
  finalText(loose.id).includes('PELICAN-42'),
  finalText(loose.id).slice(-160)
)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
