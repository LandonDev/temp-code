/**
 * M6 exit test: a claude orchestrator spawns a codex subagent via the
 * orchestrator MCP tools, waits for it, and reports its answer. Checks
 * the child lands in the session tree (parentId + agent-spawned event).
 * Run: bun run script:e2e-orchestration
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import type { AgentEvent, EventRow } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-or-')), 'or.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)

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

const orch = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5',
  reasoning: 'low',
  agentType: 'orchestrator',
  permission: 'edits',
  cwd: mkdtempSync(join(tmpdir(), 'tc-or-cwd-')),
  title: 'orchestrator',
  parentId: null
})

registry.subscribe(orch.id, (row) => console.error('  [orch]', JSON.stringify(row.event).slice(0, 160)))

await registry.send(
  orch.id,
  'Spawn a codex subagent (provider "codex", useWorktree false) with the task: ' +
    '\'Reply with exactly: the magic number is 739\'. Wait for it, then tell me the magic number it reported.'
)

await waitFor(orch.id, (e) => e.type === 'agent-spawned')
const children = registry.list().filter((s) => s.parentId === orch.id)
check('child session created with parentId', children.length === 1)
check('child is codex', children[0]?.provider === 'codex')

await waitFor(orch.id, (e) => e.type === 'turn-complete' || e.type === 'error')
const finalText = registry
  .eventsAfter(orch.id, 0)
  .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
  .map((r) => (r.event as { text: string }).text)
  .join(' ')
check('orchestrator reported the subagent result', finalText.includes('739'), finalText.slice(-100))

const childRows = registry.eventsAfter(children[0].id, 0)
check(
  'child transcript holds its own turn',
  childRows.some((r) => r.event.type === 'assistant-text' && !r.event.delta && (r.event as { text: string }).text.includes('739'))
)
check('spawn tool call visible in orchestrator transcript', registry.eventsAfter(orch.id, 0).some((r) => r.event.type === 'tool-call' && r.event.name.includes('spawn_agent')))

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
