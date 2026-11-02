/**
 * Proof that the renderer soak's synthetic host (scripts/lib/soakHost.ts)
 * delivers its declared load to a client: boots the host in this process,
 * connects one client socket with its operate key the way a paired desktop
 * does (a ticket, `/ws?ticket=…`), subscribes to the three streaming
 * children and watches the master's board, then counts what arrives for
 * 20 s against scripts/lib/soakLoad.ts's rates: every child's meta changes
 * (distinct live-context readings), the text deltas and tool calls of the
 * subscribed children, and the shell step's batch-delta lines. Each must
 * land within 10% of rate × elapsed. Exits non-zero on a miss.
 *
 *   bun run script:soak-host-check
 *   (bun --preload scripts/lib/electron-stub.ts scripts/soak-host-check.ts)
 */
import { declaredRates, SOAK_PROFILE } from './lib/soakLoad'
import { startSoakHost } from './lib/soakHost'

const WINDOW_MS = 20_000
const host = await startSoakHost()
let failed = false
try {
  const ticket = (await (await fetch(`${host.baseUrl}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${host.key}` } })).json()) as { ticket: string }
  const ws = new WebSocket(`${host.baseUrl.replace('http', 'ws')}/ws?ticket=${ticket.ticket}`)
  const answers = new Map<string, (frame: Record<string, unknown>) => void>()
  let counting = false
  const metas = new Map<string, Set<number>>()
  const rows = { delta: 0, tool: 0 }
  let logLines = 0
  const subscribed = new Set([host.focusedId, ...host.streamerIds])
  const children = new Set(host.children)
  ws.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data)) as Record<string, unknown>
    if (typeof frame.id === 'string') answers.get(frame.id)?.(frame)
    if (!counting) return
    if (frame.push === 'sessions' || frame.push === 'session') {
      const list = (frame.push === 'sessions' ? frame.sessions : [frame.session]) as { id: string; context?: { tokens: number } | null }[]
      for (const meta of list) {
        if (!children.has(meta.id) || !meta.context) continue
        const seen = metas.get(meta.id) ?? new Set<number>()
        seen.add(meta.context.tokens)
        metas.set(meta.id, seen)
      }
    } else if (frame.push === 'events' || frame.push === 'event') {
      const list = (frame.push === 'events' ? frame.rows : [frame.row]) as { sessionId: string; event: { type: string; delta?: boolean } }[]
      for (const row of list) {
        if (!subscribed.has(row.sessionId)) continue
        if (row.event.type === 'assistant-text' && row.event.delta) rows.delta++
        else if (row.event.type === 'tool-call') rows.tool++
      }
    } else if (frame.push === 'batch-delta') {
      const state = frame.state as { steps: { kind: string; log?: { lines: string[] } }[] }
      for (const step of state.steps) if (step.kind === 'shell') logLines += step.log?.lines.length ?? 0
    }
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('the client socket did not open')))
  })
  let next = 1
  const request = (method: string, params: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const id = `c${next++}`
      answers.set(id, (frame) => {
        answers.delete(id)
        resolve(frame)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })
  for (const sessionId of subscribed) await request('session.events', { sessionId, tail: 1, subscribe: true })
  await request('batch.board', { masterId: host.masterId })
  await request('session.focus', { sessionId: host.focusedId })

  const driver = host.startLoad()
  const start = Date.now()
  const before = driver.counts()
  counting = true
  await Bun.sleep(WINDOW_MS)
  // Let the last coalesced frames (100 ms windows, 250 ms under lag) land.
  const after = driver.counts()
  await Bun.sleep(500)
  counting = false
  const elapsed = (Date.now() - start - 500) / 1000
  ws.close()

  const rates = declaredRates()
  const subscribedDeltaRate = SOAK_PROFILE.streams.filter((s) => s.kind === 'delta' && s.child !== null).reduce((sum, s) => sum + s.perSecond, 0)
  let metaCount = 0
  for (const seen of metas.values()) metaCount += seen.size
  const checks = [
    { what: 'meta changes', got: metaCount, want: rates.meta * elapsed },
    { what: 'text deltas', got: rows.delta, want: subscribedDeltaRate * elapsed },
    { what: 'tool calls', got: rows.tool, want: rates.tool * elapsed, slack: 1 },
    { what: 'batch-delta lines', got: logLines, want: rates.log * elapsed }
  ]
  console.log(`window ${elapsed.toFixed(1)} s; the driver emitted ${JSON.stringify(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k as keyof typeof before]])))}`)
  for (const c of checks) {
    const ok = Math.abs(c.got - c.want) <= Math.max(c.want * 0.1, c.slack ?? 0)
    if (!ok) failed = true
    console.log(`${ok ? '✓' : '✗'} ${c.what}: ${c.got} received, ${c.want.toFixed(1)} declared`)
  }
  if (metas.size !== host.children.length) {
    failed = true
    console.log(`✗ metas came from ${metas.size} of ${host.children.length} children`)
  }
} finally {
  await host.close()
}
process.exit(failed ? 1 : 0)
