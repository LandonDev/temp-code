/**
 * The thread queue, end to end (scheduler.ts). An isolated registry with
 * its own database and a scratch workspace, and six claude-haiku-5-5
 * threads created with `queue: true` and sent at once. Proves:
 *   1. There is no running cap: all six start at once and none sits queued.
 *   2. Every thread finishes with an answer, and each carries exactly one
 *      user row (the message its create stored, sent once).
 *   3. A thread created with `after` waits as `queued` with a "Queued ·
 *      waiting for <sibling>" line until its sibling's turn settles, then
 *      starts with its stored message and answers.
 * Run: bun run script:e2e-queue
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import type { AgentEvent, EventRow, SessionMeta } from '../src/shared/events'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-queue-'))
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const LIVE = new Set<SessionMeta['status']>(['starting', 'running', 'waiting'])
const liveRoots = (): number =>
  store.listSessions().filter((s) => !s.parentId && !s.archived && LIVE.has(s.status)).length
// The high-water mark, read at every meta change the registry pushes.
let peak = 0
const order: string[] = []
registry.onMeta((m) => {
  peak = Math.max(peak, liveRoots())
  if (m.status === 'starting' && !order.includes(m.id)) order.push(m.id)
})

function settled(sessionId: string, timeoutMs = 240_000): Promise<AgentEvent> {
  const isSettle = (e: AgentEvent): boolean =>
    e.type === 'turn-complete' || (e.type === 'status' && (e.status === 'waiting' || e.status === 'error'))
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, 0).find((r) => isSettle(r.event))
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
const finalText = (id: string): string =>
  registry
    .eventsAfter(id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')

const ws = await registry.createWorkspace(mkdtempSync(join(tmpdir(), 'tc-queue-ws-')), 'queue-ws')
const project = await registry.createProject(ws.id, 'Queue', 'local')
const MODEL = 'claude-haiku-5-5'

const spawn = async (n: number, extra: { after?: string } = {}): Promise<string> => {
  const s = await registry.create({
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'auto',
    projectId: project.id,
    threadType: 'chat',
    parentId: null,
    title: `Q${n}`,
    queue: true,
    ...extra
  })
  await registry.send(s.id, `This is a scheduling test. Reply with exactly: queue ${n} done. Use no tools and nothing else.`)
  return s.id
}

// ── 1. six at once, no cap ──────────────────────────────────────────────
console.log('\n[1] six threads, no cap')
const ids: string[] = []
for (let n = 1; n <= 6; n++) ids.push(await spawn(n))
await sleep(300)
const statuses = ids.map((id) => store.getSession(id)?.status)
check('all six started, none queued', statuses.filter((s) => LIVE.has(s!)).length === 6 && !statuses.includes('queued'), statuses.join(','))
check('no row carries a Queued line', ids.every((id) => !registry.get(id)?.activity?.startsWith('Queued')))

// ── 2. everything finishes ───────────────────────────────────────────────
console.log('\n[2] all six finish')
await Promise.all(ids.map((id) => settled(id)))
// The last settles may still be releasing the next starts; let the ticks land.
await sleep(1_500)
for (const id of ids) {
  const text = finalText(id)
  const n = ids.indexOf(id) + 1
  check(`Q${n} answered`, text.toLowerCase().includes(`queue ${n} done`), text.slice(-80))
}
check('all six were in a turn at once', peak === 6, `peak ${peak}`)
check('started in the order sent', order.join(',') === ids.join(','), order.map((id) => registry.get(id)?.title).join(','))
check('no thread left queued', ids.every((id) => store.getSession(id)?.status !== 'queued'))
const userRows = ids.map((id) => registry.eventsAfter(id, 0).filter((r) => r.event.type === 'user-text').length)
check('each thread has exactly one user row (the stored message, sent once)', userRows.every((n) => n === 1), userRows.join(','))

// ── 3. after ──────────────────────────────────────────────────────────────
console.log('\n[3] after: a thread waits for its sibling')
const lead = await spawn(7)
const follower = await spawn(8, { after: lead })
await sleep(300)
check('follower queued behind the lead', store.getSession(follower)?.status === 'queued' && registry.get(follower)?.activity === 'Queued · waiting for Q7', registry.get(follower)?.activity ?? '')
check('the follower holds its first message', registry.queueList(follower).length === 1 && registry.eventsAfter(follower, 0).some((r) => r.event.type === 'user-text'))
await settled(lead)
await sleep(1_500)
check('follower started once the lead settled', LIVE.has(store.getSession(follower)?.status!) || store.getSession(follower)?.status === 'idle', store.getSession(follower)?.status)
await settled(follower)
check('follower answered', finalText(follower).toLowerCase().includes('queue 8 done'), finalText(follower).slice(-80))

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
