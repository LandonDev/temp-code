/**
 * Context-diet exit test (.temp-code/plan-usV-vkuppMSo.md): everything the
 * app writes into `.temp-code/` for retrieval. No model runs — the event
 * log is synthesized, so this is fast and free.
 *
 * Covers: `files:` frontmatter (writes before reads, project-relative,
 * capped), `## Outcome` at the head, `threads/INDEX.md` regeneration and
 * ordering, boot backfill of mirrors written before those fields, and
 * journal rotation into PROJECT-archive.md past the cap.
 * Run: bun run script:e2e-mirror-index
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { backfillMirrors, journalPath, mirrorSession } from '../src/main/server/mirror'
import type { AgentEvent, SessionMeta } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-idx-')), 'idx.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ws = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-idx-ws-')), 'idx-ws')
const project = await registry.createProject(ws.id, 'Idx', 'local')
const threadsDir = join(project.cwd, '.temp-code', 'threads')

/** A thread row without booting a harness — this test never calls a model. */
let n = 0
const fakeThread = (over: Partial<SessionMeta>): SessionMeta => {
  const meta = {
    id: `idxthread${(n += 1).toString().padStart(2, '0')}`,
    parentId: null,
    projectId: project.id,
    workspaceId: null,
    threadType: 'implementation',
    planPath: null,
    provider: 'claude',
    model: 'claude-opus-5',
    reasoning: 'medium',
    agentType: 'implementer',
    title: 'Thread',
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
    updatedAt: Date.now(),
    ...over
  } as SessionMeta
  store.insertSession(meta)
  return meta
}
const log = (id: string, ...events: AgentEvent[]): void => {
  for (const e of events) store.appendEvent(id, e)
}
const call = (name: string, input: unknown): AgentEvent => ({
  type: 'tool-call',
  callId: `c${Math.random().toString(36).slice(2)}`,
  name,
  input
})

// ── files: frontmatter + ## Outcome ──────────────────────────────────
const a = fakeThread({ title: 'Fix the cursor driver' })
log(
  a.id,
  { type: 'user-text', text: 'fix cursor' },
  call('Read', { file_path: join(project.cwd, 'src/renderer/App.tsx') }),
  call('Bash', { command: 'bun run typecheck' }),
  call('Edit', { file_path: join(project.cwd, 'src/main/server/drivers/cursor.ts') }),
  call('Read', { file_path: '/tmp/outside-the-checkout.log' }),
  call('Write', { file_path: join(project.cwd, '.temp-code/plan-x.md') }),
  { type: 'assistant-text', text: 'first turn', delta: false },
  { type: 'user-text', text: 'now what' },
  { type: 'assistant-text', text: 'Cursor shell output now renders as a terminal.', delta: false }
)
mirrorSession(registry, a.id)
const aFile = readdirSync(threadsDir).find((f) => f.startsWith(a.id))!
const aText = readFileSync(join(threadsDir, aFile), 'utf8')
const aFiles = aText.split('\n').find((l) => l.startsWith('files: ')) ?? ''
check(
  'files: lists writes before reads, project-relative',
  aText.includes('files: src/main/server/drivers/cursor.ts, src/renderer/App.tsx'),
  aFiles || '(no files line)'
)
check('files: skips paths outside the checkout', !aFiles.includes('outside-the-checkout'))
check('files: skips the app context dir', !aFiles.includes('.temp-code/'))
check('files: skips tool calls with no path', !aFiles.includes('typecheck'))
check(
  '## Outcome carries the LAST turn, right after frontmatter',
  /^---\n[\s\S]*?\n---\n\n## Outcome\n\nCursor shell output now renders as a terminal\./.test(aText),
  aText.slice(0, 60).replace(/\n/g, '⏎')
)
check('## Outcome is not the first turn', !/## Outcome\n\nfirst turn/.test(aText))

// cap: 20 files, no more
const big = fakeThread({ title: 'Touches everything' })
log(
  big.id,
  { type: 'user-text', text: 'sweep' },
  ...Array.from({ length: 30 }, (_, i) =>
    call('Write', { file_path: join(project.cwd, `src/f${i}.ts`) })
  ),
  { type: 'assistant-text', text: 'done', delta: false }
)
mirrorSession(registry, big.id)
const bigLine =
  readFileSync(join(threadsDir, readdirSync(threadsDir).find((f) => f.startsWith(big.id))!), 'utf8')
    .split('\n')
    .find((l) => l.startsWith('files: ')) ?? ''
check('files: caps at 20', bigLine.split(', ').length === 20, `${bigLine.split(', ').length} entries`)

// ── INDEX.md ─────────────────────────────────────────────────────────
const older = fakeThread({
  title: 'Older work',
  threadType: 'planning',
  planPath: join(project.cwd, '.temp-code', 'plan-idxthread03.md'),
  updatedAt: Date.now() - 5 * 86_400_000
})
log(older.id, { type: 'user-text', text: 'x' }, { type: 'assistant-text', text: 'y', delta: false })
mirrorSession(registry, older.id)
const index = readFileSync(join(threadsDir, 'INDEX.md'), 'utf8')
check(
  'INDEX.md exists with a line per thread',
  index.split('\n').filter((l) => l.startsWith('- ')).length === 3,
  `${index.split('\n').filter((l) => l.startsWith('- ')).length} lines`
)
check(
  'INDEX.md line carries date, type, title, status, files and path',
  /- \d{4}-\d{2}-\d{2} · implementation · "Fix the cursor driver" · idle · files: src\/main\/server\/drivers\/cursor\.ts, src\/renderer\/App\.tsx · threads\/idxthread01-/.test(index),
  index.split('\n').find((l) => l.includes('cursor')) ?? ''
)
check(
  'INDEX.md names a planning thread\'s plan file',
  index.includes('· plan: plan-idxthread03.md ·'),
  index.split('\n').find((l) => l.includes('Older work')) ?? ''
)
const order = index.split('\n').filter((l) => l.startsWith('- '))
check(
  'INDEX.md is newest first',
  !order[0].includes('Older work') && order.at(-1)!.includes('Older work'),
  order.map((l) => l.slice(2, 40)).join(' | ')
)

// ── boot backfill lifts mirrors written before the new fields ────────
const stale = fakeThread({ title: 'Pre-upgrade thread' })
log(
  stale.id,
  { type: 'user-text', text: 'old' },
  call('Edit', { file_path: join(project.cwd, 'src/legacy.ts') }),
  { type: 'assistant-text', text: 'legacy outcome text', delta: false }
)
writeFileSync(
  join(threadsDir, `${stale.id}-pre-upgrade-thread.md`),
  `---\ntitle: "Pre-upgrade thread"\ntype: implementation\nstatus: idle\nupdated: ${new Date().toISOString()}\nsessionId: ${stale.id}\n---\n\n## User\n\nold\n`
)
backfillMirrors(registry)
await sleep(6_000)
const lifted = readFileSync(join(threadsDir, `${stale.id}-pre-upgrade-thread.md`), 'utf8')
check('backfill adds files: to an old mirror', lifted.includes('files: src/legacy.ts'), lifted.slice(0, 200))
check('backfill adds ## Outcome to an old mirror', lifted.includes('## Outcome\n\nlegacy outcome text'))
check('backfill leaves INDEX.md complete', readFileSync(join(threadsDir, 'INDEX.md'), 'utf8').includes('Pre-upgrade thread'))

// ── journal rotation ─────────────────────────────────────────────────
const bullets = Array.from(
  { length: 120 },
  (_, i) =>
    `- 2026-0${(i % 9) + 1}-1${i % 10} — entry ${i}: shipped a durable outcome and wrote it down in src/some/file-${i}.ts`
)
writeFileSync(journalPath(project.cwd), `# Idx\n\n_journal_\n\n## Log\n\n${bullets.join('\n')}\n`)
const before = readFileSync(journalPath(project.cwd), 'utf8').length
mirrorSession(registry, a.id) // the app's own write path rotates
const after = readFileSync(journalPath(project.cwd), 'utf8')
const archive = readFileSync(join(project.cwd, '.temp-code', 'PROJECT-archive.md'), 'utf8')
check('journal rotated below the cap', after.length < before && after.length < 6_000, `${before} → ${after.length}`)
check('journal keeps its newest entries', after.includes('entry 119:'))
check('archive took the oldest entry verbatim', archive.includes('- 2026-01-10 — entry 0: shipped a durable outcome and wrote it down in src/some/file-0.ts'))
check('archive pointer sits under ## Log', /## Log\n\n_Older entries: PROJECT-archive\.md\._\n/.test(after), after.slice(0, 140).replace(/\n/g, '⏎'))
check('journal keeps its preamble', after.startsWith('# Idx\n\n_journal_\n\n## Log'))
mirrorSession(registry, a.id)
check('rotation is idempotent under the cap', readFileSync(journalPath(project.cwd), 'utf8') === after)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
