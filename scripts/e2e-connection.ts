/**
 * The connection runtime for real (thread K1). Two isolated instances of the
 * BUILT tree (electron-vite preview, fresh userData each, their own debug and
 * remote ports): A is the desktop, B a second host. A's local environment
 * behaves as before (a workspace, a thread, a real turn, the transcript on
 * screen). Then A adds B by key over its local socket (the main process reads
 * B's /api/hello and keeps the key), B's workspace and thread appear in A's
 * stores under B's environment id, A drives a turn on B through its routed
 * link, B is killed and relaunched (same userData, same id) and A reconnects,
 * resumes with afterSeq and shows no duplicate rows, then B's listener moves
 * ports while a turn streams and A catches up once the route is back.
 * Run: bun scripts/e2e-connection.ts   (build first: electron-vite build)
 * Nothing here touches /Applications/TempCode.app or its userData.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Cdp, REPO, attach, prepareEnv, sh, sleep } from './lib/packagedApp'

prepareEnv()
const A = { debug: Number(process.env.TC_K1_A_DEBUG ?? 9224), remote: Number(process.env.TC_K1_A_REMOTE ?? 7681), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-k1a'), log: join(tmpdir(), `tc-k1-a-${process.pid}.log`) }
const B = { debug: Number(process.env.TC_K1_B_DEBUG ?? 9226), remote: Number(process.env.TC_K1_B_REMOTE ?? 7682), data: join(homedir(), 'Library', 'Application Support', 'temp-code-dev-k1b'), log: join(tmpdir(), `tc-k1-b-${process.pid}.log`) }
const B_MOVED = Number(process.env.TC_K1_B_MOVED ?? 7683)
const SHOT = '/tmp/tc-connection-a.png'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): boolean => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
  return ok
}
const log = (m: string): void => console.log(`      ${m}`)

if (!existsSync(join(REPO, 'out', 'renderer', 'index.html'))) {
  console.error('out/renderer is missing: run electron-vite build first')
  process.exit(2)
}
const pidsOn = async (port: number): Promise<number[]> =>
  (await sh(['sh', '-c', `lsof -nP -iTCP:${port} -sTCP:LISTEN -t || true`], { quiet: true }))
    .split('\n')
    .map((s) => Number(s.trim()))
    .filter((n) => n > 0)
for (const port of [A.debug, A.remote, B.debug, B.remote, B_MOVED]) {
  if ((await pidsOn(port)).length) {
    console.error(`port ${port} is in use; pick another with TC_K1_*`)
    process.exit(2)
  }
}
for (const inst of [A, B]) {
  rmSync(inst.data, { recursive: true, force: true })
  mkdirSync(inst.data, { recursive: true })
}

type Inst = typeof A
let procs: ReturnType<typeof Bun.spawn>[] = []
function launch(inst: Inst): ReturnType<typeof Bun.spawn> {
  const env = { ...process.env, TEMP_CODE_USER_DATA: inst.data, TEMP_CODE_DEBUG_PORT: String(inst.debug), TEMP_CODE_REMOTE_PORT: String(inst.remote), TEMP_CODE_REMOTE_TRACE: '1', TEMP_CODE_GATEWAY_TRACE: '0' } as Record<string, string>
  delete env.ELECTRON_RUN_AS_NODE
  const out = Bun.file(inst.log)
  const proc = Bun.spawn([join(REPO, 'node_modules', '.bin', 'electron-vite'), 'preview', '--skipBuild'], { cwd: REPO, env, stdout: out, stderr: out })
  procs.push(proc)
  return proc
}
async function killInstance(inst: Inst): Promise<void> {
  const pids = new Set<number>([...(await pidsOn(inst.debug)), ...(await pidsOn(inst.remote)), ...(await pidsOn(B_MOVED))])
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  await sleep(800)
}
const cleanup = async (): Promise<void> => {
  for (const p of procs) p.kill()
  await killInstance(A)
  await killInstance(B)
}

const until = async (cdp: Cdp, expr: string, ms: number, label: string): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await cdp.eval<boolean>(expr).catch(() => false)) return
    await sleep(250)
  }
  throw new Error(`timed out: ${label}`)
}
const rpc = (cdp: Cdp, env: string, method: string, params: unknown): Promise<unknown> =>
  cdp.eval(`window.__monocode.registry.linkOf(${JSON.stringify(env)}).request(${JSON.stringify(method)}, ${JSON.stringify(params)})`)
const statusOf = (cdp: Cdp, env: string): Promise<{ transport: string; fresh: boolean; attempts: number; nextRetryAt: number | null; lastError: string | null }> =>
  cdp.eval(`(() => { const s = window.__monocode.registry.statusOf(${JSON.stringify(env)}); return { transport: s.transport, fresh: s.fresh, attempts: s.attempts, nextRetryAt: s.nextRetryAt, lastError: s.lastError } })()`) as never
const blockIds = (cdp: Cdp, id: string): Promise<string[]> =>
  cdp.eval(`(window.__monocode.sessionStore.get(${JSON.stringify(id)})?.blocks ?? []).map(b => b.id)`) as never
const metaStatus = (cdp: Cdp, id: string): Promise<string | null> =>
  cdp.eval(`window.__monocode.sessionStore.metaOf(${JSON.stringify(id)})?.status ?? null`) as never
const OPEN_STATUS = ['starting', 'running', 'watching', 'waiting']
/** A turn was just sent: wait for its status push to say it started (up to
 *  15 s), then for it to settle. Reading right after `session.send` sees
 *  the old idle status. */
const settled = async (cdp: Cdp, id: string, ms: number): Promise<string | null> => {
  const start = Date.now() + 15_000
  while (Date.now() < start) {
    const s = await metaStatus(cdp, id)
    if (s && OPEN_STATUS.includes(s)) break
    await sleep(300)
  }
  const end = Date.now() + ms
  let last: string | null = null
  while (Date.now() < end) {
    last = await metaStatus(cdp, id)
    if (last && !OPEN_STATUS.includes(last)) return last
    await sleep(500)
  }
  return last
}
const gitDir = (name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `tc-k1-${name}-`))
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  return dir
}
async function connectWindow(inst: Inst, label: string): Promise<Cdp> {
  const cdp = await attach(inst.debug, 120_000)
  await until(cdp, `!!window.__monocode?.registry?.primary()?.connected`, 60_000, `${label} local socket`)
  await until(cdp, `window.__monocode.registry.statusOf('local').fresh === true`, 60_000, `${label} first list`)
  return cdp
}

launch(A)
launch(B)
try {
  // ── environment zero in A behaves as before ────────────────────────
  const a = await connectWindow(A, 'A')
  const b = await connectWindow(B, 'B')
  log(`A and B up; logs ${A.log} ${B.log}`)
  const aStatus = await statusOf(a, 'local')
  check('A: the local environment is open and fresh with no attempts', aStatus.transport === 'open' && aStatus.fresh && aStatus.attempts === 0, JSON.stringify(aStatus))
  const aEnvs = (await a.eval(`window.__monocode.registry.environments().map(e => e.id)`)) as string[]
  check('A: exactly one environment before any host is added', aEnvs.length === 1 && aEnvs[0] === 'local', aEnvs.join(','))
  const aDir = gitDir('a')
  await sh(['git', 'init', '-q', aDir], { quiet: true })
  const aWs = (await rpc(a, 'local', 'workspace.create', { path: aDir })) as { id: string }
  check('A: workspace.create over the local link', typeof aWs?.id === 'string')
  const aSession = (await rpc(a, 'local', 'session.create', { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', cwd: aDir, workspaceId: aWs.id, threadType: 'chat', agentType: 'implementer', title: 'A local thread' })) as { id: string }
  check('A: session.create over the local link', typeof aSession?.id === 'string')
  await until(a, `window.__monocode.sessionStore.metaOf(${JSON.stringify(aSession.id)})?.environmentId === 'local'`, 10_000, 'A sees its own session stamped local')
  check('A: the session meta carries environmentId local', true)
  await a.eval(`window.__monocode.sessionStore.requestOpen(${JSON.stringify(aSession.id)})`)
  await until(a, `window.__monocode.sessionStore.get(${JSON.stringify(aSession.id)})?.loaded === true`, 20_000, 'A opens its thread')
  await rpc(a, 'local', 'session.send', { sessionId: aSession.id, text: 'Reply with exactly: LOCAL-OK' })
  const aEnd = await settled(a, aSession.id, 150_000)
  const aBlocks = await blockIds(a, aSession.id)
  check('A: a local turn folds into the open transcript', aBlocks.length >= 1, `status ${aEnd}, ${aBlocks.length} blocks`)
  const aText = (await a.eval(`document.body.innerText`)) as string
  check('A: the transcript is on screen', aText.includes('LOCAL-OK') || aText.includes('A local thread'), aEnd === 'idle' ? 'reply painted' : `turn ended ${aEnd}`)

  // ── B is a host with a key, a workspace and a thread ───────────────
  const bHello = (await b.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  const bKey = (await rpc(b, 'local', 'remote.keys.create', { name: 'A (e2e)', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })) as { key: { id: string }; token: string }
  check('B: issues a key over its local link', typeof bKey?.token === 'string' && bKey.token.startsWith('tc_'))
  const bDir = gitDir('b')
  await sh(['git', 'init', '-q', bDir], { quiet: true })
  const bWs = (await rpc(b, 'local', 'workspace.create', { path: bDir })) as { id: string }
  const bSession = (await rpc(b, 'local', 'session.create', { provider: 'claude', model: 'claude-sonnet-5-5', reasoning: 'low', cwd: bDir, workspaceId: bWs.id, threadType: 'chat', agentType: 'implementer', title: 'B thread one' })) as { id: string }
  check('B: has a workspace and a thread of its own', typeof bWs?.id === 'string' && typeof bSession?.id === 'string')

  // ── A adds B by key; the main process keeps the key ────────────────
  const saved = (await rpc(a, 'local', 'remote.environments.add', { url: `http://127.0.0.1:${B.remote}`, key: bKey.token, name: 'B' })) as { id: string; routes: { url: string; kind: string }[] }
  check('A: remote.environments.add returns the saved host under B\'s own environment id', saved?.id === bHello, `${saved?.id} vs ${bHello}`)
  check('A: the saved route is the fixed port socket on loopback', saved?.routes?.[0]?.url === `ws://127.0.0.1:${B.remote}/ws` && saved.routes[0].kind === 'loopback', JSON.stringify(saved?.routes))
  const listed = (await rpc(a, 'local', 'remote.environments.list', {})) as unknown[]
  check('A: the list never carries the key', !JSON.stringify(listed).includes(bKey.token.split('.')[1] ?? '@@'))
  await a.eval(`window.__monocode.loadSavedEnvironments()`)
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'open'`, 30_000, 'A connects to B with a ticket')
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).fresh === true`, 30_000, 'A lists B')
  const envB = await statusOf(a, bHello)
  check('A: B is open and fresh under its id', envB.transport === 'open' && envB.fresh, JSON.stringify(envB))
  const bRouteUrl = (await a.eval(`window.__monocode.registry.linkOf(${JSON.stringify(bHello)}).transport.url`)) as string
  check('A: the socket to B rode a single-use ticket', /\?ticket=/.test(bRouteUrl), bRouteUrl.replace(/ticket=.*/, 'ticket=…'))
  await until(a, `window.__monocode.sessionStore.metas().some(m => m.id === ${JSON.stringify(bSession.id)} && m.environmentId === ${JSON.stringify(bHello)})`, 15_000, 'B\'s thread in A\'s store')
  check('A: B\'s thread is in the session store, stamped with B\'s environment', true)
  const bWsInA = (await a.eval(`!!(window.__app ? null : true) && document.body.innerText.includes(${JSON.stringify(bDir.split('/').pop())})`)) as boolean
  log(`B's workspace folder ${bWsInA ? 'shows' : 'does not show'} in A's chrome (the rail lists folders by name)`)
  const envsInA = (await a.eval(`window.__monocode.registry.environments().map(e => e.id)`)) as string[]
  check('A: two environments, local first', envsInA.length === 2 && envsInA[0] === 'local' && envsInA[1] === bHello, envsInA.join(','))

  // ── A drives a turn on B through the routed link, then opens the transcript ──
  await a.eval(`window.__monocode.sessionStore.requestOpen(${JSON.stringify(bSession.id)})`)
  await until(a, `window.__monocode.sessionStore.get(${JSON.stringify(bSession.id)})?.loaded === true`, 20_000, 'A opens B\'s thread')
  await rpc(a, bHello, 'session.send', { sessionId: bSession.id, text: 'Reply with exactly: REMOTE-ONE' })
  const bEnd = await settled(a, bSession.id, 150_000)
  const before = await blockIds(a, bSession.id)
  check('A: a turn sent to B over B\'s link folds into A\'s view of the transcript', before.length >= 1, `status ${bEnd}, ${before.length} blocks`)
  await b.eval(`window.__monocode.sessionStore.ensureLoaded(${JSON.stringify(bSession.id)}, 'e2e')`)
  await until(b, `window.__monocode.sessionStore.get(${JSON.stringify(bSession.id)})?.loaded === true`, 20_000, 'B loads its own thread')
  const bOwn = await blockIds(b, bSession.id)
  check('A and B agree on the transcript', JSON.stringify(before) === JSON.stringify(bOwn), `${before.length} vs ${bOwn.length} blocks`)

  // ── kill B: A keeps the registration and its data, and reconnects when B is back ──
  await killInstance(B)
  await until(a, `['reconnecting','connecting'].includes(window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport)`, 20_000, 'A notices B is gone')
  const down = await statusOf(a, bHello)
  check('A: B reads reconnecting with a retry scheduled and fresh false', down.transport === 'reconnecting' && !down.fresh && down.nextRetryAt !== null, JSON.stringify(down))
  const kept = (await a.eval(`window.__monocode.sessionStore.metas().filter(m => m.environmentId === ${JSON.stringify(bHello)}).length`)) as number
  check('A: B\'s sessions stay in the store while B is down', kept >= 1, `${kept} metas`)
  const stillThere = (await a.eval(`window.__monocode.registry.environments().some(e => e.id === ${JSON.stringify(bHello)})`)) as boolean
  check('A: the registration survives the disconnect', stillThere)
  await sleep(3_000)
  const grew = await statusOf(a, bHello)
  check('A: attempts grow while B is down (backoff is on)', grew.attempts >= 1, `attempts ${grew.attempts}, next in ${grew.nextRetryAt ? Math.round((grew.nextRetryAt - Date.now()) / 1000) : '?'} s`)
  launch(B)
  const b2 = await connectWindow(B, 'B (relaunched)')
  const bHello2 = (await b2.eval(`window.__monocode.registry.statusOf('local').lastHello.environmentId`)) as string
  check('B: keeps its environment id across the restart', bHello2 === bHello)
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'open' && window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).fresh`, 90_000, 'A reconnects to B and re-lists')
  const back = await statusOf(a, bHello)
  check('A: reconnected to B and fresh again', back.transport === 'open' && back.fresh, JSON.stringify(back))
  await sleep(1_500)
  const after = await blockIds(a, bSession.id)
  check('A: the resumed transcript has the same rows, none duplicated', JSON.stringify(after) === JSON.stringify(before) && new Set(after).size === after.length, `${after.length} blocks`)
  const dupMetas = (await a.eval(`window.__monocode.sessionStore.metas().filter(m => m.id === ${JSON.stringify(bSession.id)}).length`)) as number
  check('A: B\'s thread is listed once', dupMetas === 1, `${dupMetas}`)
  await sleep(31_000)
  const steady = await statusOf(a, bHello)
  check('A: the backoff count resets after the session stays up', steady.attempts === 0, `attempts ${steady.attempts}`)

  // ── a dropped socket mid-stream: B's listener moves ports while a turn runs ──
  await rpc(a, bHello, 'session.send', { sessionId: bSession.id, text: 'Reply with exactly: REMOTE-TWO' })
  await sleep(700)
  await rpc(b2, 'local', 'remote.settings.set', { port: B_MOVED })
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'reconnecting'`, 20_000, 'A sees the socket drop')
  check('A: the socket to B dropped mid-turn and A is reconnecting', true)
  await sleep(2_500)
  await rpc(b2, 'local', 'remote.settings.set', { port: B.remote })
  await until(a, `window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).transport === 'open' && window.__monocode.registry.statusOf(${JSON.stringify(bHello)}).fresh`, 90_000, 'A is back on B')
  const end2 = await settled(a, bSession.id, 150_000)
  await sleep(1_500)
  const aFinal = await blockIds(a, bSession.id)
  // B's own shell unloads a thread no pane shows; load it again to compare.
  await b2.eval(`window.__monocode.sessionStore.ensureLoaded(${JSON.stringify(bSession.id)}, 'e2e')`)
  await until(b2, `window.__monocode.sessionStore.get(${JSON.stringify(bSession.id)})?.loaded === true`, 20_000, 'B reloads its thread')
  const bFinal = await blockIds(b2, bSession.id)
  check('A: after the drop, A\'s view of the turn equals B\'s own, with no duplicate rows', JSON.stringify(aFinal) === JSON.stringify(bFinal) && new Set(aFinal).size === aFinal.length, `status ${end2}; A ${aFinal.length} blocks, B ${bFinal.length}`)
  check('A: the second turn added rows after the resume', aFinal.length > before.length, `${before.length} → ${aFinal.length}`)

  // ── removal clears B's data; a screenshot of A closes the proof ────
  const shot = (await a.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
  writeFileSync(SHOT, Buffer.from(shot.data, 'base64'))
  log(`screenshot of A: ${SHOT}`)
  await rpc(a, 'local', 'remote.environments.remove', { id: bHello })
  await a.eval(`window.__monocode.loadSavedEnvironments()`)
  await until(a, `!window.__monocode.registry.environments().some(e => e.id === ${JSON.stringify(bHello)})`, 10_000, 'A forgets B')
  const left = (await a.eval(`window.__monocode.sessionStore.metas().filter(m => m.environmentId === ${JSON.stringify(bHello)}).length`)) as number
  check('A: explicit removal clears B\'s sessions from the store', left === 0, `${left} left`)
  a.close()
  b2.close()
} catch (err) {
  console.error('ERROR', err instanceof Error ? err.message : err)
  failures++
} finally {
  await cleanup()
}
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
