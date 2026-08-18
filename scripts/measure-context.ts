/**
 * Context-diet measurement (.temp-code/plan-usV-vkuppMSo.md, slices 0 & 6):
 * turn-1 context for the three project thread types.
 *
 * It builds a throwaway project seeded with THIS repo's `.temp-code/`
 * (journal, ~40 transcripts, plan docs), inserts one session row per
 * mirror so the `<project-context>` index is realistic, then sends one
 * identical trivial message to a chat thread, a planning thread seeded
 * from a large sibling, and an implementation thread carrying a plan.
 *
 * The number reported is the driver's own `context` event — the same
 * `input + cache_creation + cache_read + output` the CLI's native
 * transcript records for the first request of the thread.
 *
 * Run: bun run script:measure-context
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import type { EventRow, SessionMeta } from '../src/shared/events'
import type { ThreadType } from '../src/shared/domain'

const REPO = process.cwd()
const PROBE = 'Reply with exactly: OK. Do not use any tool.'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-measure-')), 'm.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

/** Turn-1 footprint: the FIRST context reading the driver reports for
 *  this thread (input + cache_creation + cache_read + output — the same
 *  fields the CLI's native transcript records). Live context folds onto
 *  the session row, not the event log, so it arrives via onMeta. */
function firstContext(sessionId: string, timeoutMs = 300_000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off()
      offEvents()
      reject(new Error('no context reading'))
    }, timeoutMs)
    const done = (fn: () => void): void => {
      clearTimeout(timer)
      off()
      offEvents()
      fn()
    }
    const off = registry.onMeta((meta: SessionMeta) => {
      if (meta.id !== sessionId) return
      const tokens = meta.context?.tokens ?? 0
      if (tokens > 0) done(() => resolve(tokens))
    })
    const offEvents = registry.subscribe(sessionId, (row: EventRow) => {
      if (process.env.MEASURE_DEBUG) console.log('  ·', row.event.type)
      if (row.event.type === 'error') done(() => reject(new Error(row.event.message)))
    })
  })
}

// ── a project with this repo's real shared context ───────────────────
const wsDir = mkdtempSync(join(tmpdir(), 'tc-measure-ws-'))
const ws = await registry.createWorkspace(wsDir, 'measure-ws')
const project = await registry.createProject(ws.id, 'Alpha', 'local')
cpSync(join(REPO, '.temp-code'), join(project.cwd, '.temp-code'), { recursive: true })
if (existsSync(join(REPO, 'CLAUDE.md'))) cpSync(join(REPO, 'CLAUDE.md'), join(project.cwd, 'CLAUDE.md'))

/** One session row per mirrored transcript, so `projectContext()` builds
 *  its index from the same threads whose files are on disk. */
const front = (text: string, key: string): string | null =>
  text.split('\n').find((l) => l.startsWith(`${key}: `))?.slice(key.length + 2) ?? null
const threadsDir = join(project.cwd, '.temp-code', 'threads')
mkdirSync(threadsDir, { recursive: true })
const mirrors = readdirSync(threadsDir).filter((f) => f.endsWith('.md') && !f.startsWith('agent-'))
let inserted = 0
for (const file of mirrors) {
  const head = readFileSync(join(threadsDir, file), 'utf8').slice(0, 2_000)
  const id = file.slice(0, 12) // nanoid(12); the slug follows a dash
  if (file.length < 13) continue
  const title = front(head, 'title')
  const type = front(head, 'type')
  const updated = front(head, 'updated')
  store.insertSession({
    id,
    parentId: null,
    projectId: project.id,
    workspaceId: null,
    threadType: (type as ThreadType | null) ?? 'chat',
    planPath: type === 'planning' ? join(project.cwd, '.temp-code', `plan-${id}.md`) : null,
    provider: 'claude',
    model: 'claude-opus-5',
    reasoning: 'medium',
    agentType: 'implementer',
    title: title ? (JSON.parse(title) as string) : file,
    cwd: project.cwd,
    status: 'idle',
    archived: false,
    permission: 'edits',
    fast: false,
    context1m: false,
    busySince: null,
    pausedAt: null,
    frozenActiveElapsed: null,
    threadRules: null,
    nativeId: null,
    createdAt: Date.now(),
    updatedAt: updated ? Date.parse(updated) : Date.now()
  } as SessionMeta)
  inserted++
}

/** The seed source: a chat thread long enough that its digest hits the
 *  mirror cap, i.e. the worst realistic seed. */
const sourceId = 'measureSrc01'
store.insertSession({
  id: sourceId,
  parentId: null,
  projectId: project.id,
  workspaceId: null,
  threadType: 'chat',
  planPath: null,
  provider: 'claude',
  model: 'claude-opus-5',
  reasoning: 'medium',
  agentType: 'implementer',
  title: 'Seed source: context usage discussion',
  cwd: project.cwd,
  status: 'idle',
  archived: false,
  permission: 'edits',
  fast: false,
  context1m: false,
  busySince: null,
  pausedAt: null,
  frozenActiveElapsed: null,
  threadRules: null,
  nativeId: null,
  createdAt: Date.now(),
  updatedAt: Date.now()
} as SessionMeta)
// Realistic prose (not a single repeated char) so token counts are honest.
const para =
  'We walked through where the context actually goes on turn one, and the numbers were worse than either of us guessed. The journal alone is four thousand tokens, the thread index another nine hundred, and a seeded digest can run past fifteen thousand on its own. None of it is wrong, exactly, but almost none of it gets used. '
const chunk = para.repeat(24)
for (let i = 0; i < 8; i++) {
  store.appendEvent(sourceId, { type: 'user-text', text: `Round ${i + 1}: what else is in there?` })
  store.appendEvent(sourceId, { type: 'assistant-text', text: `${chunk}`, delta: false })
}

const planFile = readdirSync(join(project.cwd, '.temp-code')).find((f) => f.startsWith('plan-'))
const planPath = planFile ? join(project.cwd, '.temp-code', planFile) : null

console.log(`project ${project.cwd}`)
console.log(`indexed ${inserted} sibling threads, plan ${planFile ?? '(none)'}\n`)

const measure = async (
  label: string,
  params: Parameters<SessionRegistry['create']>[0],
  send: (id: string) => Promise<void>
): Promise<[string, number]> => {
  const s = await registry.create(params)
  const ctx = firstContext(s.id)
  await send(s.id)
  const tokens = await ctx
  await registry.interrupt(s.id).catch(() => {}) // turn-1 is measured; stop there
  console.log(`${label.padEnd(22)} ${tokens.toLocaleString()} tokens`)
  return [label, tokens]
}

const base = {
  provider: 'claude' as const,
  model: 'claude-opus-5',
  reasoning: 'medium' as const,
  agentType: 'implementer' as const,
  permission: 'edits' as const,
  projectId: project.id,
  parentId: null
}

const results: [string, number][] = []
results.push(await measure('chat', { ...base, threadType: 'chat' }, (id) => registry.send(id, PROBE)))
results.push(
  await measure('planning (seeded)', { ...base, threadType: 'planning' }, (id) =>
    registry.send(id, `${PROBE} @thread:${sourceId}`, {
      attachments: [
        { path: `thread:${sourceId}`, name: 'seed', kind: 'thread', sessionId: sourceId }
      ]
    })
  )
)
results.push(
  await measure('implementation (plan)', { ...base, threadType: 'implementation', planPath }, (id) =>
    registry.send(id, PROBE)
  )
)

console.log(`\n${results.map(([l, t]) => `${l}: ${t}`).join('  |  ')}`)
await registry.disposeAll()
process.exit(0)
