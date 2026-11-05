/**
 * Proof that the renderer soak's synthetic host (scripts/lib/soakHost.ts)
 * delivers its declared load to a client: boots the host in this process,
 * connects one client socket with its operate key the way a paired desktop
 * does (a ticket, `/ws?ticket=…`), subscribes to the three streaming
 * children and watches the master's board, then counts what arrives for
 * 20 s against scripts/lib/soakLoad.ts's rates: every child's meta changes
 * (distinct live-context readings), the text deltas and tool calls of the
 * subscribed children, and the shell step's batch-delta lines. Each must
 * land within 10% of rate × elapsed. With `--scene typing` it also
 * subscribes to the master and counts the live-edit items owned by it and
 * the master's own meta changes (a child settling or resuming, the master's
 * context), and names the fields those changes moved. Exits non-zero on a
 * miss.
 *
 *   bun run script:soak-host-check [-- --scene typing]
 *   (bun --preload scripts/lib/electron-stub.ts scripts/soak-host-check.ts)
 */
import { declaredRates, profileOf, SOAK_PROFILE } from './lib/soakLoad'
import { startSoakHost } from './lib/soakHost'

const WINDOW_MS = 20_000
const typing = process.argv.includes('typing')
const host = await startSoakHost(typing ? 'typing' : 'board')
let failed = false
try {
  const ticket = (await (await fetch(`${host.baseUrl}/api/ticket`, { method: 'POST', headers: { Authorization: `Bearer ${host.key}` } })).json()) as { ticket: string }
  const ws = new WebSocket(`${host.baseUrl.replace('http', 'ws')}/ws?ticket=${ticket.ticket}`)
  const answers = new Map<string, (frame: Record<string, unknown>) => void>()
  let counting = false
  const metas = new Map<string, Set<number>>()
  const rows = { delta: 0, tool: 0 }
  let logLines = 0
  let liveEdits = 0
  let masterMetas = 0
  const masterFields = new Map<string, number>()
  let lastMaster: Record<string, unknown> | null = null
  const subscribed = new Set([host.focusedId, ...host.streamerIds])
  const children = new Set(host.children)
  ws.addEventListener('message', (message) => {
    const frame = JSON.parse(String(message.data)) as Record<string, unknown>
    if (typeof frame.id === 'string') answers.get(frame.id)?.(frame)
    if (frame.push === 'live-edits' || frame.push === 'live-edit') {
      const items = (frame.push === 'live-edits' ? frame.items : [frame]) as { sessionIds: string[] }[]
      if (counting) liveEdits += items.filter((i) => i.sessionIds.includes(host.masterId)).length
      return
    }
    if (frame.push === 'sessions' || frame.push === 'session') {
      const list = (frame.push === 'sessions' ? frame.sessions : [frame.session]) as { id: string; context?: { tokens: number } | null }[]
      // The master's meta: a change is a push that differs from the one before it.
      for (const meta of list) {
        if (meta.id !== host.masterId) continue
        const next = meta as unknown as Record<string, unknown>
        const moved = lastMaster ? Object.keys({ ...lastMaster, ...next }).filter((k) => JSON.stringify(lastMaster![k]) !== JSON.stringify(next[k])) : []
        if (counting && moved.length) {
          masterMetas++
          for (const k of moved) masterFields.set(k, (masterFields.get(k) ?? 0) + 1)
        }
        lastMaster = next
      }
    }
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
  // The window shows the master's chat beside its board: its rows and its live edits reach the socket.
  if (typing) await request('session.events', { sessionId: host.masterId, tail: 1, subscribe: true })
  await request('batch.board', { masterId: host.masterId })
  await request('session.focus', { sessionId: host.focusedId })

  const driver = host.startLoad()
  const start = Date.now()
  const before = driver.counts()
  counting = true
  await Bun.sleep(WINDOW_MS)
  // Let the last coalesced frames (100 ms windows, 250 ms under lag) land, with the load stopped.
  const after = driver.counts()
  driver.stop()
  await Bun.sleep(500)
  counting = false
  const elapsed = (Date.now() - start - 500) / 1000
  ws.close()

  const profile = profileOf(typing ? 'typing' : 'board')
  const rates = declaredRates(profile)
  const subscribedDeltaRate = SOAK_PROFILE.streams.filter((s) => s.kind === 'delta' && s.child !== null).reduce((sum, s) => sum + s.perSecond, 0)
  const childMetaRate = profile.streams.filter((s) => s.kind === 'meta' && s.child !== null).reduce((sum, s) => sum + s.perSecond, 0)
  const masterMetaRate = profile.streams.filter((s) => s.child === null && (s.kind === 'meta' || s.kind === 'settle' || s.kind === 'resume')).reduce((sum, s) => sum + s.perSecond, 0)
  let metaCount = 0
  for (const seen of metas.values()) metaCount += seen.size
  const checks = [
    { what: 'meta changes', got: metaCount, want: childMetaRate * elapsed },
    { what: 'text deltas', got: rows.delta, want: subscribedDeltaRate * elapsed },
    { what: 'tool calls', got: rows.tool, want: rates.tool * elapsed, slack: 1 },
    { what: 'batch-delta lines', got: logLines, want: rates.log * elapsed },
    ...(typing
      ? [
          { what: 'live-edit items', got: liveEdits, want: (rates.edit + rates.flood) * elapsed },
          { what: "the master's meta changes", got: masterMetas, want: masterMetaRate * elapsed }
        ]
      : [])
  ]
  console.log(`window ${elapsed.toFixed(1)} s; the driver emitted ${JSON.stringify(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v - before[k as keyof typeof before]])))}`)
  for (const c of checks) {
    const ok = Math.abs(c.got - c.want) <= Math.max(c.want * 0.1, c.slack ?? 0)
    if (!ok) failed = true
    console.log(`${ok ? '✓' : '✗'} ${c.what}: ${c.got} received, ${c.want.toFixed(1)} declared`)
  }
  if (typing) console.log(`  the master's meta fields that moved: ${JSON.stringify(Object.fromEntries(masterFields))}`)
  if (metas.size !== host.children.length) {
    failed = true
    console.log(`✗ metas came from ${metas.size} of ${host.children.length} children`)
  }
} finally {
  await host.close()
}
process.exit(failed ? 1 : 0)
