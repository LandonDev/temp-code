/**
 * Layout-plan domain sanity: workspaces, projects (worktree + local),
 * thread types, first-send preamble hygiene, plan-file pipeline.
 * One cheap real claude turn (the planning smoke).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { workingTreeChanges } from '../src/main/server/git'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-dom-')), 'dom.db')))
const registry = new SessionRegistry(store)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

// A throwaway git repo as the workspace.
const repo = mkdtempSync(join(tmpdir(), 'tc-repo-'))
execFileSync('git', ['-C', repo, 'init', '-q'])
writeFileSync(join(repo, 'hello.txt'), 'hello\n')
execFileSync('git', ['-C', repo, 'add', '.'])
execFileSync('git', [
  '-C',
  repo,
  '-c',
  'user.email=t@t',
  '-c',
  'user.name=t',
  'commit',
  '-qm',
  'init'
])

// ── workspaces & projects ────────────────────────────────────────────
const ws = await registry.createWorkspace(repo)
check('workspace detects git', ws.git)
const dupe = await registry.createWorkspace(repo)
check('workspace create is idempotent by path', dupe.id === ws.id)

const wt = await registry.createProject(ws.id, 'Add Feature X', 'worktree')
// A stale worktree from an earlier run may force the -N suffix — both fine.
check(
  'worktree project branch',
  /^tc\/add-feature-x(-\d+)?$/.test(wt.branch ?? ''),
  String(wt.branch)
)
check(
  'worktree project cwd isolated',
  wt.cwd.startsWith(join(homedir(), '.temp-code', 'worktrees')) &&
    existsSync(join(wt.cwd, 'hello.txt'))
)
const local = await registry.createProject(ws.id, 'Quick Fix', 'local')
check('local project uses workspace path + branch', local.cwd === repo && local.branch !== null)

// ── thread creation semantics ────────────────────────────────────────
const orch = await registry.create({
  projectId: wt.id,
  threadType: 'orchestration',
  provider: 'claude',
  model: 'claude-sonnet-5-5'
})
check(
  'orchestration thread → orchestrator agent, project cwd',
  orch.agentType === 'orchestrator' && orch.cwd === wt.cwd
)
check('thread default title', orch.title === 'New orchestration')

const impl = await registry.create({
  projectId: wt.id,
  threadType: 'implementation',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  planPath: '/tmp/some-plan.md'
})
check('seeded implementation keeps planPath', impl.planPath === '/tmp/some-plan.md')

// ── changes detection ────────────────────────────────────────────────
writeFileSync(join(wt.cwd, 'hello.txt'), 'hello\nworld\n')
writeFileSync(join(wt.cwd, 'new.txt'), 'fresh\n')
const changes = await workingTreeChanges(wt.cwd)
check(
  'workingTreeChanges sees edit + untracked',
  changes.some((c) => c.path === 'hello.txt' && c.adds === 1) &&
    changes.some((c) => c.path === 'new.txt' && c.status === 'untracked'),
  JSON.stringify(changes)
)

// ── planning smoke (one real cheap claude turn) ──────────────────────
const plan = await registry.create({
  projectId: local.id,
  threadType: 'planning',
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low'
})
check('planning thread gets a planPath', !!plan.planPath && plan.planPath.includes(plan.id))

const settled = new Promise<void>((resolve) => {
  const off = registry.subscribe(plan.id, (row) => {
    if (
      row.event.type === 'status' &&
      (row.event.status === 'idle' || row.event.status === 'error')
    ) {
      off()
      resolve()
    }
  })
})
const typed =
  'Plan the smallest possible change: add a LICENSE file. One task only. No questions — write the plan immediately.'
await registry.send(plan.id, typed)
await Promise.race([settled, new Promise((r) => setTimeout(r, 180_000))])

const rows = registry.eventsAfter(plan.id, 0)
const userTexts = rows.filter((r) => r.event.type === 'user-text') as { event: { text: string } }[]
check(
  'transcript user-text is exactly what was typed',
  userTexts.length === 1 && userTexts[0].event.text === typed
)
check(
  'thread auto-titled from first message',
  store.getSession(plan.id)?.title.startsWith('Plan the smallest') === true
)
const planExists = !!plan.planPath && existsSync(plan.planPath)
check('plan document written to planPath', planExists)
if (!planExists) {
  // A silent live-harness failure is undebuggable — dump what the turn did.
  for (const r of rows) {
    const e = r.event
    if (e.type === 'tool-call')
      console.log('  tool:', e.name, String(JSON.stringify(e.input) ?? '').slice(0, 160))
    if (e.type === 'error') console.log('  error:', e.message)
    if (e.type === 'assistant-text' && !e.delta) console.log('  text:', e.text.slice(0, 200))
    if (e.type === 'status') console.log('  status:', e.status)
  }
}
if (planExists) {
  const doc = readFileSync(plan.planPath!, 'utf8')
  check('plan has a Tasks section', /##\s*Tasks/i.test(doc), doc.slice(0, 200))
}

// Leave nothing in ~/.temp-code/worktrees — repeat runs start clean.
try {
  execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', wt.cwd])
} catch {
  // best effort — the dir points at a throwaway tmp repo either way
}

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
