/**
 * Headless check of the GitHub inbox fetch against real checkouts
 * (.temp-code/plan-04gDfvEdr5SL.md, slice b). Opens a temp database,
 * registers one workspace per GitHub checkout (every folder under
 * ~/IdeaProjects whose .git/config names a github.com origin, or the
 * folders in --dirs=a,b,c), runs one real refresh, prints per-repo counts,
 * the rateLimit cost and elapsed ms, then checks: rows stored, snapshot()
 * round-trips from SQLite, a second refresh inside 15 s makes no request,
 * snapshot() spawns nothing and fetches nothing, and the refresh reads the
 * gh token exactly once (its only gh path).
 * Run: bun run script:e2e-github-inbox
 */
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { ghAuthToken } from '../src/main/server/github'
import { GithubInbox } from '../src/main/server/githubInbox'
import { githubRepoFromRemote, parseOriginUrl } from '../src/main/server/gitRemote'
import { SessionRegistry } from '../src/main/server/sessions'
import { childBudget, trackedChildren } from '../src/main/server/spawnBudget'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function githubCheckouts(parent: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(parent)) {
    const dir = join(parent, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      const url = parseOriginUrl(readFileSync(join(dir, '.git', 'config'), 'utf8'))
      if (url && githubRepoFromRemote(url)) out.push(dir)
    } catch {
      // not a main checkout
    }
  }
  return out
}

const dirsArg = process.argv.find((a) => a.startsWith('--dirs='))
const dirs = dirsArg
  ? dirsArg.slice('--dirs='.length).split(',').filter(Boolean)
  : githubCheckouts(join(homedir(), 'IdeaProjects'))
if (dirs.length === 0) {
  console.log('no GitHub checkouts found; pass --dirs=a,b,c')
  process.exit(1)
}

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ghinbox-')), 'inbox.db')))
const registry = new SessionRegistry(store)
for (const dir of dirs) await registry.createWorkspace(dir)
const slugs = [...new Set(registry.listWorkspaces().map((w) => w.githubRepo).filter(Boolean))]
console.log(`${dirs.length} checkouts, ${slugs.length} distinct repos: ${slugs.join(', ')}`)

// Measured, not assumed: every fetch, every token read, every budgeted child
// (gh runs through the child budget; so does the one-time login-shell PATH probe).
let fetches = 0
let tokenReads = 0
let budgetedSpawns = 0
const acquire = childBudget.acquire.bind(childBudget)
childBudget.acquire = () => {
  budgetedSpawns += 1
  return acquire()
}
const logs: string[] = []
const inbox = new GithubInbox(store, registry, {
  fetch: (input, init) => {
    fetches += 1
    return fetch(input, init)
  },
  token: () => {
    tokenReads += 1
    return ghAuthToken()
  },
  log: (line) => {
    logs.push(line)
    console.log(line)
  }
})

const t0 = Date.now()
const snap = await inbox.refresh('manual')
const elapsed = Date.now() - t0
const spawnsAfterRefresh = budgetedSpawns

for (const repo of snap.repos) {
  const prs = repo.items.filter((i) => i.kind === 'pr')
  const issues = repo.items.filter((i) => i.kind === 'issue')
  console.log(
    `  ${repo.repo.padEnd(40)} ${String(prs.length).padStart(3)} PRs (${prs.filter((p) => p.state === 'open').length} open)  ${String(issues.length).padStart(3)} issues (${issues.filter((p) => p.state === 'open').length} open)${repo.error ? `  ERROR: ${repo.error}` : ''}`
  )
}
const cost = Number(/(\d+) points/.exec(logs[0] ?? '')?.[1] ?? -1)
console.log(`viewer=${snap.viewer} auth=${snap.auth.state} fetches=${fetches} cost=${cost} elapsed=${elapsed} ms`)

check('auth ok', snap.auth.state === 'ok', snap.auth.message)
check('at least one repo stored', snap.repos.length >= 1, `${snap.repos.length}`)
check('every workspace repo has a row', slugs.every((s) => snap.repos.some((r) => r.repo === s)))
check(
  'no repo row carries an error',
  snap.repos.every((r) => r.error === null),
  snap.repos.filter((r) => r.error).map((r) => `${r.repo}: ${r.error}`).join('; ')
)
check('some items came back', snap.repos.some((r) => r.items.length > 0))
check('viewer login known', !!snap.viewer, String(snap.viewer))
check('one log line with the cost', logs.length === 1 && cost >= 0, logs.join(' | '))
check('under 10 s', elapsed < 10_000, `${elapsed} ms`)

const fetchesBefore = fetches
const childrenBefore = trackedChildren()
const again = inbox.snapshot()
check(
  'snapshot() round-trips from SQLite',
  JSON.stringify(again.repos) === JSON.stringify(snap.repos) && again.viewer === snap.viewer && again.fetchedAt === snap.fetchedAt
)
check('snapshot() made no fetch', fetches === fetchesBefore)
check('snapshot() spawned nothing', trackedChildren() === childrenBefore && budgetedSpawns === spawnsAfterRefresh)

const t1 = Date.now()
const throttled = await inbox.refresh('interval')
check(
  'a second refresh inside 15 s makes no request and spawns nothing',
  fetches === fetchesBefore && throttled.fetchedAt === snap.fetchedAt && budgetedSpawns === spawnsAfterRefresh,
  `${Date.now() - t1} ms`
)
check('the refresh read the gh token exactly once', tokenReads === 1, `${tokenReads}`)
check(
  'at most two budgeted children for the whole run (login-shell PATH probe + gh auth token)',
  budgetedSpawns <= 2,
  `${budgetedSpawns}`
)

console.log(`\nRESULT repos=${snap.repos.length} cost=${cost} elapsed=${elapsed}ms fetches=${fetchesBefore} budgetedSpawns=${budgetedSpawns}`)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
