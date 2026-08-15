/**
 * M12 exit test (docs/PLAN-3.md): the git flow.
 * Worktree project off a chosen baseRef → branch + fork point correct;
 * fs.write → changes; commit a path subset → exactly that subset; push
 * lands tc/<slug> on a bare origin; targetBranch push lands HEAD:<other>;
 * the workspace checkout is bit-identical before/after (the isolation
 * claim, asserted); adopt an existing branch and commit to it.
 * Run: bun run script:e2e-git-flow
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { fsWrite } from '../src/main/server/files'
import { aheadCount, branches, commit, log, push, workingTreeChanges } from '../src/main/server/git'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim()

// ── scratch repo + bare origin ───────────────────────────────────────
const repo = mkdtempSync(join(tmpdir(), 'tc-git-repo-'))
git(repo, 'init', '-b', 'main')
git(repo, 'config', 'user.email', 'e2e@temp-code.local')
git(repo, 'config', 'user.name', 'e2e')
writeFileSync(join(repo, 'one.txt'), 'first\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'first')
const firstSha = git(repo, 'rev-parse', 'HEAD')
writeFileSync(join(repo, 'two.txt'), 'second\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-m', 'second')
const origin = mkdtempSync(join(tmpdir(), 'tc-git-origin-'))
execFileSync('git', ['init', '--bare', origin])
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', 'origin', 'main')
// A PR-style branch to adopt later.
git(repo, 'branch', 'feature/pr', firstSha)

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-git-db-')), 'git.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
const ws = await registry.createWorkspace(repo, 'git-ws')

// Snapshot the workspace checkout — the isolation claim.
const snapshot = (): string =>
  [
    git(repo, 'rev-parse', 'HEAD'),
    git(repo, 'status', '--porcelain'),
    git(repo, 'stash', 'list')
  ].join('|')
const before = snapshot()

// ── worktree project off a chosen baseRef ────────────────────────────
const project = await registry.createProject(ws.id, 'Flow', 'worktree', { baseRef: firstSha })
// Pattern, not literal: a leftover worktree from a prior run bumps the slug.
check('project branch is tc/<slug>', /^tc\/flow(-\d+)?$/.test(project.branch ?? ''), project.branch ?? 'null')
check(
  'fork point honors baseRef',
  git(project.cwd, 'rev-parse', 'HEAD') === firstSha,
  git(project.cwd, 'rev-parse', 'HEAD')
)

// ── change → commit a subset → push ──────────────────────────────────
fsWrite(project.cwd, 'kept.txt', 'commit me\n')
fsWrite(project.cwd, 'debris.txt', 'leave me out\n')
const changes = await workingTreeChanges(project.cwd)
check(
  'changes rail sees both files',
  changes.some((c) => c.path === 'kept.txt') && changes.some((c) => c.path === 'debris.txt')
)
const c1 = await commit(project.cwd, 'add kept only', ['kept.txt'])
check('commit returns sha + summary', c1.sha.length === 40 && c1.summary === 'add kept only')
const after1 = await workingTreeChanges(project.cwd)
check(
  'path-subset commit: debris stays uncommitted',
  !after1.some((c) => c.path === 'kept.txt') && after1.some((c) => c.path === 'debris.txt'),
  JSON.stringify(after1)
)
check('ahead of upstream: null before first push', (await aheadCount(project.cwd)) === null)
const p1 = await push(project.cwd)
check('push lands the project branch', p1.branch === project.branch)
check(
  'origin has the project branch at the commit',
  git(origin, 'rev-parse', project.branch!) === c1.sha,
  git(origin, 'rev-parse', project.branch!)
)
check('ahead is 0 after push', (await aheadCount(project.cwd)) === 0)

// ── targetBranch push: same work, different remote branch ────────────
const p2 = await push(project.cwd, 'review/flow')
check('targetBranch push reports the target', p2.branch === 'review/flow')
check('origin got review/flow', git(origin, 'rev-parse', 'review/flow') === c1.sha)

// ── history + branches ───────────────────────────────────────────────
const commits = await log(project.cwd, 10)
check(
  'log: newest first with subjects',
  commits[0]?.subject === 'add kept only' && commits.length === 2
)
const br = await branches(repo)
check(
  'branches: locals + remotes + current',
  br.locals.includes('main') &&
    br.locals.includes('feature/pr') &&
    br.remotes.some((r) => r.endsWith(project.branch!)) &&
    br.current === 'main',
  JSON.stringify(br)
)

// ── the isolation claim ──────────────────────────────────────────────
check('workspace checkout bit-identical after all of it', snapshot() === before, snapshot())

// ── adopt an existing branch as a project ────────────────────────────
const adopted = await registry.createProject(ws.id, 'PR Review', 'worktree', {
  existingBranch: 'feature/pr'
})
check('adopted project rides the branch', adopted.branch === 'feature/pr', adopted.branch ?? 'null')
check('adopted checkout is at the branch tip', git(adopted.cwd, 'rev-parse', 'HEAD') === firstSha)
fsWrite(adopted.cwd, 'pr-fix.txt', 'review fix\n')
const c2 = await commit(adopted.cwd, 'fix from review')
check('commit on adopted branch works', c2.summary === 'fix from review')
check('feature/pr advanced in the shared repo', git(repo, 'rev-parse', 'feature/pr') === c2.sha)
check('workspace checkout still untouched', snapshot() === before)

// Leave nothing in ~/.temp-code/worktrees — the next run starts clean.
git(repo, 'worktree', 'remove', '--force', project.cwd)
git(repo, 'worktree', 'remove', '--force', adopted.cwd)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
