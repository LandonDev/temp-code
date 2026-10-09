/**
 * Research-mode exit test (plan-PtGAMHaCrEda): against a live headless
 * server, a claude research thread in a WORKTREE project under Auto-edits
 * runs one small mixed web + codebase question. Checks: the report and
 * every explorer's angle file land under the workspace root (outside the
 * worktree cwd, with no write prompt), explorers are explorer-typed with
 * no worktree and the findings contract in their brief, the spawn result
 * names the findings file, cite_source rows carry claims on the root's
 * board, no web tool asked for approval, and the stdio bridge serves
 * cite_source to a research-tree session and refuses it to a chat.
 * Run: bun run script:e2e-research
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { configure } from 'aliax-core'
import { startServer } from '../src/main/server/index'
import type { AgentEvent, EventRow } from '../src/shared/events'

const root = mkdtempSync(join(tmpdir(), 'tc-research-'))
const wsPath = join(root, 'repo')
mkdirSync(wsPath)
const git = (...args: string[]): string => execFileSync('git', ['-C', wsPath, ...args], { encoding: 'utf8' })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'e2e@temp-code')
git('config', 'user.name', 'e2e')
mkdirSync(join(wsPath, 'src'))
copyFileSync(join(process.cwd(), 'src/main/server/threads.ts'), join(wsPath, 'src/threads.ts'))
git('add', '.')
git('commit', '-q', '-m', 'seed')

// A throwaway vault: no accounts, so claude runs on the CLI's own login,
// and never the user's live gateway shim.
configure({
  dataDir: join(root, 'aliax'),
  fetch: async (url) => {
    throw new Error(`unexpected fetch ${url}`)
  },
  secrets: { mode: 'chromiumKey', keychainItem: 'Test Safe Storage' },
  appName: 'temp-code-e2e'
})
const server = await startServer(join(root, 'app.db'), { claimShim: false })
const registry = server.registry

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const ws = await registry.createWorkspace(wsPath, 'repo')
const project = await registry.createProject(ws.id, 'feature', 'worktree')
check('worktree project runs outside the workspace root', project.cwd !== wsPath, project.cwd)
const reportsDir = join(wsPath, '.temp-code', 'reports')

const research = await registry.create({
  provider: 'claude',
  model: 'claude-sonnet-5-5',
  reasoning: 'low',
  threadType: 'research',
  projectId: project.id,
  permission: 'edits',
  parentId: null
})
check('report path is minted under the workspace root', research.planPath === join(reportsDir, `${research.id}.md`), research.planPath ?? '')

// Every approval request anywhere in the tree is logged and allowed, so a
// stray prompt shows up as a failure without hanging the run.
const approvals: string[] = []
const watched = new Set<string>()
const watch = (id: string): void => {
  if (watched.has(id)) return
  watched.add(id)
  registry.subscribe(id, (row: EventRow) => {
    const e: AgentEvent = row.event
    if (e.type === 'approval-request') {
      approvals.push(`${id}:${e.toolName}`)
      void registry.approve(id, e.requestId, true)
    }
    if (e.type === 'agent-spawned') watch(e.childSessionId)
    if (id === research.id && (e.type === 'tool-call' || e.type === 'error' || e.type === 'status')) {
      console.error('  [root]', JSON.stringify(e).slice(0, 140))
    }
  })
}
watch(research.id)

await registry.send(
  research.id,
  'This is a MECHANICS CHECK: keep it small and do not ask me anything. Spawn exactly two explorers, both on model claude-sonnet-5-5 with reasoning low, in parallel: (1) WEB — what is the latest stable release of the Bun JavaScript runtime and when did it ship; read at most 3 pages. (2) CODEBASE — in this repository, how does src/threads.ts decide where research reports and angle files live (name the functions and the directory layout); cite file paths. Each explorer must call cite_source for every source it uses. Wait for both to settle, read their findings files, and write the report from the files. Two angles is below the done floor, so leave status: in-progress and say why in Limits. Then stop.'
)

const live = (s: string): boolean => s === 'running' || s === 'starting' || s === 'waiting' || s === 'watching'
const deadline = Date.now() + 20 * 60_000
for (;;) {
  await sleep(3000)
  const me = registry.get(research.id)
  const kids = registry.list().filter((s) => s.parentId === research.id)
  const busy = (me && live(me.status)) || kids.some((k) => live(k.status))
  if (!busy && kids.length > 0 && registry.eventsAfter(research.id, 0).some((r) => r.event.type === 'turn-complete')) break
  if (Date.now() > deadline) {
    check('research run finished within 20 minutes', false)
    break
  }
}

// ── the report and the angle files ───────────────────────────────────
const reportPath = research.planPath!
check('report file exists at the workspace root', existsSync(reportPath))
const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : ''
check('report has frontmatter status', /^status:/m.test(reportText), reportText.slice(0, 120).replace(/\n/g, ' | '))
check('report stays in-progress below the floor', /^status:\s*in-progress/m.test(reportText))
check('report has a Limits section', /limits/i.test(reportText))

const kids = registry.list().filter((s) => s.parentId === research.id)
check('two or more explorers were spawned', kids.length >= 2, String(kids.length))
for (const k of kids) {
  const tag = k.title.slice(0, 40)
  check(`[${tag}] is explorer-typed`, k.agentType === 'explorer', k.agentType)
  check(`[${tag}] runs in the project cwd, no worktree`, k.cwd === project.cwd, k.cwd)
  check(`[${tag}] has an angle file beside the report`, (k.planPath ?? '').startsWith(join(reportsDir, research.id) + '/'), k.planPath ?? '')
  const exists = !!k.planPath && existsSync(k.planPath)
  check(`[${tag}] angle file was written`, exists)
  if (exists) {
    const text = readFileSync(k.planPath!, 'utf8')
    check(`[${tag}] angle file has frontmatter status`, /^status:/m.test(text), text.slice(0, 100).replace(/\n/g, ' | '))
  }
  const rows = registry.eventsAfter(k.id, 0)
  const brief = rows.find((r) => r.event.type === 'user-text')
  check(`[${tag}] brief carries the findings contract`, !!brief && (brief.event as { text: string }).text.includes('<findings-file>'))
  const cited = rows.some((r) => r.event.type === 'tool-call' && /cite_source/.test(r.event.name))
  check(`[${tag}] called cite_source`, cited)
}

// ── the board ────────────────────────────────────────────────────────
type Source = Extract<AgentEvent, { type: 'research-source' }>
const sources = registry.eventsAfter(research.id, 0).map((r) => r.event).filter((e): e is Source => e.type === 'research-source')
const urls = new Set(sources.filter((s) => s.url).map((s) => s.url))
const claims = sources.filter((s) => s.claim)
check('sources boarded on the root', urls.size > 0, `${urls.size} urls, ${sources.filter((s) => s.query).length} queries`)
check('citations carry claims', claims.length > 0, claims.slice(0, 3).map((c) => `${c.url} — ${c.claim}`).join(' ; '))
check('a file path was cited for the codebase angle', claims.some((c) => /threads\.ts/.test(c.url ?? '')), claims.map((c) => c.url).join(', '))
const merged = claims.filter((c) => !c.callId.startsWith('cite:'))
console.log(`      ${merged.length} citation(s) merged onto a fetched row, ${claims.length - merged.length} standalone`)
const rootRows = registry.eventsAfter(research.id, 0)
const spawnResult = rootRows.find((r) => r.event.type === 'tool-result' && /findingsFile/.test(r.event.output))
check('spawn result named the findings file', !!spawnResult)
check('no explorer was interrupted', !rootRows.some((r) => r.event.type === 'tool-call' && /interrupt_agent/.test(r.event.name)))

// ── approvals ────────────────────────────────────────────────────────
check('no web or write approval was requested anywhere in the tree', approvals.length === 0, approvals.join(', '))

// ── the stdio bridge ─────────────────────────────────────────────────
async function bridgeSession(sessionId: string): Promise<{ call: (msg: Record<string, unknown>) => Promise<Record<string, unknown>>; kill: () => void }> {
  const proc = spawn(process.execPath, ['scripts/app-mcp-bridge.mjs'], {
    env: { ...process.env, TEMP_CODE_PORT: String(server.port), TEMP_CODE_SESSION: sessionId },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const waiters: ((line: string) => void)[] = []
  createInterface({ input: proc.stdout! }).on('line', (l) => waiters.shift()?.(l))
  const call = (msg: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge timeout')), 15_000)
      waiters.push((line) => {
        clearTimeout(timer)
        resolve(JSON.parse(line))
      })
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    })
  await call({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  return { call, kill: () => proc.kill() }
}
const textOf = (res: Record<string, unknown>): string =>
  (res.result as { content?: { text?: string }[] })?.content?.[0]?.text ?? ''

const inTree = await bridgeSession(kids[0]?.id ?? research.id)
const tools = (await inTree.call({ id: 2, method: 'tools/list' })).result as { tools: { name: string; inputSchema: { properties: { threadType?: { enum?: string[] } } } }[] }
check('bridge lists cite_source', tools.tools.some((t) => t.name === 'cite_source'))
check('bridge app_start_thread offers research', tools.tools.find((t) => t.name === 'app_start_thread')?.inputSchema.properties.threadType?.enum?.includes('research') === true)
const cited = textOf(await inTree.call({ id: 3, method: 'tools/call', params: { name: 'cite_source', arguments: { url: 'https://example.com/bridge', claim: 'the bridge reaches citeSource' } } }))
check('bridge cite_source from a research-tree session lands on the board', cited.startsWith('cited'), cited)
check('the bridged citation is on the root', registry.eventsAfter(research.id, 0).some((r) => r.event.type === 'research-source' && r.event.claim === 'the bridge reaches citeSource'))
inTree.kill()

const chat = await registry.create({ provider: 'codex', threadType: 'chat', projectId: project.id, parentId: null })
const outside = await bridgeSession(chat.id)
const refused = textOf(await outside.call({ id: 4, method: 'tools/call', params: { name: 'cite_source', arguments: { url: 'https://example.com/x', claim: 'nope' } } }))
check('bridge cite_source from a chat is refused', refused.startsWith('refused'), refused)
outside.kill()

console.log(`\nreport: ${reportPath}\nangle files: ${kids.map((k) => k.planPath).join(', ')}`)
await server.close()
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
