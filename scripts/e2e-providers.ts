/**
 * M5 exit test: one session per provider side by side, all streaming
 * through the same registry; codex tool turn; cursor resume across turns.
 * Run: bun run script:e2e-providers
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { runDoctor } from '../src/main/server/drivers/binaries'
import type { AgentEvent, EventRow } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-pv-')), 'pv.db')))
const registry = new SessionRegistry(store)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const lastSeq = (id: string): number => registry.eventsAfter(id, 0).at(-1)?.seq ?? 0
const turnEnd = (e: AgentEvent): boolean => e.type === 'turn-complete' || e.type === 'error'

function waitFor(
  sessionId: string,
  pred: (e: AgentEvent) => boolean,
  afterSeq: number,
  timeoutMs = 240_000
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, afterSeq).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error(`timeout on ${sessionId}`))
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

const textOf = (id: string, after = 0): string =>
  registry
    .eventsAfter(id, after)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')

async function main(): Promise<void> {
  const doctor = await runDoctor()
  for (const [p, r] of Object.entries(doctor)) {
    check(`doctor: ${p}`, r.found && !r.error, r.version ?? r.error ?? '')
  }

  const mk = (provider: 'claude' | 'codex' | 'cursor', model: string, cwd: string) =>
    registry.create({
      provider,
      model,
      reasoning: 'low',
      agentType: 'implementer',
      permission: 'edits',
      cwd,
      title: `pv-${provider}`,
      parentId: null
    })

  const cwd = mkdtempSync(join(tmpdir(), 'tc-pv-cwd-'))
  writeFileSync(join(cwd, 'fruit.txt'), 'the fruit is MANGO\n')

  const [claude, codex, cursor] = await Promise.all([
    mk('claude', 'claude-sonnet-5-5', cwd),
    mk('codex', 'gpt-5.5', cwd),
    mk('cursor', 'sonnet-4.5', cwd)
  ])

  // --- all three streaming side by side ------------------------------------
  const marks = { c: lastSeq(claude.id), x: lastSeq(codex.id), r: lastSeq(cursor.id) }
  await registry.send(claude.id, 'Reply with exactly: CLAUDE-OK')
  await registry.send(codex.id, 'Reply with exactly: CODEX-OK')
  await registry.send(cursor.id, 'Reply with exactly: CURSOR-OK')
  const [e1, e2, e3] = await Promise.all([
    waitFor(claude.id, turnEnd, marks.c),
    waitFor(codex.id, turnEnd, marks.x),
    waitFor(cursor.id, turnEnd, marks.r)
  ])
  check('all three turns complete', [e1, e2, e3].every((e) => e.type === 'turn-complete'))
  check('claude said CLAUDE-OK', textOf(claude.id).includes('CLAUDE-OK'))
  check('codex said CODEX-OK', textOf(codex.id).includes('CODEX-OK'))
  check('cursor said CURSOR-OK', textOf(cursor.id).includes('CURSOR-OK'))
  check('codex deltas streamed', registry.eventsAfter(codex.id, 0).some((r) => r.event.type === 'assistant-text' && r.event.delta))
  check('cursor deltas streamed', registry.eventsAfter(cursor.id, 0).some((r) => r.event.type === 'assistant-text' && r.event.delta))
  check('codex nativeId (thread) persisted', !!store.getSession(codex.id)?.nativeId)
  check('cursor nativeId (session) persisted', !!store.getSession(cursor.id)?.nativeId)

  // --- codex tool turn ------------------------------------------------------
  const mx = lastSeq(codex.id)
  await registry.send(codex.id, 'Read fruit.txt in your cwd (cat it) and reply with exactly: fruit: <the fruit>')
  await waitFor(codex.id, turnEnd, mx)
  const codexRows = registry.eventsAfter(codex.id, mx)
  check('codex tool-call emitted', codexRows.some((r) => r.event.type === 'tool-call'))
  check(
    'codex tool-result captured',
    codexRows.some((r) => r.event.type === 'tool-result' && r.event.output.includes('MANGO'))
  )
  check('codex used tool output', textOf(codex.id, mx).includes('MANGO'))

  // --- cursor resume across turns (process-per-turn) ------------------------
  const mr = lastSeq(cursor.id)
  await registry.send(cursor.id, 'What codeword did I ask you to reply with earlier? Reply with just that word.')
  await waitFor(cursor.id, turnEnd, mr)
  check('cursor resume remembers', textOf(cursor.id, mr).includes('CURSOR-OK'), textOf(cursor.id, mr).slice(-60))

  await registry.disposeAll()
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('E2E crashed:', err)
  process.exit(1)
})
