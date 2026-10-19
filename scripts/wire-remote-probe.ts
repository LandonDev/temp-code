/**
 * Probe a running server's socket as a remote client and as a local one,
 * and print what each profile sends: the session list (one page with a
 * cursor against the whole array), the cold open of the seeded busy
 * thread (bodies off the wire against bodies on it), an older page, a
 * row fetched whole, a resume that replays and one that resets, a
 * coalesced sessions frame, and permessage-deflate's effect measured on
 * the TCP socket's bytes read.
 *
 *   bun run script:wire-remote-probe -- <server port>
 *
 * Runs under node with the `ws` client so the deflate extension is
 * negotiated and the socket's byte counters are reachable.
 */
import WebSocket from 'ws'
import { BODY_OMIT_BYTES, SHELL_PAGE_BYTES, TAIL_BYTES } from '../src/shared/wireBudgets'

const port = Number(process.argv[2])
if (!port) {
  console.error('usage: bun run script:wire-remote-probe -- <server port>')
  process.exit(1)
}
const KIB = 1024
const kb = (n: number): string => `${(n / KIB).toFixed(1)} KiB`

type Frame = Record<string, unknown> & { push?: string; id?: string }
type Conn = {
  ws: WebSocket
  profile: 'local' | 'remote'
  frames: Frame[]
  request: (method: string, params?: unknown) => Promise<{ result: unknown; raw: number; wire: number }>
  extensions: string
  wireBytes: () => number
}

async function connect(profile: 'local' | 'remote'): Promise<Conn> {
  const url = `ws://127.0.0.1:${port}/${profile === 'remote' ? '?profile=remote' : ''}`
  const ws = new WebSocket(url, { perMessageDeflate: true })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const frames: Frame[] = []
  const waiters = new Map<string, (f: Frame) => void>()
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Frame
    if (frame.id && waiters.has(frame.id)) {
      waiters.get(frame.id)!(frame)
      waiters.delete(frame.id)
    } else frames.push(frame)
  })
  const socket = (ws as unknown as { _socket: { bytesRead: number } })._socket
  let next = 1
  const request = (method: string, params?: unknown): Promise<{ result: unknown; raw: number; wire: number }> =>
    new Promise((resolve, reject) => {
      const id = `${profile}-${next++}`
      const before = socket.bytesRead
      waiters.set(id, (frame) => {
        if (frame.ok === false) reject(new Error(String(frame.error)))
        else resolve({ result: frame.result, raw: Buffer.byteLength(JSON.stringify(frame)), wire: socket.bytesRead - before })
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  return { ws, profile, frames, request, extensions: ws.extensions, wireBytes: () => socket.bytesRead }
}

/** The largest string inside tool bodies on these rows, in bytes. */
function largestBody(rows: { event: Record<string, unknown> }[]): number {
  let largest = 0
  const walk = (value: unknown, depth = 0): void => {
    if (typeof value === 'string') largest = Math.max(largest, Buffer.byteLength(value))
    else if (value && typeof value === 'object' && depth < 10) {
      if ((value as { omitted?: unknown }).omitted === true) return
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, depth + 1)
    }
  }
  for (const row of rows) {
    const e = row.event
    if (e.type === 'tool-result') walk(e.output)
    else if (e.type === 'tool-call') {
      walk(e.input)
      walk(e.preview)
    }
  }
  return largest
}
function countOmitted(value: unknown, depth = 0): number {
  if (!value || typeof value !== 'object' || depth > 10) return 0
  if ((value as { omitted?: unknown }).omitted === true) return 1
  let n = 0
  for (const v of Object.values(value as Record<string, unknown>)) n += countOmitted(v, depth + 1)
  return n
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const checks: [string, boolean, string][] = []
const check = (name: string, ok: boolean, detail: string): void => {
  checks.push([name, ok, detail])
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
}
const rows: string[][] = []
const row = (scenario: string, local: string, remote: string, note = ''): void => {
  rows.push([scenario, local, remote, note])
}

const local = await connect('local')
const remote = await connect('remote')
await sleep(200)
console.log(`local extensions: "${local.extensions}"; remote extensions: "${remote.extensions}"`)
check('deflate negotiated on remote only', remote.extensions.includes('permessage-deflate') && !local.extensions.includes('permessage-deflate'), `remote="${remote.extensions}" local="${local.extensions}"`)
const hello = remote.frames.find((f) => f.push === 'hello')
console.log(`hello frame on remote: ${hello ? JSON.stringify(hello).slice(0, 120) : 'none'}`)

// 1. session.list
const localList = await local.request('session.list')
const localMetas = localList.result as unknown[]
const remoteList = await remote.request('session.list')
const page = remoteList.result as { sessions: unknown[]; cursor: string | null }
let pages = 1
let walked = page.sessions.length
let remoteListRaw = remoteList.raw
let remoteListWire = remoteList.wire
for (let cursor = page.cursor; cursor; ) {
  const next = await remote.request('session.list', { cursor })
  const p = next.result as { sessions: unknown[]; cursor: string | null }
  pages++
  walked += p.sessions.length
  remoteListRaw += next.raw
  remoteListWire += next.wire
  cursor = p.cursor
}
row('session.list (first page)', `${kb(localList.raw)} raw / ${kb(localList.wire)} wire, ${localMetas.length} metas`, `${kb(remoteList.raw)} raw / ${kb(remoteList.wire)} wire, ${page.sessions.length} metas`, `${pages} pages, ${walked} metas walked`)
check('remote list is a bounded page with a cursor', Array.isArray(page.sessions) && remoteList.raw <= SHELL_PAGE_BYTES + 4 * KIB && (walked === localMetas.length), `${page.sessions.length} of ${walked} metas on page 1 (${kb(remoteList.raw)}), local sends ${localMetas.length} at once`)

// 2. cold open of the busy thread
await local.request('session.subscribe', { sessionId: 'wire-busy' })
await remote.request('session.subscribe', { sessionId: 'wire-busy' })
const localTail = await local.request('session.events', { sessionId: 'wire-busy', afterSeq: 0, tail: 300 })
const localRows = localTail.result as { seq: number; event: Record<string, unknown> }[]
const remoteTail = await remote.request('session.events', { sessionId: 'wire-busy', afterSeq: 0, tail: 300 })
const tail = remoteTail.result as { rows: { seq: number; event: Record<string, unknown> }[]; moreBefore: boolean; reset: boolean }
const omittedCount = tail.rows.reduce((n, r) => n + countOmitted(r.event), 0)
row('cold open (tail 300)', `${kb(localTail.raw)} raw / ${kb(localTail.wire)} wire, ${localRows.length} rows`, `${kb(remoteTail.raw)} raw / ${kb(remoteTail.wire)} wire, ${tail.rows.length} rows`, `${omittedCount} bodies omitted, moreBefore=${tail.moreBefore}`)
check('remote cold open under TAIL_BYTES with no large body', remoteTail.raw <= TAIL_BYTES + 4 * KIB && largestBody(tail.rows) < BODY_OMIT_BYTES, `${kb(remoteTail.raw)}, largest tool body ${largestBody(tail.rows)} B; local's largest ${largestBody(localRows)} B`)
check('remote tail ends where the log ends', tail.rows[tail.rows.length - 1]?.seq === localRows[localRows.length - 1]?.seq, `seq ${tail.rows[tail.rows.length - 1]?.seq}`)

// 3. an older page
const older = await remote.request('session.events', { sessionId: 'wire-busy', afterSeq: 0, beforeSeq: tail.rows[0].seq, tail: 300 })
const olderPage = older.result as { rows: { seq: number }[]; moreBefore: boolean }
row('older page (beforeSeq)', '-', `${kb(older.raw)} raw / ${kb(older.wire)} wire, ${olderPage.rows.length} rows`, `moreBefore=${olderPage.moreBefore}`)
check('older page ends just below the tail', olderPage.rows[olderPage.rows.length - 1]?.seq === tail.rows[0].seq - 1, `seq ${olderPage.rows[olderPage.rows.length - 1]?.seq}`)

// 4. a row fetched whole
const omittedRow = tail.rows.find((r) => r.event.type === 'tool-result' && countOmitted(r.event) > 0)
if (omittedRow) {
  const body = await remote.request('session.rowBody', { sessionId: 'wire-busy', seq: omittedRow.seq })
  const full = (body.result as { row: { event: { output?: unknown } } }).row
  const summary = omittedRow.event.output as { bytes: number; head: string }
  row('session.rowBody', '-', `${kb(body.raw)} raw / ${kb(body.wire)} wire`, `seq ${omittedRow.seq}: summary said ${summary.bytes} B`)
  check('rowBody returns the body whole', typeof full.event.output === 'string' && Buffer.byteLength(full.event.output) === summary.bytes && full.event.output.startsWith(summary.head), `${typeof full.event.output === 'string' ? Buffer.byteLength(full.event.output) : 0} B`)
} else check('an omitted tool result was in the tail', false, 'none found')

// 5. resume: a small gap replays, a large gap resets
const lastSeq = tail.rows[tail.rows.length - 1].seq
const small = await remote.request('session.events', { sessionId: 'wire-busy', afterSeq: lastSeq - 100 })
const smallPage = small.result as { rows: unknown[]; reset: boolean }
const localGap = await local.request('session.events', { sessionId: 'wire-busy', afterSeq: lastSeq - 100 })
row('resume (gap 100)', `${kb(localGap.raw)} raw / ${kb(localGap.wire)} wire`, `${kb(small.raw)} raw / ${kb(small.wire)} wire, ${smallPage.rows.length} rows`, `reset=${smallPage.reset}`)
check('a 100-row gap replays in place', smallPage.rows.length === 100 && !smallPage.reset, `${smallPage.rows.length} rows`)
const large = await remote.request('session.events', { sessionId: 'wire-busy', afterSeq: 10 })
const largePage = large.result as { rows: { seq: number }[]; reset: boolean; moreBefore: boolean }
row('resume (gap to seq 10)', '-', `${kb(large.raw)} raw / ${kb(large.wire)} wire, ${largePage.rows.length} rows`, `reset=${largePage.reset}`)
check('a gap past the budget resets to a tail', largePage.reset && largePage.moreBefore && largePage.rows[largePage.rows.length - 1].seq === lastSeq, `${largePage.rows.length} rows, ${kb(large.raw)}`)

// 6. pushes: a rename moves the meta; the remote socket gets one coalesced sessions frame
local.frames.length = 0
remote.frames.length = 0
const title = 'Wire budgets: the busy thread'
await remote.request('session.rename', { sessionId: 'wire-busy', title: `${title} (probe)` })
await remote.request('session.rename', { sessionId: 'wire-busy', title })
await sleep(400)
const localMeta = local.frames.filter((f) => f.push === 'session').length
const remoteMeta = remote.frames.filter((f) => f.push === 'sessions')
const singular = remote.frames.filter((f) => f.push === 'session').length
row('meta pushes (2 renames)', `${localMeta} session frames`, `${remoteMeta.length} sessions frame(s), ${singular} singular`, remoteMeta.map((f) => (f.sessions as unknown[]).length).join('+') + ' metas')
check('remote metas arrive coalesced', remoteMeta.length >= 1 && singular === 0 && remoteMeta.length < Math.max(localMeta, 2), `${localMeta} singular locally vs ${remoteMeta.length} frame(s) remotely`)

// 7. deflate's effect on the cold open
check('deflate shrinks the remote cold open', remoteTail.wire < remoteTail.raw * 0.5, `${kb(remoteTail.raw)} raw → ${kb(remoteTail.wire)} on the wire (${Math.round((100 * remoteTail.wire) / remoteTail.raw)}%)`)

await local.request('session.unsubscribe', { sessionId: 'wire-busy' })
await remote.request('session.unsubscribe', { sessionId: 'wire-busy' })
local.ws.close()
remote.ws.close()

const widths = [0, 1, 2, 3].map((i) => Math.max(...rows.map((r) => r[i].length), ['scenario', 'local', 'remote', 'note'][i].length))
const line = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join('  ')
console.log('')
console.log(line(['scenario', 'local', 'remote', 'note']))
for (const r of rows) console.log(line(r))
const failed = checks.filter(([, ok]) => !ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
