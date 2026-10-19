/**
 * Seed an isolated userData with the wire regression workload, so a dev
 * instance on it has a busy thread (large tool outputs, diffs, reads,
 * writes, html renders with real pages on disk), a fleet of subagents and
 * a shell of hundreds of threads to paint and to probe over the socket:
 *
 *   bun run script:seed-wire -- --user-data "$HOME/Library/Application Support/temp-code-wire-dev" --reset
 *
 * Then launch the app on that dir (TEMP_CODE_USER_DATA) and run
 * scripts/wire-remote-probe.ts against its port. Never point this at the
 * installed app's userData.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb, Store } from '../src/main/server/db'
import { busyRows, meta, rng, words } from '../src/main/server/wireWorkload'
import { HTML_RENDERS_DIR } from '../src/shared/assets'
import { HTML_RENDER_SHOWN_MESSAGE } from '../src/shared/htmlRender'
import type { SessionMeta } from '../src/shared/events'

const args = process.argv.slice(2)
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback
}
const userData = resolve(flag('user-data', join(homedir(), 'Library', 'Application Support', 'temp-code-wire-dev')))
const rows = Number(flag('rows', '2000'))
const fleet = Number(flag('fleet', '200'))
const shell = Number(flag('shell', '800'))
const cwd = resolve(flag('cwd', process.cwd()))
if (/\/temp-code$/.test(userData) || userData.endsWith('temp-code-dev')) {
  console.error(`refusing to seed ${userData}: that is a real app's data`)
  process.exit(1)
}
if (args.includes('--reset')) rmSync(userData, { recursive: true, force: true })
mkdirSync(userData, { recursive: true })
const dbPath = join(userData, 'temp-code.db')
if (existsSync(dbPath) && !args.includes('--reset')) {
  console.error(`${dbPath} exists; pass --reset to start over`)
  process.exit(1)
}

const db = openDb(dbPath)
const store = new Store(db)
const now = Date.now()
const r = rng(20261019)

store.insertWorkspace({ id: 'w1', name: 'temp-code-wire', path: cwd, git: true, createdAt: now - 10_000 })
store.insertProject({
  id: 'p1',
  workspaceId: 'w1',
  name: 'temp-code-wire',
  mode: 'local',
  branch: 'wire-budgets',
  cwd,
  archived: false,
  createdAt: now - 10_000
})

const base = (id: string, patch: Partial<SessionMeta>): SessionMeta =>
  meta(id, { projectId: 'p1', workspaceId: 'w1', cwd, createdAt: now - 9_000, updatedAt: now - 1_000, ...patch })

// The busy thread. Its html renders get real pages on disk, so the local
// renderer paints them through the asset scheme.
const BUSY = 'wire-busy'
store.insertSession(base(BUSY, { title: 'Wire budgets: the busy thread', status: 'idle', updatedAt: now }))
const pagesDir = join(userData, HTML_RENDERS_DIR, BUSY)
mkdirSync(pagesDir, { recursive: true })
let pages = 0
const events = busyRows(r, rows)
for (let i = 0; i < events.length; i++) {
  const e = events[i]
  if (e.type !== 'tool-call' || e.name !== 'mcp__app__html_render') continue
  const pageId = randomBytes(12).toString('base64url')
  const title = `Seeded page ${++pages}`
  const input = e.input as Record<string, unknown>
  const html = `<!doctype html><html><head><style>
    body { font-family: -apple-system, system-ui, sans-serif; color: #ddd; margin: 0; padding: 16px }
    table { border-collapse: collapse; width: 100% } td, th { border-bottom: 1px solid #444; padding: 6px 8px; text-align: left }
    .note { color: #888; font-size: 12px; margin-top: 12px }
  </style></head><body>
    <h2 style="margin:0 0 12px">${title}</h2>
    <table><tr><th>scenario</th><th>local</th><th>remote</th></tr>
    <tr><td>cold open</td><td>1,355 KiB</td><td>275 KiB</td></tr>
    <tr><td>shell page</td><td>1,321 KiB</td><td>256 KiB</td></tr>
    <tr><td>50 outputs</td><td>2,550 KiB</td><td>11 KiB</td></tr></table>
    <p class="note">${words(r, 400)}</p>
  </body></html>`
  writeFileSync(join(pagesDir, `${pageId}.html`), html)
  input.html = html
  input.title = title
  const result = events[i + 1]
  if (result?.type === 'tool-result' && result.callId === e.callId) {
    result.output = JSON.stringify({
      htmlRender: { sessionId: BUSY, pageId, title, height: 320 },
      message: HTML_RENDER_SHOWN_MESSAGE
    })
  }
}
for (const e of events) store.appendEvent(BUSY, e)

// The fleet: an orchestrator with `fleet` settled subagents and short logs.
const ROOT = 'wire-orchestrator'
store.insertSession(
  base(ROOT, { threadType: 'orchestration', agentType: 'orchestrator', title: 'Wire budgets: the fleet', status: 'idle', updatedAt: now - 500 })
)
for (let i = 0; i < fleet; i++) {
  const id = `wire-agent-${i}`
  store.insertSession(
    base(id, {
      parentId: ROOT,
      threadType: null,
      agentType: i % 3 === 0 ? 'explorer' : 'implementer',
      title: `Subagent ${i}: ${words(r, 8)}`,
      status: i % 9 === 4 ? 'error' : 'done',
      provider: i % 2 ? 'codex' : 'claude',
      model: i % 2 ? 'gpt-6.1-sol' : 'claude-sonnet-5-5',
      updatedAt: now - 60_000 + i
    })
  )
  store.appendEvent(id, { type: 'user-text', text: `Task ${i}: ${words(r, 20)}` })
  for (let k = 0; k < 6; k++) store.appendEvent(id, { type: 'assistant-text', text: words(r, 30), delta: false })
  store.appendEvent(id, { type: 'turn-complete', costUsd: 0.01 })
}

// The shell: `shell` root threads, half archived, a few failed.
for (let i = 0; i < shell; i++) {
  const id = `wire-thread-${i}`
  store.insertSession(
    base(id, {
      title: words(r, 4 + Math.floor(r() * 8)),
      status: i % 7 === 3 ? 'error' : i % 3 === 0 ? 'done' : 'idle',
      archived: i % 2 === 1,
      threadType: (['implementation', 'planning', 'chat', 'research'] as const)[i % 4],
      updatedAt: now - 3_600_000 - i * 1_000,
      createdAt: now - 3_700_000 - i * 1_000
    })
  )
  store.appendEvent(id, { type: 'user-text', text: `${words(r, 12)}` })
  store.appendEvent(id, { type: 'assistant-text', text: words(r, 40), delta: false })
  store.appendEvent(id, { type: 'turn-complete', costUsd: 0.02 })
}
store.flushEvents()
db.close()
console.log(
  `seeded ${userData}: ${BUSY} with ${events.length} rows and ${pages} html pages, ${fleet} subagents under ${ROOT}, ${shell} shell threads (project p1 at ${cwd})`
)
