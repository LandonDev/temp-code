/**
 * What a fresh thread's first model request is made of, per harness and
 * model: the fixed overhead every thread in this project pays before it does
 * anything (docs/agents/prompt-overhead.md has the tables and why).
 *
 * An isolated headless instance of the BUILT tree (electron-vite preview,
 * fresh userData under /tmp/tc-measure-first, TEMP_CODE_REMOTE_PORT=0) with
 * the gateway's shape trace on (TEMP_CODE_GATEWAY_SHAPE=1, gatewayShape.ts),
 * reading this host's own vault read-only (an isolated instance never
 * refreshes a token). A detached worktree of the tree's HEAD is its project,
 * as real threads run, with the house preamble as the project's rules. One
 * thread per model, low effort, each sent "Reply with the word ok and
 * nothing else." The first shape line of each thread's own model is its
 * first request; each part's bytes are scaled to the input tokens the
 * answer reported. One real request per thread.
 *
 * Muse Code has no gateway lane (its CLI talks to Meta itself), so its
 * request is not seen here.
 *
 * Run:   bun run script:measure-first-request -- [--label before] [--write]
 *        [--tree <dir>] [--models claude:claude-sonnet-5-5,codex:gpt-6.1-sol]
 *        [--warm]               warming on; each model runs twice, one after the other,
 *                               so the second thread adopts the first's warm process
 *        [--fresh-codex-home]   a scratch CODEX_HOME with the login and config but no models cache
 * The Codex fallback check (docs/agents/prompt-overhead.md): a first request
 * on fallback model metadata shows as a 258,400 window with every tool inline
 * (`function` tools), the real metadata as 475,000 with tools in code mode.
 * Build the tree first (electron-vite build). Report: /tmp/tc-measure-first/<label>-<host>.md;
 * --write puts it into docs/agents/prompt-overhead.md under "<label> on <host>".
 * Nothing here touches /Applications/TempCode.app, the box's
 * temp-code.service or its data; the instance is stopped by its pids.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { HOUSE_PREAMBLE } from '../src/main/server/projectPreamble'
import { firstRequest, overheadMarkdown, placeSection, shapeRecords, type Measured } from './lib/firstRequest'
import { REPO, prepareEnv, sh, sleep } from './lib/packagedApp'
import { stopTree } from './lib/processTree'

prepareEnv()
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const TREE = resolve(arg('tree') ?? REPO)
const LABEL = arg('label') ?? 'run'
const WRITE = process.argv.includes('--write')
const HOST = process.platform === 'darwin' ? 'the Mac' : 'the box'
const MODELS = (arg('models') ?? 'claude:claude-sonnet-5-5,claude:claude-opus-5-5,codex:gpt-6.1-sol').split(',').map((s) => {
  const [provider, model] = s.split(':')
  return { provider, model }
})
const WARM = process.argv.includes('--warm')
const FRESH_CODEX_HOME = process.argv.includes('--fresh-codex-home')
const OUT = '/tmp/tc-measure-first'
const MESSAGE = 'Reply with the word ok and nothing else.'

if (!existsSync(join(TREE, 'out', 'main', 'index.js'))) {
  console.error(`${TREE}/out/main is missing: run electron-vite build there first`)
  process.exit(2)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
const log = (m: string): void => console.log(`      ${m}`)

// ── the project: a detached worktree of the tree's HEAD, so its CLAUDE.md is the tree's ──
const project = join(OUT, 'project')
await sh(['git', '-C', TREE, 'worktree', 'add', '--detach', project, 'HEAD'], { quiet: true })
const head = (await sh(['git', '-C', project, 'rev-parse', '--short', 'HEAD'], { quiet: true })).trim()

// ── the instance ──
const data = join(OUT, 'data')
mkdirSync(data, { recursive: true })
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  TEMP_CODE_HEADLESS: '1',
  TEMP_CODE_USER_DATA: data,
  TEMP_CODE_REMOTE_PORT: '0',
  TEMP_CODE_GATEWAY_SHAPE: '1',
  TEMP_CODE_GATEWAY_TRACE: '1',
  TEMP_CODE_WORK_ROOT: OUT,
  ...(WARM ? {} : { TEMP_CODE_WARM_HARNESS: '0' }),
  // No shim: every request goes through this instance's own gateway.
  ALIAX_SHIM_PORT: '1'
}
if (FRESH_CODEX_HOME) {
  // The login and config, and nothing Codex cached: no models_cache.json.
  const from = process.env.CODEX_HOME ?? join(process.env.HOME ?? '', '.codex')
  const home = join(OUT, 'codex-home')
  mkdirSync(home, { recursive: true })
  for (const f of ['auth.json', 'config.toml']) if (existsSync(join(from, f))) writeFileSync(join(home, f), readFileSync(join(from, f)))
  env.CODEX_HOME = home
}
delete env.ELECTRON_RUN_AS_NODE
delete env.TEMP_CODE_CLAIM_SHIM
const logFile = join(OUT, 'instance.log')
const logFd = openSync(logFile, 'a')
const proc = Bun.spawn([join(TREE, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: TREE, env, stdout: logFd, stderr: logFd })
let mainPid = 0

const until = async (what: string, ms: number, test: () => Promise<boolean> | boolean): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`timed out: ${what}`)
}

class Local {
  private ws!: WebSocket
  private next = 1
  private pending = new Map<string, { ok: (v: unknown) => void; bad: (e: Error) => void }>()
  async open(): Promise<void> {
    await until('server.json', 90_000, () => existsSync(join(data, 'server.json')))
    const { port, pid } = JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number; pid: number }
    mainPid = pid
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    await new Promise<void>((ok, bad) => {
      this.ws.addEventListener('open', () => ok())
      this.ws.addEventListener('error', () => bad(new Error('socket error')))
    })
    this.ws.addEventListener('message', (event) => {
      const frame = JSON.parse(String(event.data)) as Record<string, unknown>
      const p = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined
      if (!p) return
      this.pending.delete(frame.id as string)
      if (frame.ok) p.ok(frame.result)
      else p.bad(new Error(String(frame.error)))
    })
  }
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = `m${this.next++}`
    return new Promise<T>((ok, bad) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, bad })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {} }))
    })
  }
  close(): void {
    this.ws?.close()
  }
}

type Meta = { id: string; status: string; context?: { tokens: number; window: number | null } | null }
const local = new Local()
const results: Measured[] = []
try {
  await local.open()
  const ws = await local.request<{ id: string }>('workspace.create', { path: project, name: 'measure' })
  const proj = await local.request<{ id: string }>('project.create', { workspaceId: ws.id, name: 'Measure', mode: 'local' })
  await local.request('project.setPreamble', { projectId: proj.id, preamble: HOUSE_PREAMBLE, enabled: true })
  const threads: { provider: string; model: string; id: string; label: string }[] = []
  const all = async (): Promise<Meta[]> => local.request<Meta[]>('session.list')
  const startOne = async (provider: string, model: string, label: string): Promise<string> => {
    const created = await local.request<{ id: string }>('session.create', {
      projectId: proj.id,
      provider,
      model,
      reasoning: 'low',
      threadType: 'chat',
      permission: 'auto',
      title: `measure ${model}`
    })
    await local.request('session.send', { sessionId: created.id, text: MESSAGE })
    threads.push({ provider, model, id: created.id, label })
    log(`${provider} ${model}${label}: ${created.id}`)
    return created.id
  }
  const busy = (m: Meta | undefined): boolean => !!m && ['starting', 'running', 'queued'].includes(m.status)
  for (const { provider, model } of MODELS) {
    const first = await startOne(provider, model, WARM ? ' (cold)' : '')
    if (!WARM) continue
    // The second thread of the shape adopts the warm process the first one's start refilled.
    await until(`${model} settles`, 300_000, async () => !busy((await all()).find((m) => m.id === first)))
    await sleep(10_000)
    const pools = await local.request<{ driver: string; adopted: number }[]>('harness.warm')
    const before = pools.find((p) => p.driver === provider)?.adopted ?? 0
    await startOne(provider, model, ' (warm)')
    await sleep(3_000)
    const after = (await local.request<{ driver: string; adopted: number }[]>('harness.warm')).find((p) => p.driver === provider)?.adopted ?? 0
    log(`${model}: ${after > before ? 'adopted the warm process' : 'did not adopt a warm process'}`)
  }
  const settled = async (): Promise<Meta[]> => {
    const all = await local.request<Meta[]>('session.list')
    return threads.map((t) => all.find((m) => m.id === t.id)!).filter(Boolean)
  }
  await until('every thread settles', 300_000, async () => (await settled()).every((m) => !['starting', 'running', 'queued'].includes(m.status)))
  // The shape line is written when the answer ends; the log reaches its file a moment later.
  await sleep(2_000)
  const records = shapeRecords(readFileSync(logFile, 'utf8'))
  const metas = await settled()
  for (const t of threads) {
    const meta = metas.find((m) => m.id === t.id)
    const record = firstRequest(records, t.id, t.model)
    results.push({ provider: t.provider, model: `${t.model}${t.label}`, record, window: meta?.context?.window ?? null, note: meta?.status === 'error' ? `The thread ended in an error (${meta.status}).` : undefined })
  }
} finally {
  local.close()
  const left = await stopTree([mainPid, proc.pid ?? 0])
  if (left.length) log(`${left.length} process(es) needed SIGKILL`)
  closeSync(logFd)
  if (existsSync('/proc')) {
    const marker = `TEMP_CODE_USER_DATA=${data}`
    for (const entry of readdirSync('/proc')) {
      if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
      try {
        if (readFileSync(`/proc/${entry}/environ`, 'latin1').split('\0').includes(marker)) process.kill(Number(entry), 'SIGKILL')
      } catch {
        /* gone */
      }
    }
  }
  await sh(['git', '-C', TREE, 'worktree', 'remove', '--force', project], { quiet: true }).catch(() => undefined)
}

const versions = await Promise.all(
  [
    ['claude', '--version'],
    ['codex', '--version']
  ].map((cmd) => sh(cmd, { quiet: true }).then((v) => v.trim().split('\n')[0], () => `${cmd[0]} not found`))
)
const heading = `${LABEL}${WARM ? ', warm' : ''}${FRESH_CODEX_HOME ? ', fresh CODEX_HOME' : ''} on ${HOST}`
const body = [
  `${new Date().toISOString().slice(0, 10)}, ${hostname()}, tree ${head}, ${versions.join(', ')}. One thread per model at low effort, its first request.`,
  '',
  ...results.map(overheadMarkdown)
].join('\n')
const report = join(OUT, `${LABEL}-${process.platform}.md`)
writeFileSync(report, `## ${heading}\n\n${body}`)
console.log(`\n## ${heading}\n\n${body}`)
console.log(`report: ${report}`)
if (WRITE) {
  const doc = join(REPO, 'docs', 'agents', 'prompt-overhead.md')
  mkdirSync(join(REPO, 'docs', 'agents'), { recursive: true })
  writeFileSync(doc, placeSection(existsSync(doc) ? readFileSync(doc, 'utf8') : '# What a fresh thread pays before it starts\n', heading, body))
  console.log(`written: ${doc}`)
}
process.exit(results.every((r) => r.record) ? 0 : 1)
