/**
 * The thread queue, end to end (scheduler.ts). An isolated registry with
 * its own database and a scratch workspace, and six claude-haiku-5-5
 * threads created with `queue: true` and sent at once. Proves:
 *   1. With no cap configured, all six start at once and none sits queued.
 *   2. Every thread finishes with an answer, and each carries exactly one
 *      user row (the message its create stored, sent once).
 *   3. A thread created with `after` waits as `queued` with a "Queued
 *      waiting for <sibling>" line until its sibling's turn settles, then
 *      starts with its stored message and answers.
 *   4. The running cap (admission.ts), pinned at two, over six plain threads
 *      sent at once: two run, four wait "Queued  2 of 2 running" with no
 *      harness booted; Start now runs the newest past the cap; each settle
 *      frees a slot (the idle harness is put down) and the oldest waiting
 *      thread takes it; the others never run more than two at once.
 * Run: bun run script:e2e-queue
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { Admission } from '../src/main/server/admission'
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
console.log('\n[1] six threads, no cap configured')
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
check('follower queued behind the lead', store.getSession(follower)?.status === 'queued' && registry.get(follower)?.activity === 'Queued  waiting for Q7', registry.get(follower)?.activity ?? '')
check('the follower holds its first message', registry.queueList(follower).length === 1 && registry.eventsAfter(follower, 0).some((r) => r.event.type === 'user-text'))
await settled(lead)
await sleep(1_500)
check('follower started once the lead settled', LIVE.has(store.getSession(follower)?.status!) || store.getSession(follower)?.status === 'idle', store.getSession(follower)?.status)
await settled(follower)
check('follower answered', finalText(follower).toLowerCase().includes('queue 8 done'), finalText(follower).slice(-80))

// ── 4. the running cap ────────────────────────────────────────────────────
console.log('\n[4] a cap of two over six threads')
// The threads above are idle with their harnesses up: put them down so the cap counts only this section.
registry.reclaimIdle(100, Date.now() + 60_000)
const admission = new Admission({
  getSetting: (key) => store.getSetting(key),
  setSetting: (key, value) => store.setSetting(key, value),
  pids: () => registry.harnessPids(),
  counts: () => registry.scheduler.counts(),
  onChange: () => registry.scheduler.schedule()
})
admission.set(2)
registry.admission = admission
// As the server does: the timers, and the first free-memory read before anything is admitted.
admission.start()
await admission.refreshFree()
check('admission.get reads the pinned cap', admission.state().cap === 2 && admission.state().pinned === 2, JSON.stringify(admission.state()))
const capped: string[] = []
let overrideId: string | null = null
let peakOthers = 0
const capOrder: string[] = []
registry.onMeta((m) => {
  if (!capped.includes(m.id)) return
  const live = registry.liveIds()
  peakOthers = Math.max(peakOthers, capped.filter((id) => id !== overrideId && live.has(id)).length)
  if (m.status === 'starting' && !capOrder.includes(m.id)) capOrder.push(m.id)
})
const plain = async (n: number): Promise<string> => {
  const s = await registry.create({
    provider: 'claude',
    model: MODEL,
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'auto',
    projectId: project.id,
    threadType: 'chat',
    parentId: null,
    title: `C${n}`
  })
  capped.push(s.id)
  await registry.send(s.id, `This is a scheduling test. Reply with exactly: cap ${n} done. Use no tools and nothing else.`)
  return s.id
}
for (let n = 1; n <= 6; n++) await plain(n)
await sleep(300)
const capStatuses = capped.map((id) => store.getSession(id)?.status)
check('two run, four wait', capStatuses.filter((s) => LIVE.has(s!)).length === 2 && capStatuses.filter((s) => s === 'queued').length === 4, capStatuses.join(','))
check('the queued rows read "Queued  2 of 2 running"', capped.slice(2).every((id) => registry.get(id)?.activity === 'Queued  2 of 2 running'), registry.get(capped[2]!)?.activity ?? '')
check('a queued thread holds no harness', capped.slice(2).every((id) => !registry.liveIds().has(id)))
overrideId = capped[5]!
check('Start now runs the newest past the cap', await registry.startQueued(overrideId))
await sleep(300)
check('three live with the override', capped.filter((id) => registry.liveIds().has(id)).length === 3, `${registry.scheduler.counts().running} running`)
const capSettles = await Promise.all(capped.map((id) => settled(id)))
await sleep(1_500)
check('every capped thread answered', capped.every((id, i) => finalText(id).toLowerCase().includes(`cap ${i + 1} done`)), capSettles.map((e) => e.type).join(','))
check('never more than two at once besides the override', peakOthers === 2, `peak ${peakOthers}`)
const startOrder = capOrder.filter((id) => id !== overrideId)
check('the waiting ones started oldest first', startOrder.join(',') === capped.slice(0, 5).join(','), startOrder.map((id) => registry.get(id)?.title).join(','))
check('each capped thread has one user row', capped.every((id) => registry.eventsAfter(id, 0).filter((r) => r.event.type === 'user-text').length === 1))
admission.stop()

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
