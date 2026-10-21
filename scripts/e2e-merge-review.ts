/**
 * Review before merge, end to end (src/main/server/mergeReview.ts). One
 * isolated headless instance of the BUILT tree (out/main) with its own
 * userData, fixed port and work root, driven over its local socket; a
 * scratch repo with a bare origin and a feature branch checked out in a
 * worktree; a project whose review set is on with a claude-haiku-5-5
 * reviewer; and an implementation thread (haiku, full access) told to land
 * its branch with merge_branch. Real turns: both threads talk to the model.
 *
 *   1. the reviewer, stubbed through its brief (TEMP_CODE_REVIEW_STUB_FILE)
 *      to report one CONFIRMED finding → the merge is HELD, the review row
 *      carries the finding, origin/master has not moved, the tool told the
 *      thread "Address these before merging";
 *   2. review.override (the card's Merge anyway) → origin/master is the
 *      branch and the merged-anyway row lands; a second override is refused;
 *   3. a new commit on the branch and a reviewer stubbed to report nothing
 *      → merged and pushed, "Reviewed by Haiku 5.5: no blocking findings";
 *   4. the reviewers sit under the implementation thread, never waiting on
 *      the user; the codex bridge lists merge_branch and report_findings.
 *
 * Nothing here touches the installed app or the user's data: own database,
 * own repo, own threads. The instance uses this user's HOME so the Claude
 * CLI can run. Run: bun scripts/e2e-merge-review.ts   (build first:
 * electron-vite build)
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const REPO = resolve(import.meta.dir, '..')
const KEEP = process.env.TC_MR_KEEP === '1'
let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) {
  console.error('out/main is missing: run electron-vite build first')
  process.exit(2)
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })

const root = (() => {
  const d = mkdtempSync(join(tmpdir(), 'tc-merge-review-'))
  return Bun.spawnSync(['realpath', d]).stdout.toString().trim() || d
})()
const data = join(root, 'data')
const tmp = join(root, 'tmp')
const work = join(root, 'work')
const logFile = join(root, 'app.log')
for (const d of [data, tmp, work]) mkdirSync(d, { recursive: true })

// ── the scratch repo: origin, master, a feature branch in a worktree ──
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'proof',
      GIT_AUTHOR_EMAIL: 'proof@example.invalid',
      GIT_COMMITTER_NAME: 'proof',
      GIT_COMMITTER_EMAIL: 'proof@example.invalid'
    }
  }).trim()
const origin = join(work, 'origin.git')
const repo = join(work, 'repo')
const wt = join(work, 'wt')
git(work, 'init', '--bare', '-b', 'master', origin)
git(work, 'clone', origin, repo)
git(repo, 'checkout', '-b', 'master')
writeFileSync(join(repo, 'sum.js'), 'export const sum = (a, b) => a + b\n')
git(repo, 'add', '.')
git(repo, 'commit', '-m', 'init')
git(repo, 'push', '-u', 'origin', 'master')
git(repo, 'worktree', 'add', '-b', 'feature', wt, 'master')
writeFileSync(join(wt, 'sum.js'), 'export const sum = (a, b) => a + b\nexport const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length\n')
git(wt, 'add', '.')
git(wt, 'commit', '-m', 'feature: add avg')
const head1 = git(wt, 'rev-parse', 'HEAD')
const stubFile = join(root, 'stub.json')

// ── the instance ──────────────────────────────────────────────────────
let proc: ChildProcess | undefined
async function launch(): Promise<void> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    TMPDIR: tmp,
    TEMP_CODE_USER_DATA: data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_REMOTE_PORT: String(await freePort()),
    TEMP_CODE_CLAIM_SHIM: '0',
    TEMP_CODE_WORK_ROOT: work,
    TEMP_CODE_REVIEW_STUB_FILE: stubFile,
    NODE_ENV: 'production'
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = join(REPO, 'node_modules', '.bin', 'electron')
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(logFile, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(logFile, c))
}
const until = async (label: string, ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(400)
  }
  log(`timed out: ${label}`)
  return false
}
const portOf = (): number => (JSON.parse(readFileSync(join(data, 'server.json'), 'utf8')) as { port: number }).port

/** One request on the instance's local socket (the implicit admin). */
async function rpc<T = unknown>(method: string, params: unknown = {}, timeoutMs = 180_000): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf()}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`no answer to ${method}`))
    }, timeoutMs)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 'e2e', method, params })))
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: T; error?: string }
      if (frame.id !== 'e2e') return
      clearTimeout(timer)
      ws.close()
      if (frame.ok) ok(frame.result as T)
      else fail(new Error(frame.error))
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      fail(new Error(`socket error on ${method}`))
    })
  })
}

interface Meta {
  id: string
  cwd: string
  parentId: string | null
  provider: string
  model: string
  status: string
  title: string
  agentType: string
  archived: boolean
}
interface Row {
  seq: number
  event: {
    type: string
    text?: string
    kind?: string
    name?: string
    callId?: string
    output?: string
    isError?: boolean
    delta?: boolean
    status?: string
    review?: Notice
  }
}
interface Notice {
  runId: string
  reviewerId?: string
  outcome: string
  merged: boolean
  pushed: boolean
  blocking: { file: string; line?: number; summary: string }[]
  minor: unknown[]
}
const sessions = (): Promise<Meta[]> => rpc<Meta[]>('session.list')
const events = (sessionId: string): Promise<Row[]> => rpc<Row[]>('session.events', { sessionId, afterSeq: 0 })
const settled = async (sessionId: string, ms: number): Promise<boolean> =>
  until(`${sessionId} settles`, ms, async () => {
    const rows = await events(sessionId)
    const lastUser = rows.map((r, i) => (r.event.type === 'user-text' ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    return rows.slice(lastUser + 1).some((r) => r.event.type === 'turn-complete' || (r.event.type === 'status' && (r.event.status === 'idle' || r.event.status === 'error')))
  })
const notices = async (sessionId: string): Promise<Notice[]> =>
  (await events(sessionId)).filter((r) => r.event.type === 'notice' && r.event.kind === 'review').map((r) => r.event.review!)
const toolResults = (rows: Row[], tool: string): string[] => {
  const calls = new Set(rows.filter((r) => r.event.type === 'tool-call' && (r.event.name ?? '').includes(tool)).map((r) => r.event.callId))
  return rows.filter((r) => r.event.type === 'tool-result' && calls.has(r.event.callId)).map((r) => r.event.output ?? '')
}
const finalText = (rows: Row[]): string =>
  rows.filter((r) => r.event.type === 'assistant-text' && !r.event.delta).map((r) => r.event.text ?? '').join(' ')

/** The codex stdio bridge, as codex would spawn it: tools/list. */
async function bridgeTools(sessionId: string): Promise<string[]> {
  const bridge = spawn(process.execPath, [join(REPO, 'scripts', 'app-mcp-bridge.mjs')], {
    env: { PATH: process.env.PATH ?? '', TEMP_CODE_PORT: String(portOf()), TEMP_CODE_SESSION: sessionId },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  bridge.stdout.on('data', (c: Buffer) => (out += c.toString()))
  const send = (m: unknown): boolean => bridge.stdin.write(JSON.stringify(m) + '\n')
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  await until('bridge tools/list', 20_000, () => out.includes('"id":2'))
  bridge.kill()
  const line = out.split('\n').find((l) => l.includes('"id":2'))
  if (!line) return []
  return ((JSON.parse(line) as { result: { tools: { name: string }[] } }).result.tools ?? []).map((t) => t.name)
}

const cleanup = async (): Promise<void> => {
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
    } catch {
      /* gone */
    }
  }
  await sleep(1500)
  if (proc?.pid) {
    try {
      process.kill(-proc.pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  if (!KEEP) rmSync(root, { recursive: true, force: true })
  else log(`kept ${root}`)
}

try {
  await launch()
  if (!check('the headless instance published its local socket', await until('instance up', 120_000, () => existsSync(join(data, 'server.json'))))) {
    throw new Error(`no server.json; log ${logFile}`)
  }
  const ws = await rpc<{ id: string }>('workspace.create', { path: repo, name: 'merge-review' })
  const project = await rpc<{ id: string; branch: string | null; cwd: string }>('project.create', { workspaceId: ws.id, name: 'Proof', mode: 'local' })
  check('the project is the checkout on master', project.cwd === repo && (project.branch === 'master' || project.branch === null), JSON.stringify(project))
  const settings = { beforeMerge: true, provider: 'claude', model: 'claude-haiku-5-5', reasoning: 'low', blockOn: 'confirmed', maxMinutes: 5 }
  await rpc('review.set', { projectId: project.id, settings })
  const scope = await rpc<{ source: string; settings: { beforeMerge: boolean }; override: unknown; global: unknown }>('review.get', { projectId: project.id })
  check('review.get answers the project override as the effective set', scope.source === 'project' && scope.settings.beforeMerge && scope.override !== null && scope.global === null, JSON.stringify(scope))
  const globalScope = await rpc<{ source: string; settings: { beforeMerge: boolean } }>('review.get', { projectId: null })
  check('the global set is still the default (off)', globalScope.source === 'default' && !globalScope.settings.beforeMerge)

  const impl = await rpc<Meta>('session.create', {
    provider: 'claude',
    model: 'claude-haiku-5-5',
    reasoning: 'low',
    agentType: 'implementer',
    permission: 'auto',
    projectId: project.id,
    threadType: 'implementation',
    title: 'implementer'
  })
  const ask =
    'Proof run. Call the merge_branch tool (from the MCP server named app) right now with {"branch": "feature"}, then reply with its result text verbatim and nothing else. Do not run any git command, do not create a task list, do not read any file.'

  // ── round 1: a blocking finding holds the merge ─────────────────────
  writeFileSync(
    stubFile,
    JSON.stringify({
      findings: [
        {
          file: 'sum.js',
          line: 2,
          summary: 'avg of an empty list divides by zero and answers NaN',
          failure_scenario: 'avg([]) → 0 / 0 → NaN, which every caller then compares against',
          verdict: 'CONFIRMED'
        }
      ]
    })
  )
  await rpc('session.send', { sessionId: impl.id, text: ask })
  check('the implementation turn settled', await settled(impl.id, 400_000))
  const all = await sessions()
  const reviewer1 = all.find((s) => s.parentId === impl.id && s.agentType === 'reviewer')
  check('a reviewer child was spawned under the implementation thread', !!reviewer1, all.map((s) => `${s.agentType}:${s.title}`).join(', '))
  check('the reviewer runs the configured model', reviewer1?.provider === 'claude' && reviewer1?.model === 'claude-haiku-5-5', `${reviewer1?.provider}/${reviewer1?.model}`)
  check('the reviewer is titled by the merge', reviewer1?.title === 'Review: feature → master', reviewer1?.title)
  if (reviewer1) {
    await settled(reviewer1.id, 120_000)
    const rows = await events(reviewer1.id)
    const reported = toolResults(rows, 'report_findings')
    check('the reviewer reported through report_findings', reported.some((t) => t.startsWith('reported 1 finding')), reported.join(' | ').slice(0, 120))
    const brief = rows.find((r) => r.event.type === 'user-text')?.event.text ?? ''
    check(
      'the brief carries the diff against the merge-base, the commits and the implementation brief',
      brief.includes('+export const avg') && brief.includes('feature: add avg') && brief.includes('Proof run.'),
      brief.slice(0, 200)
    )
    check('the reviewer is not left waiting on the user', (await sessions()).find((s) => s.id === reviewer1.id)?.status !== 'waiting')
  }
  const [held] = await notices(impl.id)
  check(
    'the thread got a held row with the finding',
    held?.outcome === 'held' && !held.merged && held.blocking.length === 1 && held.blocking[0].file === 'sum.js' && held.blocking[0].line === 2 && held.reviewerId === reviewer1?.id,
    JSON.stringify(held).slice(0, 200)
  )
  check('origin/master did not move', git(origin, 'rev-parse', 'master') !== head1 && git(repo, 'rev-parse', 'master') !== head1)
  const implRows1 = await events(impl.id)
  const result1 = toolResults(implRows1, 'merge_branch')[0] ?? ''
  check('merge_branch answered HELD with the instruction', result1.startsWith('HELD:') && result1.includes('Address these before merging, then call merge_branch again'), result1.slice(0, 160))
  check('the implementation thread saw the agent-spawned row', implRows1.some((r) => r.event.type === 'agent-spawned'))
  check('the implementer relayed the hold', /held/i.test(finalText(implRows1)), finalText(implRows1).slice(0, 120))

  // ── Merge anyway ─────────────────────────────────────────────────────
  const merged = await rpc<{ sha: string; merged: boolean; pushed: boolean }>('review.override', { sessionId: impl.id, runId: held.runId })
  check('Merge anyway fast-forwarded and pushed', merged.merged && merged.pushed && merged.sha === head1 && git(origin, 'rev-parse', 'master') === head1, JSON.stringify(merged))
  const rows2 = await notices(impl.id)
  check('the merged-anyway row names the run', rows2[1]?.outcome === 'merged-anyway' && rows2[1].runId === held.runId && rows2[1].blocking.length === 1, JSON.stringify(rows2.map((n) => n.outcome)))
  const again = await rpc('review.override', { sessionId: impl.id, runId: held.runId }).then(
    () => '(no error)',
    (e: Error) => e.message
  )
  check('a second override is refused', /no held review/.test(again), again)

  // ── round 2: no findings → merged ────────────────────────────────────
  writeFileSync(join(wt, 'sum.js'), 'export const sum = (a, b) => a + b\nexport const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-m', 'feature: avg of nothing is 0')
  const head2 = git(wt, 'rev-parse', 'HEAD')
  writeFileSync(stubFile, JSON.stringify({ findings: [] }))
  await rpc('session.send', { sessionId: impl.id, text: `${ask} This is the second merge.` })
  check('the second turn settled', await settled(impl.id, 400_000))
  const rows3 = await notices(impl.id)
  const pass = rows3.find((n) => n.outcome === 'pass')
  check('the second review passed and merged', !!pass && pass.merged && pass.pushed && pass.blocking.length === 0, JSON.stringify(rows3.map((n) => n.outcome)))
  check('origin/master is the new head', git(origin, 'rev-parse', 'master') === head2, `${git(origin, 'rev-parse', 'master')} vs ${head2}`)
  const implRows2 = await events(impl.id)
  const result2 = toolResults(implRows2, 'merge_branch').at(-1) ?? ''
  check('merge_branch answered the pass line', result2.startsWith('Reviewed by Haiku 5.5: no blocking findings'), result2.slice(0, 160))
  const reviewers = (await sessions()).filter((s) => s.parentId === impl.id && s.agentType === 'reviewer')
  check('two reviewer threads, both under the implementation thread', reviewers.length === 2)
  check('no reviewer needs the user', reviewers.every((r) => r.status !== 'waiting'), reviewers.map((r) => r.status).join(','))

  // ── the codex bridge offers both tools ───────────────────────────────
  const tools = await bridgeTools(impl.id)
  check('the codex bridge lists merge_branch and report_findings', tools.includes('merge_branch') && tools.includes('report_findings'), tools.join(','))

  // ── archiving the thread hides its reviewers with it ─────────────────
  await rpc('session.archive', { sessionId: impl.id, archived: true })
  const after = await rpc<Meta[]>('session.list', { archived: true })
  check('the implementation thread is archived', after.find((s) => s.id === impl.id)?.archived === true)
  // Children carry no archived flag of their own: they hang off the root
  // and leave the rail with it (the sidebar lists roots).
  check('the live list no longer shows the thread', !(await sessions()).some((s) => s.id === impl.id))
} catch (err) {
  check('no exception', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
  log(`app log: ${logFile}`)
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
