/**
 * Away from computer, end to end (away.ts, awayPrompts.ts, sessions.ts
 * interceptAway). An in-process registry with its own database and a
 * scratch workspace; every thread is claude-haiku-5-5. Proves:
 *   1. With away on, a thread told to ask one AskUserQuestion before it
 *      writes a file never shows a question card: the host answers it, one
 *      away notice says so, the thread never waits, the turn finishes with
 *      the file written, and its final message holds "Decisions made while
 *      you were away".
 *   2. Turning away off mid-turn whispers `<away state="off">` into the
 *      running turn of a second thread.
 * Run: bun run script:e2e-away
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { AwayService } from '../src/main/server/away'
import type { AgentEvent, EventRow } from '../src/shared/events'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-away-'))
const store = new Store(openDb(join(dataDir, 'app.db')))
const registry = new SessionRegistry(store)
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
registry.hostName = () => 'e2e-host'
const away = new AwayService({
  getSetting: (k) => store.getSetting(k),
  setSetting: (k, v) => store.setSetting(k, v),
  environmentId: 'env_e2e'
})
registry.away = away
away.onChange((snapshot, changed) => {
  if (changed) registry.awayChanged(snapshot.state.enabled)
})

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
const isSettle = (e: AgentEvent): boolean =>
  e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
const rows = (id: string): AgentEvent[] => registry.eventsAfter(id, 0).map((r) => r.event)
const finalText = (id: string): string =>
  rows(id)
    .filter((e): e is Extract<AgentEvent, { type: 'assistant-text' }> => e.type === 'assistant-text' && !e.delta)
    .map((e) => e.text)
    .join('\n')

const wsPath = mkdtempSync(join(tmpdir(), 'tc-away-ws-'))
const ws = await registry.createWorkspace(wsPath, 'away-ws')
const project = await registry.createProject(ws.id, 'Away', 'local')
const MODEL = 'claude-haiku-5-5'
const thread = (title: string) =>
  registry.create({
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'auto',
    projectId: project.id,
    threadType: 'implementation',
    parentId: null,
    title
  })

// ── 1. a question while away ────────────────────────────────────────────
console.log('\n[1] a question while away never becomes a card')
away.set(true)
const asker = await thread('Away asker')
const statuses: string[] = []
const offMeta = registry.onMeta((m) => {
  if (m.id === asker.id) statuses.push(m.status)
})
await registry.send(
  asker.id,
  'This is a test of the app. First, use the AskUserQuestion tool exactly once to ask which greeting to write, with the two options "hello" and "hi". Then write the file greeting.txt in the project root containing only the chosen greeting. Then give your final report.'
)
await waitFor(asker.id, isSettle)
offMeta()
const askerRows = rows(asker.id)
const notices = askerRows.filter(
  (e): e is Extract<AgentEvent, { type: 'notice' }> => e.type === 'notice' && e.kind === 'away'
)
check('no question card was written', !askerRows.some((e) => e.type === 'question-request'))
check('one away notice for the question', notices.filter((n) => n.away?.kind === 'question').length === 1, notices.map((n) => n.message).join(' | '))
check('the thread never read waiting', !statuses.includes('waiting'), statuses.join(','))
check('the turn finished', askerRows.some((e) => e.type === 'turn-complete'))
const greeting = join(wsPath, 'greeting.txt')
check('the file was written', existsSync(greeting), existsSync(greeting) ? readFileSync(greeting, 'utf8').trim() : '')
const report = finalText(asker.id)
check('the final message has the decisions section', /Decisions made while you were away/i.test(report), report.slice(-300).replace(/\s+/g, ' '))
check('the tally counted the thread', away.get().decided.threads.some((t) => t.sessionId === asker.id && t.count >= 1), JSON.stringify(away.get().decided))

// ── 2. off mid-turn ─────────────────────────────────────────────────────
console.log('\n[2] turning away off whispers into a running turn')
const worker = await thread('Away worker')
await registry.send(worker.id, 'This is a test of the app. Run the shell command `sleep 25` with the Bash tool, then reply with one short sentence.')
await waitFor(worker.id, (e) => e.type === 'tool-call')
// What the harness is sent from here on: the handle's own send, recorded.
const handle = (registry as unknown as { handles: Map<string, { send: (text: string, ...rest: unknown[]) => Promise<void> }> }).handles.get(worker.id)!
const sent: string[] = []
const send = handle.send.bind(handle)
handle.send = (text, ...rest) => {
  sent.push(text)
  return send(text, ...rest)
}
away.set(false)
check('the running turn was told the person is back', sent.some((t) => t.startsWith('<away state="off">')), sent.join(' | ').slice(0, 200))
await waitFor(worker.id, isSettle)
check('the worker finished its turn', rows(worker.id).some((e) => e.type === 'turn-complete'))

await registry.disposeAll()
console.log(failures ? `\n${failures} FAILED` : '\nall passed')
process.exit(failures ? 1 : 0)
