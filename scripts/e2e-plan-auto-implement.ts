/**
 * Plan auto-implement, end to end (planFlow.ts). An isolated server with
 * its own database and a scratch workspace; every thread is
 * claude-haiku-5-5. Proves:
 *   1. A planning thread that writes its plan and calls plan_complete
 *      starts the implementation thread itself when it settles — same
 *      model, effort and window, the plan file as planPath, titled from the
 *      plan's heading, the plan thread seeded (its digest under
 *      .temp-code/refs), both threads linked, a plan-handoff row on the
 *      plan, the plan archived — and the build does the plan's task.
 *   2. A planning thread another thread started (app_start_thread) wakes
 *      that thread with a <subagent-report> saying the plan is done.
 *   3. With plans.autoImplement off, the plan completes, nothing starts,
 *      and the plan view's Start (plan.implement) begins the build with the
 *      fixed plans.implementReasoning.
 * Run: bun run script:e2e-plan-auto-implement
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { appToolsMcp, setAppToolsRegistry } from '../src/main/server/apptools'
import { DEFAULT_PLAN_SETTINGS } from '../src/shared/plans'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

// The registry alone (as e2e-thread-refs does): no window, no Electron, no
// listener — the plan flow lives in the registry and the app tools.
const dataDir = mkdtempSync(join(tmpdir(), 'tc-plans-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

function waitFor(sessionId: string, pred: (e: AgentEvent) => boolean, timeoutMs = 300_000): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, 0).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${sessionId}`))
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
/** The turn is over: turn-complete, or the thread stopped on a prompt or a failure. A
 *  goal line arrives as an error-typed row on some harnesses, so 'error' alone is no settle. */
const isSettle = (e: AgentEvent): boolean =>
  e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
const settled = (id: string): Promise<AgentEvent> => waitFor(id, isSettle)
/** A settle AFTER a given row (a report that woke the thread): what the wake turn made of it. */
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
async function until<T>(name: string, read: () => T | null | undefined, timeoutMs = 60_000): Promise<T | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = read()
    if (v) return v
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`      (gave up waiting for ${name})`)
  return null
}
const finalText = (id: string): string =>
  registry
    .eventsAfter(id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')

interface ToolReg {
  handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>
}
const toolsOf = (meta: SessionMeta): Record<string, ToolReg> =>
  (appToolsMcp(meta).instance as unknown as { _registeredTools: Record<string, ToolReg> })._registeredTools

const ws = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-plans-ws-')), 'plans-ws')
const project = await registry.createProject(ws.id, 'Greeting', 'local')
const MODEL = 'claude-haiku-5-5'

const planBrief = (file: string, word: string): string =>
  `This is a test of the plan flow; ask no questions and spawn nothing. Write the plan document to your plan file NOW with exactly these sections: "# Greeting file ${word}", "## Overview" (one line), "## Approach" (one line), "## Tasks" with a single checklist item "- [ ] Create the file ${file} in the project root containing exactly the text: hello from ${word}", and "## Risks" (one line). Then call the plan_complete tool once, say the plan is ready in one sentence, and stop.`

// ── 1. auto-start ───────────────────────────────────────────────────────
console.log('\n[1] auto-start on plan_complete')
const plan = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'planning',
  parentId: null,
  context1m: true
})
await registry.send(plan.id, planBrief('hello-auto.txt', 'auto'))
await settled(plan.id)
const planNow = registry.get(plan.id)!
check('planner called plan_complete (planCompletedAt stamped)', !!planNow.planCompletedAt, finalText(plan.id).slice(-120))
check('plan file written', !!planNow.planPath && existsSync(planNow.planPath) && readFileSync(planNow.planPath, 'utf8').includes('## Tasks'))
const linkedPlan = await until('implementationId on the plan', () => {
  const m = registry.get(plan.id)
  return m?.implementationId ? m : null
})
const build = linkedPlan?.implementationId ? registry.get(linkedPlan.implementationId) : null
check('implementation thread started on settle', !!build, build?.id)
if (build) {
  check('same model, effort and window as the plan', build.provider === 'claude' && build.model === MODEL && build.reasoning === 'low' && build.context1m === true, `${build.model} ${build.reasoning} 1m=${build.context1m}`)
  check('same project and cwd', build.projectId === project.id && build.cwd === plan.cwd)
  check('planPath set and the back link to the plan', build.planPath === plan.planPath && build.planThreadId === plan.id)
  check('titled from the plan heading', /^Greeting file auto/.test(build.title), build.title)
  check('permission inherited', build.permission === 'auto')
  const rows = registry.eventsAfter(plan.id, 0).map((r) => r.event)
  const handoff = rows.find((e) => e.type === 'plan-handoff') as { sessionId: string; how: string } | undefined
  check('plan-handoff row on the plan thread, how=auto', handoff?.sessionId === build.id && handoff?.how === 'auto')
  const archived = await until('plan archived', () => (registry.get(plan.id)?.archived ? true : null), 10_000)
  check('plan thread archived (plans.archiveAfterStart)', archived === true)
  const refs = join(project.cwd, '.temp-code', 'refs', `${plan.id}.md`)
  check('plan thread seeded into the build (digest under refs/)', existsSync(refs), refs)
  await settled(build.id)
  const made = join(project.cwd, 'hello-auto.txt')
  check('the build did the plan\'s task', existsSync(made) && readFileSync(made, 'utf8').includes('hello from auto'), finalText(build.id).slice(-120))
}

// ── 2. the spawner hears ────────────────────────────────────────────────
console.log('\n[2] a thread that started the plan is told')
const starter = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'chat',
  parentId: null
})
await registry.send(starter.id, 'Reply with exactly: standing by. Nothing else.')
await settled(starter.id)
const startRes = await toolsOf(registry.get(starter.id)!)['app_start_thread'].handler(
  {
    threadType: 'planning',
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    firstMessage: planBrief('hello-child.txt', 'child')
  },
  {}
)
const started = JSON.parse(startRes.content[0].text) as { threadId: string }
check('app_start_thread records the starter', registry.get(started.threadId)?.startedBy === starter.id)
await settled(started.threadId)
const report = await waitFor(starter.id, (e) => e.type === 'agent-report' && (e as { agentId: string }).agentId === started.threadId, 90_000).catch(() => null)
check('starter received the plan-done report row', !!report, JSON.stringify(report))
const childBuild = await until('child plan implementationId', () => registry.get(started.threadId)?.implementationId ?? null)
check('the child plan auto-started its build too', !!childBuild)
const reportRow = registry.eventsAfter(starter.id, 0).find((r) => r.event.type === 'agent-report')
const wake = reportRow ? await settledAfter(starter.id, reportRow.seq, 120_000).catch(() => null) : null
const wakeText = reportRow
  ? registry
      .eventsAfter(starter.id, reportRow.seq)
      .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
      .map((r) => (r.event as { text: string }).text)
      .join(' ')
  : ''
check('starter woke on the report and named the build', !!wake && !!childBuild && wakeText.includes(childBuild), wakeText.slice(-160))
if (childBuild) await settled(childBuild).catch(() => {})

// ── 3. auto-start off, then Start by hand ───────────────────────────────
console.log('\n[3] auto-start off: the plan waits; plan.implement starts it')
registry.setPlanSettings(project.id, { ...DEFAULT_PLAN_SETTINGS, autoImplement: false, implementReasoning: 'medium' })
const manual = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'planning',
  parentId: null
})
await registry.send(manual.id, planBrief('hello-manual.txt', 'manual'))
await settled(manual.id)
await new Promise((r) => setTimeout(r, 1500))
const manualNow = registry.get(manual.id)!
check('plan complete, no build started', !!manualNow.planCompletedAt && !manualNow.implementationId)
check('plan thread kept (not archived)', !manualNow.archived)
const byHand = await registry.implementPlan(manual.id)
check('plan.implement starts the build with the fixed effort', byHand.model === MODEL && byHand.reasoning === 'medium' && byHand.planThreadId === manual.id, `${byHand.model} ${byHand.reasoning}`)
check('plan links to it and is archived', registry.get(manual.id)?.implementationId === byHand.id && (await until('archived', () => (registry.get(manual.id)?.archived ? true : null), 10_000)) === true)
const rows3 = registry.eventsAfter(manual.id, 0).map((r) => r.event)
check('handoff row says manual', (rows3.find((e) => e.type === 'plan-handoff') as { how?: string } | undefined)?.how === 'manual')
await settled(byHand.id).catch(() => {})

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
