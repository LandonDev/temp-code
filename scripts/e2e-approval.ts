/**
 * M4 exit test: a safe-policy session runs a Bash command → the driver
 * emits approval-request + status waiting → approve → tool runs → turn
 * completes. Then a second request is denied and the model reports it
 * couldn't run the command. Run: bun run script:e2e-approval
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import type { AgentEvent, EventRow } from '../src/shared/events'

const store = new Store(openDb(join(mkdtempSync(join(tmpdir(), 'tc-ap-')), 'ap.db')))
const registry = new SessionRegistry(store)

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const lastSeq = (id: string): number => registry.eventsAfter(id, 0).at(-1)?.seq ?? 0

function waitFor(
  sessionId: string,
  pred: (e: AgentEvent) => boolean,
  afterSeq: number,
  timeoutMs = 120_000
): Promise<AgentEvent> {
  return new Promise((resolve, reject) => {
    const prior = registry.eventsAfter(sessionId, afterSeq).find((r) => pred(r.event))
    if (prior) return resolve(prior.event)
    const timer = setTimeout(() => {
      off()
      reject(new Error('timeout'))
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

const s = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5',
  reasoning: 'low',
  agentType: 'implementer',
  permission: 'safe',
  cwd: mkdtempSync(join(tmpdir(), 'tc-ap-cwd-')),
  title: 'approval',
  parentId: null
})

// Note: trivial commands (echo, ls) are auto-approved by the harness's own
// safe-command classifier and never reach canUseTool — use network commands.

// --- approve path -----------------------------------------------------------
let mark = lastSeq(s.id)
await registry.send(s.id, 'Run `curl -s example.com | head -c 60` with the Bash tool and tell me what you get.')
const req = await waitFor(s.id, (e) => e.type === 'approval-request', mark)
check('approval-request emitted', req.type === 'approval-request' && req.toolName === 'Bash')
check('status is waiting', store.getSession(s.id)?.status === 'waiting')

if (req.type === 'approval-request') {
  await registry.approve(s.id, req.requestId, true)
  const resolved = await waitFor(s.id, (e) => e.type === 'approval-resolved', mark)
  check('approval-resolved allow', resolved.type === 'approval-resolved' && resolved.allow)
  await waitFor(s.id, (e) => e.type === 'turn-complete', mark)
  const out = registry
    .eventsAfter(s.id, 0)
    .find(
      (r) =>
        r.event.type === 'tool-result' && !r.event.isError && /doctype|Example/i.test(r.event.output)
    )
  check('approved tool actually ran', !!out)
}

// --- deny path --------------------------------------------------------------
mark = lastSeq(s.id)
await registry.send(s.id, 'Now run `curl -s example.org` with the Bash tool. If you cannot run it, reply exactly: DENIED-OK')
const req2 = await waitFor(s.id, (e) => e.type === 'approval-request', mark)
if (req2.type === 'approval-request') {
  await registry.approve(s.id, req2.requestId, false)
  const resolved2 = await waitFor(s.id, (e) => e.type === 'approval-resolved', mark)
  check('approval-resolved deny', resolved2.type === 'approval-resolved' && !resolved2.allow)
  await waitFor(s.id, (e) => e.type === 'turn-complete' || e.type === 'error', mark)
  const text = registry
    .eventsAfter(s.id, mark)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')
  check('model saw the denial', text.includes('DENIED-OK'), text.slice(-60))
  const ran = registry
    .eventsAfter(s.id, mark)
    .some((r) => r.event.type === 'tool-result' && !r.event.isError && /doctype/i.test(r.event.output))
  check('denied tool did not run', !ran)
}

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
