/**
 * A steer says it was received, end to end (sessions.ts steerLive, the
 * claude driver's readSteers). An in-process registry with its own
 * database and a scratch folder; one claude-haiku-5-5 thread in full
 * access. Proves:
 *   1. A steer into a turn that runs a slow Bash call: the user row carries
 *      a steerId, the steer is stamped sent and then received in-turn (the
 *      CLI names its uuid on the frame after the fold), the model writes a
 *      line of text before any later tool call, and does what it asked.
 *   2. A steer sent as the turn's last words land: it is received too,
 *      in-turn when the CLI folds it, next-turn when the turn ended first.
 * Codex is not driven here: the box had no live codex sign-in when this
 * was written (docs/box.md "A steer says it was received").
 * Run: bun run script:e2e-steer-ack
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import type { AgentEvent, EventRow } from '../src/shared/events'

const dataDir = mkdtempSync(join(tmpdir(), 'tc-steer-'))
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

function waitFor(sessionId: string, pred: (row: EventRow) => boolean, afterSeq = 0, timeoutMs = 180_000): Promise<EventRow> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, afterSeq).find(pred)
    if (prior) return resolve(prior)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout waiting on ${sessionId}`))
    }, timeoutMs)
    const off = registry.subscribe(sessionId, (row: EventRow) => {
      if (row.seq > afterSeq && pred(row)) {
        clearTimeout(timer)
        off()
        resolve(row)
      }
    })
  })
}
const isSettle = (r: EventRow): boolean =>
  r.event.type === 'turn-complete' || (r.event.type === 'status' && (r.event.status === 'waiting' || r.event.status === 'error'))
const rows = (id: string, after = 0): EventRow[] => registry.eventsAfter(id, after)
const steerRows = (id: string, steerId: string) =>
  rows(id).flatMap((r) => (r.event.type === 'steer' && r.event.steerId === steerId ? [{ seq: r.seq, ts: r.ts, ...r.event }] : []))
const lastSteerId = (id: string): string | undefined =>
  rows(id)
    .map((r) => r.event)
    .filter((e): e is Extract<AgentEvent, { type: 'user-text' }> => e.type === 'user-text')
    .at(-1)?.steerId

const thread = await registry.create({
  provider: 'claude',
  model: 'claude-haiku-5-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'auto',
  cwd: mkdtempSync(join(tmpdir(), 'tc-steer-work-')),
  threadType: 'chat',
  parentId: null
})
const id = thread.id

// ── 1. a steer folded mid-turn ─────────────────────────────────────────
console.log('\n[1] a steer during a slow Bash call')
await registry.send(id, 'This is a test; ask no questions. Run the shell command `sleep 15 && echo done` with the Bash tool, then run `echo second` with the Bash tool, then report both outputs in one line.')
const call = await waitFor(id, (r) => r.event.type === 'tool-call' && !r.event.partial)
const added = registry.queueAdd(id, 'Also put the word BANANA in your final line.', { steer: true })
check('the steer went straight in', added.kind === 'steered')
const s1 = lastSteerId(id)
check('its user row carries a steerId', !!s1, s1)
const sent = await waitFor(id, (r) => r.event.type === 'steer' && r.event.steerId === s1 && r.event.state === 'sent').catch(() => null)
check('stamped sent once the harness had it', !!sent, sent ? `${sent.ts - call.ts} ms after the call` : '')
// The CLI reads the steer only when the call returns: the row says the call
// and that the message is behind it, never the provider (the box, 2026-11-06:
// "Waiting for the provider" through a 600 s call).
await waitFor(id, (r) => r.event.type === 'tool-call' && !r.event.partial && typeof (r.event.input as { command?: unknown } | undefined)?.command === 'string')
const during = registry.get(id)
check('the row says the call, then your message', during?.activity === 'Running sleep, then your message', `${during?.activity ?? 'null'} / ${during?.statusDetail ?? 'null'}`)
const steerRow = rows(id).findLast((r) => r.event.type === 'user-text')
const between = rows(id, steerRow?.seq ?? 0).filter((r) => r.seq < (sent?.seq ?? Infinity))
check('the steer wrote no running status', !between.some((r) => r.event.type === 'status' && r.event.status === 'running'), between.map((r) => r.event.type).join(','))
const received = await waitFor(id, (r) => r.event.type === 'steer' && r.event.steerId === s1 && r.event.state === 'received').catch(() => null)
const how = received?.event.type === 'steer' ? received.event.how : undefined
check('stamped received in-turn', how === 'in-turn', `${how ?? 'never'}${received && sent ? `, ${received.ts - sent.ts} ms after sent` : ''}`)
const read = registry.get(id)?.activity ?? ''
check('once read, the row stops saying your message', !/then your message/.test(read), read)
const end1 = await waitFor(id, isSettle)
if (received) {
  const after = rows(id, received.seq).filter((r) => r.seq < end1.seq)
  const firstText = after.findIndex((r) => r.event.type === 'assistant-text' && !r.event.delta)
  const nextCall = after.findIndex((r) => r.event.type === 'tool-call' && !r.event.partial)
  check('a line of text before the next tool call', firstText >= 0 && (nextCall < 0 || firstText < nextCall), firstText >= 0 ? JSON.stringify((after[firstText].event as { text: string }).text.slice(0, 120)) : 'no text')
}
const words = rows(id)
  .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
  .map((r) => (r.event as { text: string }).text)
  .join(' ')
check('the model did what the steer asked', /BANANA/.test(words), words.slice(-160))
check('the steer rows read sent, received', steerRows(id, s1!).map((r) => r.state).join(',') === 'sent,received')

// ── 2. a steer as the turn ends ────────────────────────────────────────
console.log('\n[2] a steer as the turn ends')
const before = rows(id).at(-1)!.seq
await registry.send(id, 'Reply with the single word PEAR and nothing else. Use no tools.')
await waitFor(id, (r) => r.event.type === 'assistant-text' && !r.event.delta, before)
const late = registry.queueAdd(id, 'Now reply with the single word PLUM.', { steer: true })
const s2 = late.kind === 'steered' ? lastSteerId(id) : undefined
check('the late steer went in while the turn was live', late.kind === 'steered', late.kind)
if (s2) {
  const got = await waitFor(id, (r) => r.event.type === 'steer' && r.event.steerId === s2 && r.event.state === 'received').catch(() => null)
  const how2 = got?.event.type === 'steer' ? got.event.how : undefined
  check('the late steer is received', !!got, how2 ?? 'never')
  await waitFor(id, isSettle, got?.seq ?? before)
  const plum = rows(id, got?.seq ?? before).some((r) => r.event.type === 'assistant-text' && /PLUM/.test((r.event as { text: string }).text))
  check('the model answered it', plum)
}

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
