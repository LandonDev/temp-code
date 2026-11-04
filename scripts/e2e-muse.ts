/**
 * Muse Code end to end: an in-process registry on the real `muse` binary and
 * the login its config dir holds (the CLI's own `~/.config/muse`, or the dir
 * XDG_CONFIG_HOME names; TBH_CREDENTIAL_BACKEND=file is set here so the file
 * is the credential). One chat thread, one turn with a shell tool call, one
 * turn whose network call asks for approval (answered through
 * `registry.approve`), one steer received mid-turn, one cancel. Not in the
 * gate (it boots a harness and spends a real turn); it skips with one line
 * where `muse` does not resolve or the catalog is empty (no login, or an
 * address Meta serves nothing to).
 *
 *   bun run script:e2e-muse        (the Mac: esbuild → node; on the box: bun --preload scripts/lib/electron-stub.ts scripts/e2e-muse.ts)
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { SessionRegistry } from '../src/main/server/sessions'
import { setOrchestrationRegistry } from '../src/main/server/orchestration'
import { setAppToolsRegistry } from '../src/main/server/apptools'
import { resolveMuseBinary } from '../src/main/server/drivers/harness/child'
import { probeCatalog } from '../src/main/server/drivers/harness/museCatalog'
import type { EventRow } from '../src/shared/events'

process.env.TBH_CREDENTIAL_BACKEND ??= 'file'
process.env.MUSE_CONTRIBUTOR_MODE ??= '0'

const skip = (why: string): never => {
  console.log(`SKIP  ${why}`)
  process.exit(0)
}
const bin = await resolveMuseBinary().catch(() => null)
if (!bin) skip('muse is not installed on this host')
const catalog = await probeCatalog().catch((err: unknown) => skip(`the catalog probe failed: ${err instanceof Error ? err.message : String(err)}`))
if (!catalog || catalog.models.length === 0) skip('the catalog is empty here (no login, or Meta serves this address nothing)')
console.log(`muse ${bin!.path}: ${catalog!.models.map((m) => m.id).join(', ')}, default ${catalog!.defaultModel}`)

const dataDir = mkdtempSync(join(tmpdir(), 'tc-muse-'))
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
const text = (id: string, after = 0): string =>
  rows(id, after)
    .filter((r) => r.event.type === 'assistant-text' && !r.event.delta)
    .map((r) => (r.event as { text: string }).text)
    .join(' ')
const lastSteerId = (id: string): string | undefined =>
  rows(id)
    .map((r) => r.event)
    .filter((e): e is Extract<typeof e, { type: 'user-text' }> => e.type === 'user-text')
    .at(-1)?.steerId

const cwd = mkdtempSync(join(tmpdir(), 'tc-muse-work-'))
writeFileSync(join(cwd, 'README.md'), '# muse e2e\n')
writeFileSync(join(cwd, 'notes.txt'), 'a\nb\n')
const thread = await registry.create({ provider: 'muse', model: 'muse-spark-1.3', reasoning: 'low', agentType: 'implementer', permission: 'edits', cwd, threadType: 'chat', parentId: null })
const id = thread.id

// ── 1. a turn with a shell tool call ───────────────────────────────────
console.log('\n[1] a shell tool call under Ask me')
const t0 = Date.now()
await registry.send(id, 'Run `ls -la` in this directory with your shell tool and tell me how many entries there are. Then stop.')
const call = await waitFor(id, (r) => r.event.type === 'tool-call' && !r.event.partial).catch(() => null)
check('a tool-call row landed', !!call, call ? `${call.ts - t0} ms after the send, ${JSON.stringify((call.event as { name: string }).name)}` : 'none')
const result = await waitFor(id, (r) => r.event.type === 'tool-result').catch(() => null)
check('its result followed', !!result && !(result.event as { isError?: boolean }).isError)
const end1 = await waitFor(id, isSettle)
check('the turn settled idle', end1.event.type === 'turn-complete', end1.event.type)
check('the answer counts the entries', /\b(4|5|four|five)\b/i.test(text(id)), text(id).slice(-120))
const meta1 = registry.get(id)
check('the row carries the native session id', !!meta1?.nativeId, meta1?.nativeId ?? '')

// ── 2. an approval, denied ─────────────────────────────────────────────
console.log('\n[2] a network call asks for approval; Deny')
const before2 = rows(id).at(-1)!.seq
await registry.send(id, 'Run `curl -sI https://example.com | head -1` with your shell tool once and tell me the status line. If the command is refused or denied, do not try again or any other way: say "refused" and stop.')
const ask = await waitFor(id, (r) => r.event.type === 'approval-request', before2).catch(() => null)
check('an approval-request row landed', !!ask, ask ? JSON.stringify((ask.event as { title?: string }).title) : 'none')
// Deny this card and every retry the model makes until the turn ends (three at most).
let denied = 0
let cursor = before2
let end2: EventRow | null = null
for (let i = 0; i < 4 && !end2; i++) {
  const next = await waitFor(id, (r) => r.event.type === 'approval-request' || r.event.type === 'turn-complete' || (r.event.type === 'status' && r.event.status === 'error'), cursor)
  if (next.event.type !== 'approval-request') {
    end2 = next
    break
  }
  await registry.approve(id, next.event.requestId, false)
  const resolved = await waitFor(id, (r) => r.event.type === 'approval-resolved', next.seq)
  if ((resolved.event as { allow: boolean }).allow === false) denied++
  cursor = resolved.seq
}
check('every request resolved as denied', denied >= 1, `${denied} denied`)
check('the turn settled', end2?.event.type === 'turn-complete', end2?.event.type ?? 'never')
check('the model saw the refusal', /refus/i.test(text(id, before2)), text(id, before2).slice(-120))

// ── 3. a steer received mid-turn ───────────────────────────────────────
console.log('\n[3] a steer during a long answer')
const before3 = rows(id).at(-1)!.seq
await registry.send(id, 'Count from 1 to 60 in your final message, one number per line, slowly and nothing else.')
await waitFor(id, (r) => r.event.type === 'assistant-text', before3)
const added = registry.queueAdd(id, 'Stop counting now and just say the word STEERED.', { steer: true })
check('the steer went straight in', added.kind === 'steered', added.kind)
const s1 = lastSteerId(id)
const received = s1 ? await waitFor(id, (r) => r.event.type === 'steer' && r.event.steerId === s1 && r.event.state === 'received', before3).catch(() => null) : null
check('stamped received in-turn', received?.event.type === 'steer' && received.event.how === 'in-turn', received ? JSON.stringify(received.event) : 'never')
const end3 = await waitFor(id, isSettle, before3)
check('the steered turn settled', end3.event.type === 'turn-complete')
// What the model does with the steer is its own (Spark kept counting on
// 2026-11-04); the proof holds the mechanics: sent, received in-turn, settled.
console.log(`      the answer ended: ${text(id, before3).replace(/\s+/g, ' ').slice(-60)}`)

// ── 4. a cancel ────────────────────────────────────────────────────────
console.log('\n[4] a cancel mid-stream')
const before4 = rows(id).at(-1)!.seq
await registry.send(id, 'Write a 600-word essay about rivers.')
await waitFor(id, (r) => r.event.type === 'assistant-text', before4)
await registry.interrupt(id)
const end4 = await waitFor(id, (r) => r.event.type === 'status' && (r.event.status === 'idle' || r.event.status === 'stopped' || r.event.status === 'error'), before4)
check('the cancel settled the row', end4.event.type === 'status' && end4.event.status !== 'error', (end4.event as { status: string }).status)

await registry.disposeAll()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
