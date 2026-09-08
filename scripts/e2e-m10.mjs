/**
 * M10 smoke: the five second-class providers (grok, opencode, pi, omp, fx)
 * against a running dev instance, reached through its CDP port. For each
 * provider the doctor row and catalog entry are checked, then a session
 * sends one turn: an installed binary must stream and settle, a missing
 * one must fail with a clear error and not stay running.
 *
 *   node scripts/e2e-m10.mjs [cdpPort=9228] [cwd=a throwaway git repo]
 */
import http from 'node:http'
import WebSocket from 'ws'
const PORT = Number(process.argv[2] || 9228)
const CWD = process.argv[3] ?? process.cwd()
let fails = 0
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${n}${d ? ' — ' + d : ''}`); if (!ok) fails++ }
const targets = () => new Promise((res, rej) => http.get({ host: '127.0.0.1', port: PORT, path: '/json' }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => { try { res(JSON.parse(b)) } catch (e) { rej(e) } }) }).on('error', rej))
async function page() { for (let i = 0; i < 90; i++) { try { const p = (await targets()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await new Promise((r) => setTimeout(r, 1000)) } throw new Error('no page') }
const p = await page()
const cdp = new WebSocket(p.webSocketDebuggerUrl); await new Promise((r) => cdp.once('open', r))
let cid = 0; const cpend = new Map()
cdp.on('message', (raw) => { const m = JSON.parse(raw); const q = cpend.get(m.id); if (q) { cpend.delete(m.id); m.error ? q.rej(new Error(JSON.stringify(m.error))) : q.res(m.result) } })
const csend = (method, params = {}) => new Promise((res, rej) => { const id = ++cid; cpend.set(id, { res, rej }); cdp.send(JSON.stringify({ id, method, params })) })
let port = null
for (let i = 0; i < 60 && !port; i++) {
  const r = await csend('Runtime.evaluate', { expression: 'window.api?.getServerPort?.()', awaitPromise: true, returnByValue: true }).catch(() => null)
  port = r?.result?.value ?? null
  if (!port) await new Promise((r) => setTimeout(r, 1000))
}
check('server port from renderer', !!port, String(port))
cdp.close()
const ws = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((r) => ws.once('open', r))
let rid = 0; const pend = new Map(); const pushes = []
ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pend.has(m.id)) { const q = pend.get(m.id); pend.delete(m.id); m.ok ? q.res(m.result) : q.rej(new Error(m.error)) } else pushes.push(m) })
const rpc = (method, params) => new Promise((res, rej) => { const id = `r${++rid}`; pend.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, ...(params ? { params } : {}) })) })

const FIVE = ['grok', 'opencode', 'pi', 'omp', 'fx']
const doctor = await rpc('doctor.get')
for (const id of FIVE) check(`doctor ${id} registered`, !!doctor[id], doctor[id]?.found ? `found ${doctor[id].version ?? doctor[id].path ?? ''}` : doctor[id]?.error ?? JSON.stringify(doctor[id]))
const catalog = await rpc('catalog.get', { refresh: true })
for (const id of FIVE) {
  const found = doctor[id]?.found === true
  const models = catalog[id]?.models
  check(`catalog ${id} ${found ? 'has probed models' : 'has no models'}`, Array.isArray(models) && (found ? models.length > 0 : models.length === 0), `label=${catalog[id]?.label} models=${models?.length}`)
}
check('catalog keeps claude/codex/cursor', ['claude', 'codex', 'cursor'].every((k) => catalog[k]?.models?.length > 0))

// One turn per provider: installed → streams and settles; missing → clear error.
for (const id of FIVE) {
  const found = doctor[id]?.found === true
  const s = await rpc('session.create', { provider: id, cwd: CWD, title: `m10 ${id}` })
  const before = Date.now()
  const done = new Promise((res) => { const t = setInterval(() => { const evs = pushes.filter((m) => m.push === 'event' && m.row?.sessionId === s.id).map((m) => m.row.event).filter(Boolean); const end = evs.find((e) => e.type === 'error' || e.type === 'turn-complete'); if (end) { clearInterval(t); res({ evs, end }) } if (Date.now() - before > 30000) { clearInterval(t); res({ evs, end: null }) } }, 200) })
  await rpc('session.send', { sessionId: s.id, text: 'hello' }).catch((e) => ({ err: e.message }))
  const { end, evs } = await done
  const rows = end ? null : await rpc('session.events', { sessionId: s.id, afterSeq: 0 })
  const final = end ?? rows?.find((r) => r.event.type === 'error' || r.event.type === 'turn-complete')?.event
  const detail = final ? `${final.type}: ${(final.message ?? '').slice(0, 80)}` : `events: ${evs.map((e) => e.type).join(',')}`
  if (found) {
    const all = rows ?? (await rpc('session.events', { sessionId: s.id, afterSeq: 0 }))
    const spoke = all.some((r) => r.event.type === 'assistant-text')
    check(`${id} turn streams and settles`, final?.type === 'turn-complete' && spoke, detail)
  } else {
    check(`${id} turn errors on missing binary`, final?.type === 'error', detail)
  }
  const meta = (await rpc('session.list')).find((m) => m.id === s.id)
  check(`${id} status not stuck running`, meta && meta.status !== 'running' && meta.status !== 'waiting', meta?.status)
}
ws.close()
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS')
process.exit(fails ? 1 : 0)
