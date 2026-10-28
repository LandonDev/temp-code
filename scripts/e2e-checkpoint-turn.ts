/**
 * Undo checkpoints kept by the host from its own turn (checkpointTurns.ts),
 * end to end. An isolated registry with its own database and no socket at
 * all (a headless host), a scratch git repo, and one claude-haiku-5-5 thread
 * in full access told to create two files. Proves:
 *   1. After the turn settles the session's manifest holds both paths: the
 *      host captured them from its own live edits and settle, no window open.
 *   2. checkpoint.status (the host-side function the RPC calls, the cwd read
 *      off the session row) lists both.
 *   3. A file the person makes by hand between the turns is snapshotted as
 *      their baseline by the second send's ensure (in `files`, not
 *      `touched`), the review omits it, and Undo all leaves it on disk
 *      while it removes the thread's files and drops the checkpoint.
 *   4. The git children the checkpoint spent on a turn are bounded: the
 *      ensure's diff, one ls-files, the HEAD lookups and one settle diff,
 *      never one per path; the second send's refresh is one diff more.
 * Run: bun run script:e2e-checkpoint-turn
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { CheckpointStore, inHeadMany, listTracked } from '../src/main/server/checkpoint'
import { CheckpointTurns } from '../src/main/server/checkpointTurns'
import { closeAllLiveWatchers, onLiveEdit } from '../src/main/server/livediff'
import { onBudgetedSpawn } from '../src/main/server/spawnBudget'
import type { AgentEvent, EventRow } from '../src/shared/events'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-cp-turn-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'

// The host's wiring, as src/main/server/index.ts has it; the push goes nowhere (no socket).
const checkpoints = new CheckpointStore(join(dataDir, 'checkpoints'))
const pushes: string[] = []
const turns = new CheckpointTurns({
  store: checkpoints,
  session: (id) => store.getSession(id),
  listTracked,
  inHeadMany,
  push: (sessionId) => pushes.push(sessionId)
})
registry.checkpoints = turns
registry.onEvent((row) => void turns.observe(row))
const offEdits = onLiveEdit((push) => void turns.liveEdit(push))

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// A scratch repo with one commit.
const repo = mkdtempSync(join(tmpdir(), 'tc-cp-turn-repo-'))
const git = (...args: string[]): string =>
  execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main')
writeFileSync(join(repo, 'README.md'), '# scratch\n')
git('add', '-A')
git('commit', '-q', '-m', 'init')

// Every git child the checkpoint path starts in this repo: checkpoint.ts and
// gitops both run `git --no-pager -C <repo>`; livediff's own children do not.
const children: string[][] = []
const offSpawns = onBudgetedSpawn((file, args) => {
  if (file === 'git' && args[0] === '--no-pager' && args[1] === '-C' && args[2] === repo) children.push(args.slice(3))
})
const settledEdits: string[] = []
const offWatch = onLiveEdit((push) => {
  if (push.edit.settled) settledEdits.push(push.edit.path)
})

/** The turn's settle past `afterSeq`: a scan from 0 would answer an earlier turn's. */
function settled(sessionId: string, afterSeq = 0, timeoutMs = 240_000): Promise<AgentEvent> {
  const isSettle = (e: AgentEvent): boolean =>
    e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, afterSeq).find((r) => isSettle(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${sessionId}`))
    }, timeoutMs)
    const off = registry.subscribe(sessionId, (row: EventRow) => {
      if (isSettle(row.event)) {
        clearTimeout(timer)
        off()
        resolve(row.event)
      }
    })
  })
}

// ── the turn ──────────────────────────────────────────────────────────────
console.log('\n[1] one haiku turn that creates two files')
const s = await registry.create({
  provider: 'claude',
  model: 'claude-haiku-5-5',
  reasoning: 'low',
  permission: 'auto',
  cwd: repo,
  threadType: 'chat',
  parentId: null,
  title: 'Checkpoint turn'
})
await registry.send(
  s.id,
  'This is a file test. Create two files in the current directory with the Write tool: ' +
    'a.txt containing exactly the line `alpha`, and b.txt containing exactly the line `beta`. ' +
    'Do nothing else, then reply with exactly: done.'
)
const end = await settled(s.id)
check('the turn completed', end.type === 'turn-complete', end.type === 'status' ? end.status : end.type)
// A path's live edit settles 2 s after its last write, possibly after the
// turn; its write lands at most 5 s later. Then the queue must be empty.
await sleep(8_000)
await turns.written(s.id)
// The turn's children end here: the status below runs a diff of its own.
const turnChildren = children.slice()
check('both files exist', existsSync(join(repo, 'a.txt')) && existsSync(join(repo, 'b.txt')))
check('the host saw the settled live edits', ['a.txt', 'b.txt'].every((p) => settledEdits.includes(p)), settledEdits.join(','))

// ── what the host kept ────────────────────────────────────────────────────
console.log('\n[2] the manifest and checkpoint.status')
const manifestPath = join(dataDir, 'checkpoints', s.id, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { touched: string[]; files: Record<string, string> }
check('the manifest holds both paths', ['a.txt', 'b.txt'].every((p) => manifest.touched.includes(p)), manifest.touched.join(','))
check('no snapshot of the agent\'s bytes', !Object.keys(manifest.files).some((p) => p === 'a.txt' || p === 'b.txt'), JSON.stringify(manifest.files))
const status = await turns.status(s.id)
check('checkpoint.status lists both', status.files.map((f) => f.relative).join(',') === 'a.txt,b.txt', status.files.map((f) => `${f.relative}:${f.status}`).join(','))
check('the settle said checkpoint-changed', pushes.includes(s.id), `${pushes.length} pushes`)

// ── the git children ──────────────────────────────────────────────────────
console.log('\n[3] git children the checkpoint spent on the turn')
const kind = (args: string[]): string =>
  args.includes('ls-files') ? 'ls-files' : args.includes('ls-tree') ? 'ls-tree' : args.includes('--numstat') ? 'diff' : 'diff-info'
const counts = turnChildren.reduce<Record<string, number>>((n, args) => ({ ...n, [kind(args)]: (n[kind(args)] ?? 0) + 1 }), {})
for (const args of turnChildren) console.log(`      git ${args.join(' ').slice(0, 110)}`)
// One gitDiffIndex, measured alone, so the bound names its size.
children.length = 0
const { gitDiffIndex } = await import('../src/main/server/gitops')
await gitDiffIndex(repo)
const perDiff = children.length
const bound = 2 * perDiff + 1 + 2
console.log(`      ${turnChildren.length} children: ${JSON.stringify(counts)}; one index diff is ${perDiff}`)
check('two index diffs: the ensure and the settle', counts.diff === 2, `${counts.diff ?? 0}`)
check('at most one ls-files', (counts['ls-files'] ?? 0) <= 1, `${counts['ls-files'] ?? 0}`)
check('at most two HEAD lookups (the settle\'s unknown paths, the sync\'s claims)', (counts['ls-tree'] ?? 0) <= 2, `${counts['ls-tree'] ?? 0}`)
check(`bounded: ${turnChildren.length} ≤ 2 × ${perDiff} + 1 + 2`, turnChildren.length <= bound)

// ── the person's file between the turns ───────────────────────────────────
console.log('\n[4] a file made by hand between the turns, then a second turn')
writeFileSync(join(repo, 'hand.txt'), 'by hand\n')
const lastSeq = registry.eventsAfter(s.id, 0).at(-1)?.seq ?? 0
children.length = 0
await registry.send(
  s.id,
  'Create one more file in the current directory with the Write tool: c.txt containing exactly the line `gamma`. ' +
    'Do nothing else, then reply with exactly: done.'
)
const end2 = await settled(s.id, lastSeq)
check('the second turn completed', end2.type === 'turn-complete', end2.type === 'status' ? end2.status : end2.type)
await sleep(8_000)
await turns.written(s.id)
const turn2Children = children.slice()
const manifest2 = JSON.parse(readFileSync(manifestPath, 'utf8')) as { touched: string[]; files: Record<string, string> }
check('the second send snapshotted the hand-made file as the baseline', manifest2.files['hand.txt'] === 'contents', JSON.stringify(manifest2.files))
check('the hand-made file is not touched', !manifest2.touched.includes('hand.txt'), manifest2.touched.join(','))
check('the manifest holds all three of the thread\'s paths', ['a.txt', 'b.txt', 'c.txt'].every((p) => manifest2.touched.includes(p)), manifest2.touched.join(','))
const status2 = await turns.status(s.id)
check('checkpoint.status lists the thread\'s three and omits the hand-made file', status2.files.map((f) => f.relative).join(',') === 'a.txt,b.txt,c.txt', status2.files.map((f) => f.relative).join(','))
const counts2 = turn2Children.reduce<Record<string, number>>((n, args) => ({ ...n, [kind(args)]: (n[kind(args)] ?? 0) + 1 }), {})
console.log(`      ${turn2Children.length} children: ${JSON.stringify(counts2)}`)
check('two index diffs on the second turn: the refresh and the settle', counts2.diff === 2, `${counts2.diff ?? 0}`)
check(`bounded: ${turn2Children.length} ≤ 2 × ${perDiff} + 1 + 3`, turn2Children.length <= 2 * perDiff + 1 + 3)

// ── undo ──────────────────────────────────────────────────────────────────
console.log('\n[5] undo all')
const undone = await turns.undo(s.id)
check('undo answers an empty review', undone.files.length === 0)
check('the thread\'s files are gone', ['a.txt', 'b.txt', 'c.txt'].every((p) => !existsSync(join(repo, p))))
check('the hand-made file survives with its bytes', existsSync(join(repo, 'hand.txt')) && readFileSync(join(repo, 'hand.txt'), 'utf8') === 'by hand\n')
check('the checkpoint is dropped', !existsSync(join(dataDir, 'checkpoints', s.id)))
check('the tree holds only the hand-made file', git('status', '--porcelain').trim() === '?? hand.txt', git('status', '--porcelain').trim())

offSpawns()
offWatch()
offEdits()
await registry.disposeAll()
await closeAllLiveWatchers()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
