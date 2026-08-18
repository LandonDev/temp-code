/**
 * M1 exit test, run against the real server pieces (Store + SessionRegistry,
 * no Electron): basic turn, tool turn, interrupt, resume across a registry
 * teardown (simulated app relaunch), bad-model error, and two concurrent
 * sessions in different cwds. Run: bun run script:e2e-claude
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import type { AgentEvent, EventRow } from '../src/shared/events'

const dbPath = join(mkdtempSync(join(tmpdir(), 'tc-e2e-')), 'e2e.db')
const store = new Store(openDb(dbPath))

let failures = 0
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

/** Wait until an event matching pred lands with seq > afterSeq. */
function waitFor(
  registry: SessionRegistry,
  sessionId: string,
  pred: (e: AgentEvent) => boolean,
  timeoutMs = 120_000,
  afterSeq = lastSeq(registry, sessionId)
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, afterSeq).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${sessionId}`))
    }, timeoutMs)
    const off = registry.subscribe(sessionId, (row: EventRow) => {
      if (row.seq > afterSeq && pred(row.event)) {
        clearTimeout(timer)
        off()
        resolve(row.event)
      }
    })
  })
}

function lastSeq(registry: SessionRegistry, sessionId: string): number {
  return registry.eventsAfter(sessionId, 0).at(-1)?.seq ?? 0
}

const turnEnd = (e: AgentEvent): boolean => e.type === 'turn-complete' || e.type === 'error'

async function main(): Promise<void> {
  const registry = new SessionRegistry(store)
  const cwdA = mkdtempSync(join(tmpdir(), 'tc-a-'))
  const cwdB = mkdtempSync(join(tmpdir(), 'tc-b-'))
  writeFileSync(join(cwdA, 'test.txt'), 'the secret word is PLUM\n')

  // --- 1. create ------------------------------------------------------------
  const a = await registry.create({
    provider: 'claude',
    model: 'claude-sonnet-5',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'edits',
    cwd: cwdA,
    title: 'e2e-a',
    parentId: null
  })
  check('new session is idle (ready for input)', a.status === 'idle')

  // --- 2. basic turn + concurrent second session ----------------------------
  const b = await registry.create({
    provider: 'claude',
    model: 'claude-sonnet-5',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'edits',
    cwd: cwdB,
    title: 'e2e-b',
    parentId: null
  })
  const markA = lastSeq(registry, a.id)
  const markB = lastSeq(registry, b.id)
  await registry.send(a.id, 'Reply with exactly: ALPHA. Nothing else, no tools.')
  await registry.send(b.id, 'Reply with exactly: BRAVO. Nothing else, no tools.')
  const [endA, endB] = await Promise.all([
    waitFor(registry, a.id, turnEnd, 120_000, markA),
    waitFor(registry, b.id, turnEnd, 120_000, markB)
  ])
  check('concurrent turns complete', endA.type === 'turn-complete' && endB.type === 'turn-complete')

  const textOf = (id: string): string =>
    registry
      .eventsAfter(id, 0)
      .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
      .map((r) => (r.event as { text: string }).text)
      .join(' ')
  check('session A said ALPHA', textOf(a.id).includes('ALPHA'))
  check('session B said BRAVO', textOf(b.id).includes('BRAVO'))
  check(
    'deltas carry msgId/blockIndex',
    registry
      .eventsAfter(a.id, 0)
      .some(
        (r) =>
          r.event.type === 'assistant-text' &&
          r.event.delta &&
          !!r.event.msgId &&
          r.event.blockIndex !== undefined
      )
  )
  check('turn-complete has cost', endA.type === 'turn-complete' && typeof endA.costUsd === 'number')
  const afterTurn = store.getSession(a.id)
  check('nativeId persisted after first turn', !!afterTurn?.nativeId, afterTurn?.nativeId ?? 'none')

  // --- 3. tool turn ---------------------------------------------------------
  const markTool = lastSeq(registry, a.id)
  await registry.send(
    a.id,
    'Read test.txt in your cwd with the Read tool, then reply with exactly: word: <the secret word>.'
  )
  await waitFor(registry, a.id, turnEnd, 120_000, markTool)
  const rowsA = registry.eventsAfter(a.id, 0)
  const call = rowsA.find((r) => r.event.type === 'tool-call' && r.event.name === 'Read')
  const result = rowsA.find(
    (r) =>
      r.event.type === 'tool-result' &&
      call?.event.type === 'tool-call' &&
      r.event.callId === call.event.callId
  )
  check('tool-call emitted (Read)', !!call)
  check('tool-result joined by callId', !!result && (result.event as { output: string }).output.includes('PLUM'))
  check('final answer used tool output', textOf(a.id).includes('PLUM'))

  // --- 4. interrupt ---------------------------------------------------------
  const markInt = lastSeq(registry, a.id)
  await registry.send(a.id, 'Count from 1 to 200 slowly, one number per line. Do not use tools.')
  await waitFor(registry, a.id, (e) => e.type === 'assistant-text' && e.delta, 120_000, markInt)
  const beforeInterrupt = Date.now()
  const markIdle = lastSeq(registry, a.id)
  await registry.interrupt(a.id)
  const afterIntEvent = await waitFor(
    registry,
    a.id,
    (e) => e.type === 'status' && e.status === 'idle',
    30_000,
    markIdle
  )
  check('interrupt returns to idle', afterIntEvent.type === 'status', `${Date.now() - beforeInterrupt}ms`)
  // A user Stop is not a failure: the wind-down error (if the driver
  // reported one) is stamped stopped and never arms recovery.
  const intErrors = registry
    .eventsAfter(a.id, markIdle)
    .filter((r) => r.event.type === 'error')
  check(
    'stop stamps its wind-down error as stopped',
    intErrors.every((r) => r.event.type === 'error' && r.event.stopped === true),
    `${intErrors.length} error(s)`
  )
  check(
    'stopped thread never reads failed',
    registry.list().find((s) => s.id === a.id)?.treeCanContinue === false
  )

  // --- 5. resume across "relaunch" -----------------------------------------
  await registry.disposeAll()
  const registry2 = new SessionRegistry(store)
  const replay = registry2.eventsAfter(a.id, 0)
  check('transcript survives relaunch', replay.length === rowsA.length + replayDelta(rowsA, replay))
  const markResume = lastSeq(registry2, a.id)
  await registry2.send(a.id, 'Earlier I asked you to reply with a single Greek-alphabet codeword. Which was it? Reply with just that word.')
  const resumeEnd = await waitFor(registry2, a.id, turnEnd, 120_000, markResume)
  const resumedText = registry2
    .eventsAfter(a.id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')
  check(
    'resume remembers prior turn',
    resumeEnd.type === 'turn-complete' && resumedText.includes('ALPHA'),
    resumedText.slice(-80)
  )

  // --- 6. bad model ---------------------------------------------------------
  // Verified live: the harness handles this itself — it emits a synthetic
  // assistant message explaining the model problem and completes the turn.
  // Our error events cover real failures (spawn/stream crashes).
  const bad = await registry2.create({
    provider: 'claude',
    model: 'claude-bogus-model',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'edits',
    cwd: cwdB,
    title: 'e2e-bad',
    parentId: null
  })
  await registry2.send(bad.id, 'hi')
  await waitFor(registry2, bad.id, turnEnd, 120_000)
  const badText = registry2
    .eventsAfter(bad.id, 0)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')
  check('bad model surfaced to the user', /model/i.test(badText), badText.slice(0, 80))

  await registry2.disposeAll()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

/** Interrupt may add trailing rows between snapshot and relaunch; allow >=. */
function replayDelta(before: EventRow[], after: EventRow[]): number {
  return Math.max(0, after.length - before.length)
}

main().catch((err) => {
  console.error('E2E crashed:', err)
  process.exit(1)
})
