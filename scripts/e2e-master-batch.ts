/**
 * Master threads, the whole flow end to end (CLAUDE.md "Master threads",
 * docs/master-threads.md). An isolated registry with its own database (no
 * Electron, no window), a scratch repo with a bare origin and two
 * worktrees, every gate step stubbed through TEMP_CODE_GATE_STUB, every
 * thread claude-haiku-5-5. A chat thread is
 * pinned as the project's master and does the work itself, in real turns,
 * through its own tools. Proves:
 *   1. The master starts four children of three types with app_start_thread
 *      (two implementations, a plan, a research thread; the second
 *      implementation `after` the first); each carries masterId; three
 *      start at once and the `after` child sits `queued` with a "waiting
 *      for <sibling>" line; list_agents marks them `thread`.
 *   2. A child's settle wakes the master with a <subagent-report>; a child
 *      waiting on a question reports as waiting and the master answers it
 *      through answer_agent; the plan child's plan-complete report is its
 *      one report; the `after` child starts only once its sibling is idle
 *      after a turn.
 *   3. A child lands through merge_branch: typecheck stubbed red (HELD, a
 *      red GateNotice row) then green (merged, a review row, batch.get says
 *      1 landed).
 *   4. A chat thread that is not the master starts a Fable THREAD with
 *      app_start_thread (threads follow no model policy) and is refused a
 *      Fable SUBAGENT by spawn_agent; the master spawns one.
 *   5. The master set its rules with batch_rules at the start; with every
 *      child done the engine runs them on its own (gate and release
 *      stubbed green, nothing to publish or deploy), rows "Batch done" on
 *      the master, wakes it with a <batch-report>, and the master idles
 *      once that turn ends (it was watching while the batch was open).
 *      Then the master calls batch_gate: batch.get shows land, gate and
 *      release passed with the release tag in the detail.
 *   Wave 4: the pin is on the thread (session.setMaster; two masters in
 *      one project), the rules are a steps list with a shell step that runs
 *      last in the project checkout, a thread a batch child starts inherits
 *      the masterId with the child as its starter, batch.adopt brings a
 *      loose thread in and refuses a master, and batch.archive done
 *      archives the done children and leaves the master.
 * Run: bun run script:e2e-master-batch
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { Batches, setBatches } from '../src/main/server/batch'
import { MergeReviews, setMergeReviews } from '../src/main/server/mergeReview'
import { DEFAULT_PLAN_SETTINGS } from '../src/shared/plans'
import type { BatchState } from '../src/shared/contract-batch'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ── the scratch repo: origin, master, two worktrees ─────────────────────
const root = mkdtempSync(join(tmpdir(), 'tc-master-batch-'))
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
writeFileSync(join(repo, 'README.md'), 'master batch proof\n')
git(repo, 'add', '.')
git(repo, 'commit', '-q', '-m', 'init')
git(repo, 'remote', 'add', 'origin', origin)
git(repo, 'push', '-q', '-u', 'origin', 'master')
const wtA = join(root, 'wt-a')
git(repo, 'worktree', 'add', '-q', '-b', 'child-a', wtA, 'master')
const originHas = (file: string): boolean => {
  try {
    git(origin, 'cat-file', '-e', `master:${file}`)
    return true
  } catch {
    return false
  }
}

// ── the registry, the batch and merge_branch's engine ───────────────────
const dataDir = mkdtempSync(join(tmpdir(), 'tc-master-batch-data-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'
const batches = new Batches({ registry, store })
batches.attach()
setBatches(batches)
setMergeReviews(new MergeReviews({ registry, store, onLanded: (l) => batches.landed(l) }))

const stub = (aRed: boolean): void => {
  process.env.TEMP_CODE_GATE_STUB = JSON.stringify([
    ...(aRed ? [{ step: 'typecheck', branch: 'child-a', ok: false, log: 'src/a.ts(1,1): error TS2322: proof break\nFound 1 error in 1 file.' }] : []),
    { step: 'typecheck', ok: true, log: 'stub typecheck clean' },
    { step: 'gate', ok: true, log: '✓ typecheck 1s passed\n✓ vitest 2s passed\n✓ build 3s passed' },
    { step: 'release', ok: true, log: 'released v1 (tag release-1, package.json 1.0.1) — publish it with: bun run release:publish' }
  ])
}
stub(true)

// ── helpers over the event log ───────────────────────────────────────────
const isSettle = (e: AgentEvent): boolean =>
  e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
const rows = (id: string): EventRow[] => registry.eventsAfter(id, 0)
const lastSeq = (id: string): number => rows(id).at(-1)?.seq ?? 0
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
/** Wait until the predicate holds over the thread's rows (a row of a kind, a status). */
function rowsUntil(id: string, pred: (rows: EventRow[]) => boolean, timeoutMs = 300_000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (pred(rows(id))) return resolve()
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${id}`))
    }, timeoutMs)
    const off = registry.subscribe(id, () => {
      if (pred(rows(id))) {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
  })
}
/** The report from `agentId` after row `afterSeq` reached `id` and the wake turn it opened is over. */
async function reportSettled(id: string, agentId: string, afterSeq = 0, timeoutMs = 120_000): Promise<void> {
  const isReport = (x: EventRow): boolean => x.seq > afterSeq && x.event.type === 'agent-report' && x.event.agentId === agentId
  await rowsUntil(id, (rs) => rs.some(isReport), timeoutMs)
  await settledAfter(id, rows(id).find(isReport)!.seq, timeoutMs)
}
async function turn(id: string, text: string): Promise<void> {
  const seq = lastSeq(id)
  await registry.send(id, text)
  await settledAfter(id, seq)
}
const events = (id: string): AgentEvent[] => rows(id).map((r) => r.event)
const notices = (id: string, kind: string) =>
  events(id).filter((e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.kind === kind)
const toolResults = (id: string): string[] =>
  events(id)
    .filter((e): e is Extract<AgentEvent, { type: 'tool-result' }> => e.type === 'tool-result')
    .map((e) => (typeof e.output === 'string' ? e.output : JSON.stringify(e.output)))
const toolCalls = (id: string, name: string) =>
  events(id).filter(
    (e): e is Extract<AgentEvent, { type: 'tool-call' }> =>
      e.type === 'tool-call' && !e.partial && e.input !== undefined && e.name.endsWith(name)
  )
const reports = (id: string) =>
  events(id).filter((e): e is Extract<AgentEvent, { type: 'agent-report' }> => e.type === 'agent-report')
const finalText = (id: string): string =>
  events(id)
    .filter((e): e is Extract<AgentEvent, { type: 'assistant-text' }> => e.type === 'assistant-text' && !e.delta)
    .map((e) => e.text)
    .join(' ')
const firstRow = (id: string, pred: (e: AgentEvent) => boolean): EventRow | undefined => rows(id).find((r) => pred(r.event))
const steps = (s: BatchState) => Object.fromEntries(s.steps.map((x) => [x.id, `${x.status}: ${x.detail}`]))

// ── the picture over time: every meta change the registry pushes ────────
const LIVE = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])
let masterId = ''
const childrenOf = (): SessionMeta[] => store.listSessions().filter((s) => !s.parentId && s.masterId === masterId)
let peakChildren = 0
const lines = new Map<string, Set<string>>()
const startedAt = new Map<string, number>()
registry.onMeta((m) => {
  if (!masterId) return
  peakChildren = Math.max(peakChildren, childrenOf().filter((s) => LIVE.has(s.status)).length)
  for (const c of childrenOf()) {
    const line = registry.get(c.id)?.activity
    if (c.status === 'queued' && line) (lines.get(c.id) ?? lines.set(c.id, new Set()).get(c.id)!).add(line)
  }
  if (m.status === 'starting' && !startedAt.has(m.id)) startedAt.set(m.id, Date.now())
})

// ── the project and the master ──────────────────────────────────────────
const ws = await registry.createWorkspace(repo, 'batch-ws')
const project = await registry.createProject(ws.id, 'Batch', 'local')
// The plan child completes its plan and reports; no build starts on its own.
registry.setPlanSettings(project.id, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false })
const MODEL = 'claude-haiku-5-5'
// A chat as a person starts one (the default agentType): the pin alone makes it an orchestrator under the policy.
const master = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'Batch proof' })
masterId = master.id
registry.setMaster(master.id, true)
check('the master is pinned on its own row', store.getSession(master.id)?.isMaster === true && registry.isMaster(master.id))
// A second master in the same project is its own batch, keyed by its id.
const second = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'Second master' })
registry.setMaster(second.id, true)
check('two masters in one project, each pinned', registry.isMaster(second.id) && registry.isMaster(master.id))
check("the second master's batch is empty while the first's fills", batches.get(second.id).pending.length === 0)

const NO = 'This is a test; ask no questions and spawn nothing.'
const briefA = `${NO} The directory ${wtA} is a worktree of this repo on branch child-a. There (use \`git -C ${wtA}\` for every git command) create the file a.txt containing exactly "a", run \`git -C ${wtA} add a.txt\` and \`git -C ${wtA} commit -m "child a: add a.txt"\`, then call the merge_branch tool ONCE with branch "child-a" and report its whole answer in one short sentence. Do not run typecheck, tests, git merge or git push yourself. If the tool answers HELD, stop and wait.`
const briefR = `This is a test; spawn nothing and write no files. Call the AskUserQuestion tool ONCE with one question "Which colour names the report?" and the options "Blue" and "Red". Then reply with exactly: research done: <the chosen colour>. Use no other tools.`
const briefP = `This is a test; ask no questions and spawn nothing. Write the plan document to your plan file NOW with exactly these sections: "# Greeting file", "## Overview" (one line), "## Approach" (one line), "## Tasks" with one checklist item "- [ ] Create greeting.txt in the project root containing hello", and "## Risks" (one line). Then call the plan_complete tool once, say the plan is ready in one sentence, and stop.`
const briefB = `This is a test. Reply with exactly: b done. Use no tools and nothing else.`
const masterBrief = `This is a test of your batch tools; the user has asked for all of it. Do exactly this, in order, with no other tools:
0. Call batch_rules ONCE with summary "Proof batch: land as they finish, gate, release, smoke, then tell me" and steps exactly: [{"id":"land","name":"Land","kind":"land"},{"id":"gate","name":"Gate","kind":"gate"},{"id":"release","name":"Release","kind":"release"},{"id":"smoke","name":"Smoke test","kind":"shell","run":"echo smoke ok; test -f ${repo}/a.txt"}] and no other field.
1. Call app_start_thread with threadType "implementation", provider "claude", model "${MODEL}", reasoning "low", title "child a", firstMessage exactly: <<<${briefA}>>>
2. Call app_start_thread with threadType "research", provider "claude", model "${MODEL}", reasoning "low", title "child r", firstMessage exactly: <<<${briefR}>>>
3. Call app_start_thread with threadType "planning", provider "claude", model "${MODEL}", reasoning "low", title "child p", firstMessage exactly: <<<${briefP}>>>
4. Call app_start_thread with threadType "implementation", provider "claude", model "${MODEL}", reasoning "low", title "child b", after set to the threadId step 1 returned, firstMessage exactly: <<<${briefB}>>>
5. Call list_agents once.
Pass each firstMessage verbatim, without the <<< >>> markers. Then reply in one sentence and stop. Never call wait_for_agent, check_agent, send_to_agent, interrupt_agent or spawn_agent unless a later message asks for it.
Later messages will be automatic <subagent-report> notifications. On each one: if it says a thread is WAITING on a question, call answer_agent ONCE with that agentId, that requestId and answers [["Blue"]]; otherwise call no tool. Then reply in one short sentence and stop.`

// ── 1. the master starts its batch ──────────────────────────────────────
console.log('\n[1] the master starts four children')
await turn(master.id, masterBrief)
const kids = childrenOf().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
const byTitle = (t: string): SessionMeta | undefined => kids.find((k) => k.title.toLowerCase().includes(t))
const a = byTitle('child a')
const r = byTitle('child r')
const p = byTitle('child p')
const b = byTitle('child b')
check('four children carry the master id', kids.length === 4 && !!a && !!r && !!p && !!b, kids.map((k) => `${k.title}:${k.threadType}`).join(', '))
if (!a || !r || !p || !b) {
  console.log(`\n${failures} FAILURES (the master did not start its batch)`)
  log(finalText(master.id).slice(-300))
  await registry.disposeAll()
  process.exit(1)
}
check('three types', a.threadType === 'implementation' && r.threadType === 'research' && p.threadType === 'planning' && b.threadType === 'implementation')
check('the master set the batch rules with batch_rules, a shell step among them', batches.get(master.id).rules.summary === 'Proof batch: land as they finish, gate, release, smoke, then tell me' && batches.get(master.id).rules.land === 'as-they-finish' && batches.get(master.id).rules.steps.map((s) => `${s.id}:${s.kind}`).join(',') === 'land:land,gate:gate,release:release,smoke:shell', JSON.stringify(batches.get(master.id).rules))
check('the master is watching, not idle, while its batch is open', ['watching', 'running', 'starting'].includes(store.getSession(master.id)?.status ?? ''), store.getSession(master.id)?.status)
check('child b waits after child a', store.getSession(b.id)?.after === a.id, `after=${store.getSession(b.id)?.after}`)
// The batch follows the starter: a thread a batch child starts (a plan's own build) carries the master's id and the child as its starter.
const fromChild = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'started by child a', startedBy: a.id })
check('a thread started by a batch child inherits the masterId and keeps the child as startedBy', fromChild.masterId === master.id && fromChild.startedBy === a.id, `masterId=${fromChild.masterId} startedBy=${fromChild.startedBy}`)
await registry.setArchived(fromChild.id, true)
// adopt: a loose thread joins the batch, a subagent and the second master are refused.
const loose = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'loose' })
const adopted = batches.adopt(master.id, [loose.id, second.id])
check('batch.adopt takes a loose root and refuses a master', adopted.adopted.length === 1 && adopted.adopted[0] === loose.id && adopted.refused.length === 1 && adopted.refused[0].why === 'it is a master thread', JSON.stringify(adopted.refused))
check('the adopted thread carries the master id and the master as its starter', store.getSession(loose.id)?.masterId === master.id && store.getSession(loose.id)?.startedBy === master.id)
// Out again before the end: an idle thread with no turn behind it is not done and would hold the batch open.
await registry.setArchived(loose.id, true)
check('the children run in the project checkout', kids.every((k) => k.cwd === repo))
const listed = toolResults(master.id).find((t) => t.includes('"kind":"thread"'))
const listedRows = listed ? (JSON.parse(listed) as { kind: string; agentId: string; threadType?: string; host?: string; status: string }[]) : []
check('list_agents marks the batch rows thread, with type, host and status', listedRows.filter((x) => x.kind === 'thread').length === 4 && listedRows.every((x) => x.kind !== 'thread' || (x.threadType && x.host === 'e2e-host' && x.status)), listed?.slice(0, 200))
check('no cap: children a, r and p were never queued', ![a, r, p].some((k) => [...(lines.get(k.id) ?? [])].some((l) => l.startsWith('Queued'))), [a, r, p].map((k) => `${k.title}: ${[...(lines.get(k.id) ?? [])].join(' | ')}`).join('; '))
check('child b was queued waiting for child a', [...(lines.get(b.id) ?? [])].some((l) => l === `Queued · waiting for ${a.title}`), [...(lines.get(b.id) ?? [])].join(' | '))

// ── 2. the children run, settle and report ──────────────────────────────
console.log('\n[2] settles wake the master; the question is answered through answer_agent')
// Child a: typecheck red, HELD; its settle wakes the master.
await rowsUntil(a.id, (rs) => rs.some((x) => x.event.type === 'notice' && x.event.kind === 'gate'))
await settledAfter(a.id, 0)
check('a.txt NOT on origin/master after the red typecheck', !originHas('a.txt'))
const gatesA1 = notices(a.id, 'gate')
check('a red typecheck row on child a with the log tail', gatesA1.length === 1 && gatesA1[0].gate?.ok === false && gatesA1[0].gate?.log.includes('TS2322') && gatesA1[0].message === 'Typecheck failed on child-a · 1 error', JSON.stringify(gatesA1.map((n) => [n.message, n.gate?.log])))
check('the tool answered HELD', toolResults(a.id).some((t) => /^HELD: typecheck failed on child-a/.test(t)), toolResults(a.id).at(-1)?.slice(0, 120))
// Child r: waits on its question, the report names it, the master answers.
await rowsUntil(r.id, (rs) => rs.some((x) => x.event.type === 'question-resolved'), 300_000)
const asked = firstRow(r.id, (e) => e.type === 'question-request')
const answered = firstRow(r.id, (e) => e.type === 'question-resolved')
check('child r asked its question and it was answered', !!asked && !!answered && answered.event.type === 'question-resolved' && JSON.stringify(answered.event.answers) === '[["Blue"]]', JSON.stringify(answered?.event))
await settledAfter(r.id, answered!.seq)
check('child r carried the answer into its reply', /research done:\s*blue/i.test(finalText(r.id)), finalText(r.id).slice(-80))
const masterAnswer = toolCalls(master.id, 'answer_agent')
check('the master answered through answer_agent', masterAnswer.length >= 1 && JSON.stringify(masterAnswer[0].input).includes(r.id), JSON.stringify(masterAnswer[0]?.input))
const reported = (id: string) => (rs: EventRow[]) => rs.some((x) => x.event.type === 'agent-report' && x.event.agentId === id)
await rowsUntil(master.id, reported(r.id), 60_000)
await rowsUntil(master.id, reported(a.id), 120_000)
check('the settles reached the master as <subagent-report>s, the waiting one marked waiting', reports(master.id).some((x) => x.agentId === r.id && x.status === 'waiting') && reports(master.id).some((x) => x.agentId === a.id), reports(master.id).map((x) => `${x.agentId}:${x.status}`).join(', '))
// Child p: completes its plan; one report, no build.
await rowsUntil(p.id, () => !!store.getSession(p.id)?.planCompletedAt, 300_000)
await settledAfter(p.id, 0)
await rowsUntil(master.id, (rs) => rs.some((x) => x.event.type === 'agent-report' && x.event.agentId === p.id), 120_000)
await sleep(2_000)
check('the plan child completed its plan and no build started', !!store.getSession(p.id)?.planCompletedAt && !store.getSession(p.id)?.implementationId)
check('the plan child reported once to the master', reports(master.id).filter((x) => x.agentId === p.id).length === 1, String(reports(master.id).filter((x) => x.agentId === p.id).length))
// Child b: after a, started only once a was idle after its turn.
await rowsUntil(b.id, (rs) => rs.some((x) => isSettle(x.event)), 300_000)
const aIdle = firstRow(a.id, (e) => e.type === 'turn-complete')
const bStart = firstRow(b.id, (e) => e.type === 'status' && e.status === 'starting')
check('child b started only once child a was idle after a turn', !!aIdle && !!bStart && bStart.ts >= aIdle.ts, `a idle ${aIdle?.ts} b start ${bStart?.ts}`)
check('child b answered', /b done/i.test(finalText(b.id)), finalText(b.id).slice(-60))
check('three children were live at once (no cap held them)', peakChildren >= 3, `peak ${peakChildren}`)
check('no child left queued', childrenOf().every((k) => k.status !== 'queued'), childrenOf().map((k) => `${k.title}:${k.status}`).join(', '))

// ── 3. child a lands ─────────────────────────────────────────────────────
console.log('\n[3] child a again, typecheck green: merged')
stub(false)
// Every report has reached the master and its wake turns are over before the next steer.
for (const k of [a, r, p, b]) await reportSettled(master.id, k.id)
const masterSeq = lastSeq(master.id)
await turn(a.id, 'The typecheck is fixed now. Call the merge_branch tool ONCE more with branch "child-a" and report its answer in one sentence.')
// The merge lands inside that turn, but child a's notes-reminder turn from
// the HELD can settle first: wait for the merge row itself, then the settle after it.
await rowsUntil(a.id, (rs) => rs.some((x) => x.event.type === 'notice' && x.event.kind === 'review'), 300_000)
await settledAfter(a.id, firstRow(a.id, (e) => e.type === 'notice' && e.kind === 'review')!.seq)
// Child a's settle wakes the master once more; let that turn end before the next steer.
await reportSettled(master.id, a.id, masterSeq)
check('a.txt on origin/master', originHas('a.txt'))
check('a green typecheck row followed the red one', notices(a.id, 'gate').map((n) => n.gate?.ok).join(',') === 'false,true')
check('merge row on child a', notices(a.id, 'review').some((n) => n.review?.merged), JSON.stringify(notices(a.id, 'review').map((n) => n.message)))
let state = batches.get(master.id)
check('batch.get: 1 of 4 landed (the engine may already have ended the cycle)', /^(running: 1 of 4 landed|passed: 1 of 4 landed · 3 left out)$/.test(steps(state).land) && state.landed[0] === a.id && state.pending.length === 3, JSON.stringify(steps(state)))

// ── 4. threads follow no model policy; subagents do ─────────────────────
console.log('\n[4] Fable: a thread from any thread, a subagent only from the master')
const other = await registry.create({ provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', parentId: null, title: 'Not the master' })
await turn(other.id, `This is a test. First call app_start_thread with threadType "chat", provider "claude", model "claude-fable-5-1", reasoning "low", title "fable thread", firstMessage "This is a test. Reply with exactly: fable thread ok. Use no tools and nothing else.". Then call spawn_agent with model "claude-fable-5-1" and task "hi". Report both answers verbatim in one short message, then stop. Do nothing else.`)
const fableThread = store.listSessions().find((s) => s.model === 'claude-fable-5-1' && !s.parentId)
check('app_start_thread started a Fable thread from a plain chat thread (no policy for threads)', !!fableThread && fableThread.threadType === 'chat' && toolResults(other.id).some((t) => t.includes(fableThread!.id)), toolResults(other.id).map((t) => t.slice(0, 90)).join(' || '))
const spawnRefusal = toolResults(other.id).find((t) => /approved for orchestrators only/.test(t)) ?? ''
check('spawn_agent still refused Fable as a subagent of that chat, pointing at app_start_thread', /this thread \(role: thread\) may not spawn it as a subagent/.test(spawnRefusal) && /app_start_thread/.test(spawnRefusal), spawnRefusal.slice(0, 160))
check('no Fable subagent of that chat was created', registry.childrenOf(other.id).every((s) => s.model !== 'claude-fable-5-1'))
if (fableThread) {
  await settledAfter(fableThread.id, 0, 300_000)
  check('the Fable thread ran and answered', /fable thread ok/i.test(finalText(fableThread.id)), finalText(fableThread.id).slice(-60))
  await registry.setArchived(fableThread.id, true)
}
await turn(master.id, `This is a test. Call spawn_agent ONCE with model "claude-fable-5-1", reasoning "low", useWorktree false and task "Reply with exactly: fable ok. Use no tools." Report its answer verbatim in one short message and stop. Do not wait for it.`)
const fableSpawn = toolResults(master.id).filter((t) => /fable/.test(t)).at(-1) ?? ''
check('spawn_agent on the master accepted Fable', /agentId/.test(fableSpawn) && !/refused/.test(fableSpawn), fableSpawn.slice(0, 120))
const fableChild = registry.childrenOf(master.id).find((s) => s.model === 'claude-fable-5-1')
check('the Fable subagent is a subagent of the master, not a batch thread', !!fableChild && fableChild.parentId === master.id && !fableChild.masterId)

// ── 5. the engine ends the batch on its own, then batch_gate re-runs the gate ──
console.log('\n[5] the batch ends by its rules; batch_gate on the master')
if (fableChild) await reportSettled(master.id, fableChild.id, 0, 300_000)
// Every child is done (a landed, r, p and b idle after a turn): the engine
// ran the rules (gate, release, nothing to publish or deploy) and told the
// master. An earlier cycle ended with nothing landed (a idled on its HELD;
// an idle child is done), so the row to read is the one after a's landing.
await rowsUntil(master.id, (rs) => rs.some((x) => x.event.type === 'notice' && x.event.kind === 'batch' && /^Batch done: 1 of 4 landed/.test(x.event.message)), 300_000)
const doneRow = notices(master.id, 'batch').filter((n) => /^Batch done:/.test(n.message)).at(-1)
check('the engine finished the batch by its rules and rowed the master, the shell step last', !!doneRow && /1 of 4 landed · 3 left out · gate passed in .* · release-1 tagged in \d+s · Smoke test passed in \d+s/.test(doneRow.message), doneRow?.message)
check('the shell step ran in the project checkout with its lines in the log', batches.get(master.id).steps.find((s) => s.id === 'smoke')?.log.includes('smoke ok') === true, JSON.stringify(batches.get(master.id).steps.find((s) => s.id === 'smoke')?.log))
check('the batch-done report reached the master as a <batch-report>', reports(master.id).some((x) => x.agentId === master.id && x.status === 'done'), reports(master.id).map((x) => `${x.agentId}:${x.status}`).join(', '))
await reportSettled(master.id, master.id, 0, 120_000)
await sleep(500)
check('the master idles once the batch is done', store.getSession(master.id)?.status === 'idle', store.getSession(master.id)?.status)
await turn(master.id, 'This is a test. Call the batch_gate tool ONCE with no arguments and report its whole answer verbatim in one sentence. Do nothing else.')
const answer = toolResults(master.id).find((t) => /^passed in/.test(t))
check('batch_gate answered passed and the tag', !!answer && answer.includes('release-1 tagged'), toolResults(master.id).at(-1)?.slice(0, 160))
state = batches.get(master.id)
check('land done with the unlanded children left out', steps(state).land === 'passed: 1 of 4 landed · 3 left out', steps(state).land)
check('gate and release done with the release detail', steps(state).gate.startsWith('passed: passed in') && steps(state).release === 'passed: release-1 tagged', JSON.stringify(steps(state)))
const masterGates = notices(master.id, 'gate').map((n) => [n.gate?.step, n.gate?.ok])
check('gate and release rows on the master: the engine\'s pair, then batch_gate\'s', JSON.stringify(masterGates) === JSON.stringify([['gate', true], ['release', true], ['gate', true], ['release', true]]), JSON.stringify(masterGates))

// ── 6. archive the batch: the done children leave, the master stays ──────
console.log('\n[6] batch.archive done')
const archived = await batches.archive(master.id, 'done', false)
check('batch.archive done archives every done child and leaves the master', [a, r, p, b].every((k) => archived.succeeded.includes(k.id) && store.getSession(k.id)?.archived === true) && store.getSession(master.id)?.archived === false, JSON.stringify(archived))
check('the second master is untouched', store.getSession(second.id)?.archived === false && !registry.list({ archived: false }).some((s) => s.masterId === second.id))

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
log(`scratch: ${root}`)
process.exit(failures === 0 ? 0 : 1)
