/**
 * Stop, archive and delete on a master's batch threads, with real harnesses
 * (docs/master-threads.md "Stopping, archiving and deleting a batch
 * thread"). An isolated registry with its own database, every thread
 * claude-haiku-5-5. A chat pinned as master with session.setMaster, three
 * batch threads: one working (a long count), one queued `after` it, one
 * done. Proves:
 *   1. The master, in a real turn, stops the queued thread with
 *      interrupt_agent (it leaves the queue unstarted, archived) and
 *      archives the done one with archive_threads; asked to delete, it has
 *      no tool to and says it archived instead.
 *   2. The person's Stop (session.interrupt) stops the working thread, and
 *      Delete on a working thread stops it first and removes it.
 *   3. Remove from queue (the fleet's Stop on a queued root) archives a
 *      queued thread that never starts, even once its `after` is met.
 * Run: bun run script:e2e-batch-child-actions
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { Batches, setBatches } from '../src/main/server/batch'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

const MODEL = 'claude-haiku-5-5'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const root = mkdtempSync(join(tmpdir(), 'tc-batch-actions-'))
const store = new Store(openDb(join(root, 'app.db')))
const registry = new SessionRegistry(store)
registry.admission = { cap: () => 64, memoryLow: () => false }
setOrchestrationRegistry(registry)
setAppToolsRegistry(registry)
const batches = new Batches({ registry, store })
batches.attach()
setBatches(batches)

const rows = (id: string): EventRow[] => registry.eventsAfter(id, 0)
const events = (id: string): AgentEvent[] => rows(id).map((r) => r.event)
const status = (id: string): string | undefined => store.getSession(id)?.status
const userTurns = (id: string): number => events(id).filter((e) => e.type === 'user-text').length
const assistantText = (id: string): string =>
  events(id)
    .filter((e): e is Extract<AgentEvent, { type: 'assistant-text' }> => e.type === 'assistant-text' && !e.delta)
    .map((e) => e.text)
    .join(' ')
const toolCalls = (id: string, name: string) =>
  events(id).filter((e): e is Extract<AgentEvent, { type: 'tool-call' }> => e.type === 'tool-call' && !e.partial && e.name.endsWith(name))
const toolResults = (id: string): string[] =>
  events(id)
    .filter((e): e is Extract<AgentEvent, { type: 'tool-result' }> => e.type === 'tool-result')
    .map((e) => (typeof e.output === 'string' ? e.output : JSON.stringify(e.output)))

async function until(pred: () => boolean, what: string, timeoutMs = 180_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timeout: ${what}`)
    await sleep(250)
  }
}
const settled = (id: string): boolean => ['idle', 'watching', 'error', 'waiting'].includes(status(id) ?? '')

async function main(): Promise<void> {
  const ws = await registry.createWorkspace(root, 'ws')
  const project = await registry.createProject(ws.id, 'P', 'local')
  const thread = (over: Record<string, unknown>) =>
    registry.create({ cwd: root, provider: 'claude', model: MODEL, reasoning: 'low', permission: 'auto', projectId: project.id, threadType: 'chat', ...over })

  const master = await thread({ title: 'Master' })
  registry.setMaster(master.id, true)
  await registry.send(master.id, 'You are the master of a small batch. Reply with the single word READY.')
  await until(() => settled(master.id), 'the master settles')

  const done = await thread({ title: 'Done one', masterId: master.id, startedBy: master.id })
  await registry.send(done.id, 'Reply with the single word DONE.')
  await until(() => settled(done.id), 'the done thread settles')
  const working = await thread({ title: 'Working one', masterId: master.id, startedBy: master.id })
  await registry.send(working.id, 'Count from 1 to 400, one number per line, with no other text.')
  await until(() => status(working.id) === 'running', 'the working thread runs')
  const queued = await thread({ title: 'Queued one', masterId: master.id, startedBy: master.id, after: working.id })
  await registry.send(queued.id, 'Reply with the single word QUEUED.')
  await sleep(500)
  check('the queued thread waits on its sibling', status(queued.id) === 'queued', status(queued.id))

  // 1. The master's own tools, in a real turn.
  const before = rows(master.id).length
  await registry.send(
    master.id,
    `Do exactly this with your tools, nothing else: call interrupt_agent with agentId ${queued.id}; then call archive_threads with threadIds ["${done.id}"]; then try to delete thread ${working.id} if you have any way to. Then reply with one line per tool answer.`
  )
  await until(() => rows(master.id).length > before && settled(master.id), "the master's turn ends", 240_000)
  for (const r of rows(master.id).slice(before)) {
    const e = r.event
    if (e.type === 'tool-call' && !e.partial) console.log(`      call ${e.name.replace(/^mcp__\w+__/, '')} ${(JSON.stringify(e.input) ?? "").slice(0, 160)}`)
    if (e.type === 'tool-result') console.log(`      answer ${(typeof e.output === 'string' ? e.output : JSON.stringify(e.output)).slice(0, 160)}`)
  }
  check('the master called interrupt_agent', toolCalls(master.id, 'interrupt_agent').length > 0)
  check('the master called archive_threads', toolCalls(master.id, 'archive_threads').length > 0)
  const results = toolResults(master.id).join('\n')
  check('interrupt_agent took the queued thread out of the queue', /removed from the queue before it started/.test(results), results.slice(0, 200))
  check('the queued thread is archived and never ran', !!store.getSession(queued.id)?.archived && userTurns(queued.id) <= 1 && !assistantText(queued.id))
  check('archive_threads archived the done thread', !!store.getSession(done.id)?.archived && /Archived 1: "Done one"/.test(results))
  check('the working thread was never deleted by the master', !!store.getSession(working.id))
  console.log(`      master said: ${assistantText(master.id).slice(-300).replace(/\s+/g, ' ')}`)

  // 2. The person's Stop and Delete.
  if (status(working.id) !== 'running') {
    await registry.send(working.id, 'Count from 1 to 400 again, one number per line.')
    await until(() => status(working.id) === 'running', 'the working thread runs again')
  }
  await registry.stopRun(working.id)
  await until(() => settled(working.id), 'the working thread stops', 60_000)
  check("the person's Stop idles the working thread", status(working.id) === 'idle', status(working.id))
  await registry.send(working.id, 'Count from 1 to 400 again, one number per line.')
  await until(() => status(working.id) === 'running', 'the working thread runs for the delete')
  const queued2 = await thread({ title: 'Queued two', masterId: master.id, startedBy: master.id, after: working.id })
  await registry.send(queued2.id, 'Reply with the single word TWO.')
  await sleep(500)
  // 3. Remove from queue first: deleting its sibling would free it.
  const removal = await registry.batch('stop', [queued2.id])
  check('Remove from queue answers the id as done', removal.succeeded.includes(queued2.id), JSON.stringify(removal))
  await registry.delete(working.id)
  check('Delete on a working thread removes it', store.getSession(working.id) === null)
  await sleep(3_000)
  check('the removed-from-queue thread never started, even with its sibling gone', !!store.getSession(queued2.id)?.archived && !assistantText(queued2.id))
  check('the batch lists no thread', registry.batchChildren(master.id).length === 0)
}

main()
  .catch((err) => {
    console.log(`FAIL  the proof threw — ${err instanceof Error ? err.stack : String(err)}`)
    failures++
  })
  .finally(async () => {
    batches.dispose()
    await registry.close().catch(() => {})
    console.log(failures ? `${failures} FAILED` : 'ALL PASS')
    process.exit(failures ? 1 : 0)
  })
