/**
 * The project plan, end to end (docs/PROJECT-PLAN.md): an isolated
 * in-process server (own temp database, own workspace with a tiny project),
 * a real claude-haiku-5-5 project-plan thread that surveys the project and
 * writes <cwd>/.temp-code/plans/project.md with the five fixed sections and
 * calls plan_complete; then the options the finished plan offers, driven
 * the way the renderer drives them:
 *  - plan_complete marks the file `status: complete`; the plan thread starts
 *    no thread of its own (never auto-started into a build)
 *  - "Plan the next milestone" starts a haiku planning thread for the first
 *    undone milestone, linked to it, whose plan names that milestone
 *  - a build started from that plan inherits the link, and landing it ticks
 *    the milestone in the project plan; "Keep as the project's plan" pins it
 * Run: bun run script:e2e-project-plan
 * Nothing here touches /Applications/TempCode.app or the box's live service.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'
import { appToolsMcp } from '../src/main/server/apptools'
import { ProjectPlans } from '../src/main/server/projectPlan'
import type { AgentEvent, EventRow } from '../src/shared/events'
import {
  milestonePlanningBrief,
  milestoneThreadTitle,
  nextMilestone,
  parseProjectPlan,
  projectPlanPathFor
} from '../src/shared/projectPlan'

const MODEL = process.env.TC_E2E_MODEL ?? 'claude-haiku-5-5'
const root = mkdtempSync(join(tmpdir(), 'tc-pp-'))
// A throwaway vault: no accounts, so the gateway passes the CLI's own
// login through to the provider, and never the user's live shim.
configure({
  dataDir: join(root, 'aliax'),
  fetch: (url, init) => fetch(url, init),
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false })
const registry = server.registry

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

function waitFor(sessionId: string, pred: (e: AgentEvent) => boolean, timeoutMs = 600_000): Promise<AgentEvent> {
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
/** Every thread here runs with full access; anything the harness still
 *  asks about (a tool outside its policy) is allowed, so no turn parks. */
const autoApprove = (id: string): (() => void) =>
  registry.subscribe(id, (row: EventRow) => {
    if (row.event.type === 'approval-request') void registry.approve(id, row.event.requestId, true)
  })
const toolCalls = (id: string): string[] =>
  registry
    .eventsAfter(id, 0)
    .filter((r) => r.event.type === 'tool-call')
    .map((r) => (r.event as { name: string }).name)

// ── a tiny project to survey ─────────────────────────────────────────
const wsPath = mkdtempSync(join(tmpdir(), 'tc-pp-ws-'))
mkdirSync(join(wsPath, 'src'))
writeFileSync(
  join(wsPath, 'README.md'),
  '# tally\n\nA tiny CLI that counts words in files. Today it reads one file and prints a total. Wanted next: several files, a JSON output flag, and tests.\n'
)
writeFileSync(
  join(wsPath, 'src', 'tally.js'),
  "const fs = require('fs')\nconst text = fs.readFileSync(process.argv[2], 'utf8')\nconsole.log(text.split(/\\s+/).filter(Boolean).length)\n"
)
writeFileSync(join(wsPath, 'package.json'), JSON.stringify({ name: 'tally', version: '0.0.1', bin: 'src/tally.js' }, null, 2))
const ws = await registry.createWorkspace(wsPath, 'tally')
const project = await registry.createProject(ws.id, 'tally', 'local')
const planPath = projectPlanPathFor(project.cwd)
const plans = new ProjectPlans(server.store, {
  getProject: (id) => registry.getProject(id),
  sessionsOfProject: (id) => server.store.sessionsOfProject(id),
  getSession: (id) => registry.get(id)
})

// ── the project-plan thread ──────────────────────────────────────────
const pp = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'project-plan',
  parentId: null
})
autoApprove(pp.id)
check('a project-plan thread owns the project file', pp.planPath === planPath, pp.planPath ?? 'null')
check('its title is the type placeholder', pp.title === 'Project plan', pp.title)
const tools = (appToolsMcp(pp).instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools
check('plan_complete is among its app tools', 'plan_complete' in tools, Object.keys(tools).join(','))

await registry.send(
  pp.id,
  'Plan this project. Decide everything yourself — do not ask me anything and do not spawn subagents (the project is three files). Write exactly three milestones. When the document is written, call plan_complete and stop.'
)
await settled(pp.id)
let calls = toolCalls(pp.id)
if (!calls.some((n) => n.includes('plan_complete')) && existsSync(planPath)) {
  log('the model wrote the plan without calling plan_complete; one nudge')
  await registry.send(pp.id, 'Call plan_complete now, then stop.')
  await settled(pp.id)
  calls = toolCalls(pp.id)
}
check('the plan thread called plan_complete', calls.some((n) => n.includes('plan_complete')), calls.join(','))
check('the plan file exists at <cwd>/.temp-code/plans/project.md', existsSync(planPath))
const doc = existsSync(planPath) ? readFileSync(planPath, 'utf8') : ''
const plan = parseProjectPlan(doc)
check('every fixed section is there', plan.missing.length === 0, `missing ${plan.missing.join(', ')}`)
check('the milestones parse with scope, dependencies and done-when', plan.milestones.length >= 1 && plan.milestones.every((m) => m.doneWhen), JSON.stringify(plan.milestones.map((m) => [m.index, m.title, m.doneWhen])))
check('plan_complete marked the file complete', plan.status === 'complete', doc.slice(0, 80))
check('no milestone is ticked by the plan thread', plan.milestones.every((m) => !m.done))
log(`milestones: ${plan.milestones.map((m) => `${m.index}. ${m.title}`).join(' | ')}`)

const roots = () => registry.list({ archived: undefined }).filter((s) => !s.parentId)
check(
  'the finished plan started no thread of its own (never auto-started into a build)',
  roots().every((s) => s.id === pp.id || s.projectId !== project.id),
  roots().map((s) => `${s.threadType}:${s.title}`).join(',')
)
const state = plans.state(project.id)
check('projectPlan.get names the thread and the file', state?.sessionId === pp.id && state.exists && state.complete && !state.pinned, JSON.stringify(state))

// ── "Plan the next milestone" ────────────────────────────────────────
const next = nextMilestone(doc)!
const planning = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'planning',
  parentId: null,
  title: milestoneThreadTitle(next)
})
autoApprove(planning.id)
plans.link(planning.id, { projectId: project.id, milestone: next.index })
await registry.send(
  planning.id,
  `${milestonePlanningBrief(planPath, next)}\n\nDecide everything yourself — do not ask me anything and do not spawn subagents. Write the plan with a ## Tasks checklist of three items and say it is ready.`
)
await settled(planning.id)
const planningDoc = planning.planPath && existsSync(planning.planPath) ? readFileSync(planning.planPath, 'utf8') : ''
check('the planning thread wrote its own plan file', planningDoc.length > 0, planning.planPath ?? 'null')
check('that plan is about the milestone', planningDoc.toLowerCase().includes(next.title.toLowerCase().split(' ')[0]), planningDoc.slice(0, 120))
check('the planning thread is linked to the milestone', JSON.stringify(plans.linkOf(planning.id)) === JSON.stringify({ projectId: project.id, milestone: next.index }))
check('the project plan is untouched by the milestone plan', readFileSync(planPath, 'utf8') === doc)

// ── the build from that plan: inherits the link; landing ticks ───────
const build = await registry.create({
  provider: 'claude',
  model: MODEL,
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  projectId: project.id,
  threadType: 'implementation',
  parentId: null,
  planPath: planning.planPath ?? undefined
})
check('the build inherits the milestone link from its plan', JSON.stringify(plans.linkOf(build.id)) === JSON.stringify({ projectId: project.id, milestone: next.index }))
check('the milestone plan is archived once its build starts', registry.get(planning.id)?.archived === true)
check('landing the build ticks the milestone', JSON.stringify(plans.landed(project.id)) === JSON.stringify([next.index]))
const ticked = parseProjectPlan(readFileSync(planPath, 'utf8'))
check('the file shows the tick, the rest unchanged', ticked.milestones.find((m) => m.index === next.index)?.done === true && ticked.milestones.filter((m) => m.done).length === 1)
check('landing again ticks nothing', plans.landed(project.id).length === 0)

// ── keep as the project's plan ───────────────────────────────────────
const pinned = plans.pin(project.id, true)
check('"Keep as the project\'s plan" pins it with the tick count', pinned?.pinned === true && pinned.milestones.filter((m) => m.done).length === 1, JSON.stringify(pinned))

await registry.disposeAll()
await server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
