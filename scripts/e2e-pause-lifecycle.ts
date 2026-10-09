/** Deterministic pause/recovery coverage with a controlled in-memory driver. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessDriver } from '../src/main/server/drivers/types'
import { BUILT_IN_DRIVERS } from '../src/main/server/drivers'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import type { TurnPass } from '../src/shared/turnpass'
import type { SessionMeta } from '../src/shared/events'

const sends: { sessionId: string; text: string }[] = []
const boots: string[] = []
const interrupts: string[] = []
const failContinue = new Set<string>()

const controlledDriver: HarnessDriver = {
  id: 'claude',
  async start({ session, emit, setNativeId }) {
    boots.push(session.id)
    setNativeId(session.nativeId ?? `native-${session.id}`)
    return {
      async send(text) {
        sends.push({ sessionId: session.id, text })
        if (failContinue.has(session.id) && text.includes('<continue-run>')) {
          throw new Error(`controlled resume failure: ${session.id}`)
        }
        emit({ type: 'status', status: 'running' })
      },
      interrupt() {
        interrupts.push(session.id)
        queueMicrotask(() => emit({ type: 'status', status: 'idle' }))
      },
      async dispose() {
        return Promise.resolve()
      }
    }
  }
}
BUILT_IN_DRIVERS.claude = controlledDriver

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await tick()
  }
  throw new Error(`timeout: ${label}`)
}

const dbPath = join(mkdtempSync(join(tmpdir(), 'tc-pause-lc-')), 'pause.db')
const store = new Store(openDb(dbPath))
let registry = new SessionRegistry(store)
const base = {
  provider: 'claude' as const,
  model: 'claude-sonnet-5-5',
  reasoning: 'low' as const,
  agentType: 'implementer' as const,
  permission: 'edits' as const,
  cwd: '/tmp',
  parentId: null
}

// One failed idle root and one failed error root count once each. The batch
// attempts both even when one replacement send fails.
const errorA = await registry.create({ ...base, title: 'error-a' })
const errorB = await registry.create({ ...base, title: 'error-b' })
await tick()
registry.append(errorA.id, { type: 'error', message: 'limit a' })
registry.append(errorA.id, { type: 'status', status: 'idle' })
registry.append(errorB.id, { type: 'error', message: 'limit b' })
registry.append(errorB.id, { type: 'status', status: 'error' })
check(
  'two failed roots produce a recovery count of two',
  registry.list().filter((session) => !session.parentId && session.treeCanContinue).length === 2
)
failContinue.add(errorB.id)
const errorBatch = await registry.continueAllErrors()
check('error batch attempts every root', errorBatch.attempted.length === 2)
check(
  'error batch reports one success and one failure',
  errorBatch.succeeded.length === 1 && errorBatch.failed.length === 1
)
check(
  'successful retry clears stored errors',
  registry.list().find((s) => s.id === errorA.id)?.canContinue === false
)
check(
  'failed retry remains recoverable',
  registry.list().find((s) => s.id === errorB.id)?.canContinue === true
)

// Failed descendants never flag the root's tree on their own, but a
// continue on the root still reboots them first.
const orch = await registry.create({ ...base, title: 'orchestrator', agentType: 'orchestrator' })
const childA = await registry.create({ ...base, title: 'child-a', parentId: orch.id })
const childB = await registry.create({ ...base, title: 'child-b', parentId: orch.id })
await tick()
registry.append(childA.id, { type: 'error', message: 'child a failed' })
registry.append(childA.id, { type: 'status', status: 'idle' })
registry.append(childB.id, { type: 'error', message: 'child b failed' })
registry.append(childB.id, { type: 'status', status: 'error' })
check(
  'failed descendants alone never flag the root tree',
  registry.list().find((s) => s.id === orch.id)?.treeCanContinue === false
)
boots.length = 0
await registry.continueRun(orch.id)
const orchBoot = boots.indexOf(orch.id)
check(
  'failed descendants reboot before their root',
  orchBoot > boots.indexOf(childA.id) && orchBoot > boots.indexOf(childB.id),
  boots.join(',')
)

// Pause wins the interrupt race, freezes elapsed time, and parks pass,
// report, and user queues until the resumed turn settles in that order.
const queued = await registry.create({ ...base, title: 'queued-root' })
await tick()
store.updateSession(queued.id, { status: 'running', busySince: Date.now() - 5_000 })
await registry.pauseRun(queued.id)
await tick()
const paused = store.getSession(queued.id)!
check('pause survives a late idle callback', paused.status === 'paused')
check('pause snapshots active elapsed time', (paused.frozenActiveElapsed ?? 0) >= 4_500)
const passPending = (registry as unknown as { passPending: Map<string, TurnPass> }).passPending
passPending.set(queued.id, { verify: true, build: false, commit: 'off' })
registry.deliverAgentReport(queued.id, {
  text: '<agent-report>child complete</agent-report>',
  agentId: childA.id,
  title: childA.title,
  status: 'idle'
})
registry.queueAdd(queued.id, 'queued user message')
const beforeParked = sends.length
registry.append(queued.id, { type: 'turn-complete' })
registry.append(queued.id, { type: 'status', status: 'idle' })
await tick()
check('paused pass, report, and user queue stay parked', sends.length === beforeParked)

await registry.resumePausedRun(queued.id)
const resumed = store.getSession(queued.id)!
const resumedElapsed = Date.now() - (resumed.busySince ?? Date.now())
check(
  'resume restores the frozen timer',
  Math.abs(resumedElapsed - (paused.frozenActiveElapsed ?? 0)) < 500
)
registry.append(queued.id, { type: 'status', status: 'idle' })
await waitFor(() => sends.some((send) => send.text.includes('<turn-pass>')), 'turn pass')
registry.append(queued.id, { type: 'status', status: 'idle' })
await waitFor(() => sends.some((send) => send.text.includes('<agent-report>')), 'agent report')
registry.append(queued.id, { type: 'status', status: 'idle' })
await waitFor(
  () => sends.some((send) => send.text === 'queued user message'),
  'queued user message'
)
const orderedTexts = sends.filter((send) => send.sessionId === queued.id).map((send) => send.text)
const resumeAt = orderedTexts.findIndex((text) => text.includes('<continue-paused-run>'))
const passAt = orderedTexts.findIndex((text) => text.includes('<turn-pass>'))
const reportAt = orderedTexts.findIndex((text) => text.includes('<agent-report>'))
const queueAt = orderedTexts.findIndex((text) => text === 'queued user message')
check(
  'settle order is resumed turn, pass, report, then queue',
  resumeAt < passAt && passAt < reportAt && reportAt < queueAt
)

// Recursive pause covers the root tree and recursive resume boots children
// first. Hard Stop clears every paused member and leaves no pause summary.
store.updateSession(orch.id, { status: 'running', busySince: Date.now() - 2_000 })
store.updateSession(childA.id, { status: 'running', busySince: Date.now() - 1_000 })
store.updateSession(childB.id, { status: 'waiting', busySince: Date.now() - 1_500 })
await registry.pauseRun(orch.id)
await tick()
check(
  'orchestration pause marks root and all live descendants',
  [orch.id, childA.id, childB.id].every((id) => store.getSession(id)?.status === 'paused')
)
boots.length = 0
await registry.resumePausedRun(orch.id)
check(
  'paused descendants resume before the root',
  boots.indexOf(orch.id) > boots.indexOf(childA.id) &&
    boots.indexOf(orch.id) > boots.indexOf(childB.id),
  boots.join(',')
)
await registry.pauseRun(orch.id)
await registry.stopRun(orch.id)
await tick()
check(
  'hard Stop clears the whole paused tree',
  [orch.id, childA.id, childB.id].every((id) => store.getSession(id)?.status === 'idle')
)
check(
  'hard Stop leaves no paused root summary',
  registry.list().find((s) => s.id === orch.id)?.treeHasPaused === false
)

// Paused state and its timer survive process restart; Continue uses native
// resume with no old handle in memory.
const restart = await registry.create({ ...base, title: 'restart-root' })
await tick()
store.updateSession(restart.id, { status: 'running', busySince: Date.now() - 3_000 })
await registry.pauseRun(restart.id)
const frozenBeforeRestart = store.getSession(restart.id)?.frozenActiveElapsed ?? 0
await registry.disposeAll()
registry = new SessionRegistry(store)
registry.resetStaleStatuses()
check('boot cleanup preserves paused state', store.getSession(restart.id)?.status === 'paused')
check(
  'boot cleanup preserves frozen elapsed time',
  store.getSession(restart.id)?.frozenActiveElapsed === frozenBeforeRestart
)
boots.length = 0
await registry.resumePausedRun(restart.id)
check(
  'restart Continue boots a new native-resume handle',
  boots.includes(restart.id) && store.getSession(restart.id)?.status === 'running'
)

// Pause all: one attempt per running root, archived roots untouched,
// descendants folded into their root rather than attempted on their own.
const runA = await registry.create({ ...base, title: 'pause-all-a' })
const runB = await registry.create({ ...base, title: 'pause-all-b' })
const runChild = await registry.create({ ...base, title: 'pause-all-child', parentId: runB.id })
const shelved = await registry.create({ ...base, title: 'pause-all-archived' })
await tick()
store.updateSession(shelved.id, { archived: true })
for (const id of [runA.id, runB.id, runChild.id, shelved.id]) {
  store.updateSession(id, { status: 'running', busySince: Date.now() - 1_000 })
}
const pauseBatch = await registry.pauseAllRunning()
await tick()
check(
  'pause all attempts each running root once',
  new Set(pauseBatch.attempted).size === pauseBatch.attempted.length
)
check(
  'pause all covers every running root',
  pauseBatch.attempted.includes(runA.id) && pauseBatch.attempted.includes(runB.id)
)
check('pause all skips archived roots', !pauseBatch.attempted.includes(shelved.id))
check(
  'pause all never attempts a descendant as a root',
  !pauseBatch.attempted.includes(runChild.id)
)
check(
  'pause all pauses each root tree',
  [runA.id, runB.id, runChild.id].every((id) => store.getSession(id)?.status === 'paused')
)
check('pause all leaves archived work running', store.getSession(shelved.id)?.status === 'running')
check('pause all reports no failures', pauseBatch.failed.length === 0)
check(
  'nothing running leaves pause all with no work',
  (await registry.pauseAllRunning()).attempted.length === 0
)

// A thread that is working again never reads as failed. The stored fold
// stays put, so an error nothing superseded returns if the thread settles
// without producing anything.
const revived = await registry.create({ ...base, title: 'revived-root' })
await tick()
registry.append(revived.id, { type: 'error', message: 'limit' })
registry.append(revived.id, { type: 'status', status: 'idle' })
const metaOf = (id: string): SessionMeta | undefined => registry.list().find((s) => s.id === id)
check(
  'a settled error still offers recovery',
  metaOf(revived.id)?.canContinue === true && metaOf(revived.id)?.treeCanContinue === true
)
registry.append(revived.id, { type: 'status', status: 'running' })
check(
  'a working thread drops the recovery flag',
  metaOf(revived.id)?.canContinue === false && metaOf(revived.id)?.treeCanContinue === false
)
const skipBatch = await registry.continueAllErrors()
check('recovery batches leave a working thread alone', !skipBatch.attempted.includes(revived.id))
registry.append(revived.id, { type: 'status', status: 'idle' })
check('an unproductive run brings the flag back', metaOf(revived.id)?.canContinue === true)
registry.append(revived.id, { type: 'status', status: 'running' })
registry.append(revived.id, { type: 'assistant-text', text: 'back at it', delta: false })
registry.append(revived.id, { type: 'status', status: 'idle' })
check(
  'work that produced something clears the error for good',
  metaOf(revived.id)?.canContinue === false
)

// A dead subagent never paints its root failed: the root reads as working
// while it runs and stays clean once it settles — only the root's own
// trailing error makes the thread read failed.
const liveOrch = await registry.create({ ...base, title: 'live-orch', agentType: 'orchestrator' })
const deadChild = await registry.create({ ...base, title: 'dead-child', parentId: liveOrch.id })
await tick()
registry.append(deadChild.id, { type: 'error', message: 'child died' })
registry.append(deadChild.id, { type: 'status', status: 'error' })
registry.append(liveOrch.id, { type: 'status', status: 'running' })
check(
  'a working orchestration hides a dead child behind its own live status',
  metaOf(liveOrch.id)?.treeCanContinue === false && metaOf(liveOrch.id)?.treeHasLiveWork === true
)
registry.append(liveOrch.id, { type: 'status', status: 'idle' })
check(
  'a settled orchestration never wears a stale child error',
  metaOf(liveOrch.id)?.treeCanContinue === false
)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
