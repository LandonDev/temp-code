/**
 * The gate out of the children, end to end (src/main/server/{gateQueue,
 * gateRun,mergeReview,batch}.ts). An isolated registry with its own database
 * (no Electron, no window), a scratch repo with a bare origin, two worktrees,
 * a master thread pinned on the project and two claude-haiku-5-5 children
 * that carry its id. The gate steps are stubbed through TEMP_CODE_GATE_STUB
 * so nothing runs the real gate on the scratch repo. Proves:
 *   1. child a commits and calls merge_branch: typecheck alone (stubbed
 *      green) on its worktree, merged and pushed, a green gate row, the
 *      batch's land step "1 of 2 landed";
 *   2. child b, its typecheck stubbed red: HELD, a red gate row carrying the
 *      log tail, origin/master unmoved, the land step unchanged;
 *   3. the stub flipped and child b told to call merge_branch again: merged,
 *      "2 of 2 landed", land done;
 *   4. the master calls batch_gate: the gate (stubbed) streams its ✓ lines
 *      into the step's detail, the release step tags, the batch push fired
 *      on every change, gate and release rows on the master, every step done;
 *   5. a child thread never gets batch_gate; the master does; the bridge
 *      maps it.
 * Run: bun run script:e2e-batch-gate
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { appToolsMcp, setAppToolsRegistry } from '../src/main/server/apptools'
import { Batches, setBatches } from '../src/main/server/batch'
import { MergeReviews, setMergeReviews } from '../src/main/server/mergeReview'
import type { BatchState } from '../src/shared/contract-batch'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const log = (m: string): void => console.log(`      ${m}`)

// ── the scratch repo: origin, master, two worktrees ─────────────────────
const root = mkdtempSync(join(tmpdir(), 'tc-batch-gate-'))
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'proof',
  GIT_AUTHOR_EMAIL: 'proof@example.invalid',
  GIT_COMMITTER_NAME: 'proof',
  GIT_COMMITTER_EMAIL: 'proof@example.invalid'
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: gitEnv }).trim()
const origin = join(root, 'origin.git')
const repo = join(root, 'repo')
mkdirSync(repo)
execFileSync('git', ['init', '--bare', '-b', 'master', origin])
execFileSync('git', ['init', '-b', 'master', repo])
writeFileSync(join(repo, 'README.md'), 'batch gate proof\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')
const wt = (name: string): string => {
  const dir = join(root, `wt-${name}`)
  git(repo, 'worktree', 'add', '-q', '-b', `child-${name}`, dir, 'master')
  return dir
}
const wtA = wt('a')
const wtB = wt('b')
const originHas = (file: string): boolean => {
  try {
    git(origin, 'cat-file', '-e', `master:${file}`)
    return true
  } catch {
    return false
  }
}

// ── the registry, the batch and merge_branch's engine ───────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'tc-batch-gate-data-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'
const batches = new Batches({ registry, store })
setBatches(batches)
setMergeReviews(new MergeReviews({ registry, store, onLanded: (l) => batches.landed(l) }))
const pushes: BatchState[] = []
batches.onChange((s) => pushes.push(s))

const stub = (bRed: boolean): void => {
  process.env.TEMP_CODE_GATE_STUB = JSON.stringify([
    ...(bRed ? [{ step: 'typecheck', branch: 'child-b', ok: false, log: 'src/b.ts(1,1): error TS2322: proof break\nFound 1 error in 1 file.' }] : []),
    { step: 'typecheck', ok: true, log: 'stub typecheck clean' },
    { step: 'gate', ok: true, log: '✓ typecheck 1s passed\n✓ vitest 2s passed\n✓ build 3s passed' },
    { step: 'release', ok: true, log: 'released v1 (tag release-1, package.json 1.0.1) — publish it with: bun run release:publish' }
  ])
}
stub(true)

const isSettle = (e: AgentEvent): boolean =>
  e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
function settledAfter(id: string, seq: number, timeoutMs = 300_000): Promise<EventRow> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(id, seq).find((r) => isSettle(r.event))
    if (prior) return resolve(prior)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${id} after ${seq}`))
    }, timeoutMs)
    const off = registry.subscribe(id, (row: EventRow) => {
      if (row.seq > seq && isSettle(row.event)) {
        clearTimeout(timer)
        off()
        resolve(row)
      }
    })
  })
}
const lastSeq = (id: string): number => registry.eventsAfter(id, 0).at(-1)?.seq ?? 0
async function turn(id: string, text: string): Promise<void> {
  const seq = lastSeq(id)
  await registry.send(id, text)
  await settledAfter(id, seq)
}
const notices = (id: string, kind: string) =>
  registry
    .eventsAfter(id, 0)
    .map((r) => r.event)
    .filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.kind === kind)
const toolResults = (id: string): string[] =>
  registry
    .eventsAfter(id, 0)
    .map((r) => r.event)
    .filter((e): e is Extract<AgentEvent, { type: 'tool-result' }> => e.type === 'tool-result')
    .map((e) => (typeof e.output === 'string' ? e.output : JSON.stringify(e.output)))
const steps = (s: BatchState) => Object.fromEntries(s.steps.map((x) => [x.id, `${x.status}: ${x.detail}`]))
const toolNames = (meta: SessionMeta): string[] =>
  Object.keys((appToolsMcp(meta).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)

const ws = await registry.createWorkspace(repo, 'batch-ws')
const project = await registry.createProject(ws.id, 'Batch', 'local')
check('project on master in the scratch repo', project.cwd === repo && project.branch === 'master', `${project.cwd} ${project.branch}`)
const MODEL = 'claude-haiku-5-5'
const master = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', agentType: 'orchestrator', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'Batch proof' })
registry.setProjectMaster(project.id, master.id)
const child = (name: string, cwd: string) =>
  registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', agentType: 'implementer', permission: 'auto', projectId: project.id, threadType: 'implementation', parentId: null, cwd, masterId: master.id, title: `child ${name}` })
const a = await child('a', wtA)
const b = await child('b', wtB)
check('children carry the master id', a.masterId === master.id && b.masterId === master.id)
check('batch_gate is offered to the master and to no child', toolNames(master).includes('batch_gate') && !toolNames(a).includes('batch_gate'))

/** A session in a project runs in the project checkout (sessions.ts create);
 *  a thread works in a worktree by going there, as the house preamble says,
 *  and names its branch to merge_branch. */
const brief = (name: string, dir: string): string =>
  `This is a test; ask no questions and spawn nothing. The directory ${dir} is a worktree of this repo on branch child-${name}. There (use \`git -C ${dir}\` for every git command) create the file ${name}.txt containing exactly "${name}", run \`git -C ${dir} add ${name}.txt\` and \`git -C ${dir} commit -m "child ${name}: add ${name}.txt"\`, then call the merge_branch tool ONCE with branch "child-${name}" and report its whole answer in one short sentence. Do not run typecheck, tests, git merge or git push yourself. If the tool answers HELD, stop and wait.`

// ── 1. child a lands ─────────────────────────────────────────────────────
console.log('\n[1] child a: typecheck alone, merged')
await turn(a.id, brief('a', wtA))
check('a.txt on origin/master', originHas('a.txt'))
const gatesA = notices(a.id, 'gate')
check('one green typecheck row on a', gatesA.length === 1 && gatesA[0].gate?.step === 'typecheck' && gatesA[0].gate?.ok === true && gatesA[0].gate?.branch === 'child-a', JSON.stringify(gatesA.map((n) => n.message)))
check('merge row on a', notices(a.id, 'review').some((n) => n.review?.merged), JSON.stringify(notices(a.id, 'review').map((n) => n.message)))
let state = batches.get(master.id)
check('land running, 1 of 2 landed', steps(state).land === 'running: 1 of 2 landed' && state.landed[0] === a.id, JSON.stringify(steps(state)))

// ── 2. child b held ──────────────────────────────────────────────────────
console.log('\n[2] child b: typecheck red, HELD')
await turn(b.id, brief('b', wtB))
check('b.txt NOT on origin/master', !originHas('b.txt'))
const gatesB = notices(b.id, 'gate')
check('a red typecheck row on b with the log tail', gatesB.length === 1 && gatesB[0].gate?.ok === false && gatesB[0].gate?.log.includes('TS2322') && gatesB[0].message === 'Typecheck failed on child-b · 1 error', JSON.stringify(gatesB.map((n) => [n.message, n.gate?.log])))
check('the tool answered HELD', toolResults(b.id).some((t) => /^HELD: typecheck failed on child-b/.test(t)), toolResults(b.id).at(-1)?.slice(0, 120))
check('no merge row on b yet', notices(b.id, 'review').length === 0)
state = batches.get(master.id)
check('land still 1 of 2', steps(state).land === 'running: 1 of 2 landed', JSON.stringify(steps(state)))

// ── 3. the fix: b lands ──────────────────────────────────────────────────
console.log('\n[3] child b again, green')
stub(false)
// master moved under child-b when a landed: the rebase the preamble asks for, done here.
git(wtB, 'rebase', 'master')
await turn(b.id, 'The typecheck is fixed now. Call the merge_branch tool ONCE more with branch "child-b" and report its answer in one sentence.')
check('b.txt on origin/master', originHas('b.txt'))
check('a green typecheck row followed the red one', notices(b.id, 'gate').map((n) => n.gate?.ok).join(',') === 'false,true')
state = batches.get(master.id)
check('land done, 2 of 2 landed', steps(state).land === 'passed: 2 of 2 landed' && state.pending.length === 0, JSON.stringify(steps(state)))

// ── 4. the master gates and releases ─────────────────────────────────────
console.log('\n[4] batch_gate on the master')
const before = pushes.length
await turn(master.id, 'This is a test. Call the batch_gate tool ONCE with no arguments and report its whole answer verbatim in one sentence. Do nothing else.')
const answer = toolResults(master.id).find((t) => /^passed in/.test(t))
check('batch_gate answered passed and the tag', !!answer && answer.includes('release-1 tagged'), toolResults(master.id).at(-1)?.slice(0, 160))
state = batches.get(master.id)
check('every step done', steps(state).gate.startsWith('passed: passed in') && steps(state).release === 'passed: release-1 tagged', JSON.stringify(steps(state)))
const details = pushes.slice(before).map((p) => p.steps.find((s) => s.id === 'gate')!.detail)
check('the gate streamed its ✓ lines into the step detail (batch push)', details.includes('✓ typecheck 1s') && details.includes('✓ build 3s'), JSON.stringify(details))
const masterGates = notices(master.id, 'gate').map((n) => [n.gate?.step, n.gate?.ok])
check('gate and release rows on the master', JSON.stringify(masterGates) === JSON.stringify([['gate', true], ['release', true]]), JSON.stringify(masterGates))
check('the release notes carry the master title and the landed subjects', batches.notes(master, { masterId: master.id, steps: [], landed: [a.id, b.id], branches: {}, subjects: { [a.id]: ['child a: add a.txt'], [b.id]: ['child b: add b.txt'] } } as never) === 'Batch proof; child a: add a.txt; child b: add b.txt')

// ── 5. persistence ───────────────────────────────────────────────────────
console.log('\n[5] a new Batches instance reads the row back')
const again = new Batches({ registry, store })
check('steps survive', JSON.stringify(steps(again.get(master.id))) === JSON.stringify(steps(state)))
check('a thread outside a batch gets the commit tier', MergeReviews.stepFor({ masterId: null }) === 'gate' && MergeReviews.stepFor({ masterId: 'x' }) === 'typecheck')

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
log(`scratch: ${root}`)
process.exit(failures === 0 ? 0 : 1)
