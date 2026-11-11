/**
 * Computer use through the Mac bridge, for real (docs/box.md "Computer use
 * from a box thread"; plan .temp-code/plan-hnG2lARYTPxP.md §11): an isolated
 * box instance on the box and an isolated Mac instance on the Mac, paired
 * over an SSH tunnel, a box thread's computer calls landing on the Mac's
 * tc-computer and its screenshots streamed back to the box.
 *
 * One script, two roles:
 *  - the orchestrator, on the Mac (anywhere else it prints `skipped: macOS
 *    only`): waits while another computer proof runs on the Mac (one at a
 *    time), builds tc-computer, the probe and TC Probe (the sessions proof's
 *    scratch app, scripts/mac/computer-probe-app.swift: its window is never
 *    key and takes no keystrokes), launches it in the background with its own
 *    pid, starts the box half over SSH and a headless Mac instance whose
 *    TC Probe queries are pinned to that pid (TEMP_CODE_COMPUTER_PIN), and
 *    runs the checks, each only on an unlocked, awake screen (AX sees no
 *    window on a locked one); there is no idle gate, and a window that comes
 *    forward is noted, not a stop;
 *  - `--box-half --port <p> --seed <hex>`, on the box: its own instance on
 *    that port, an admin key, two threads; one line `{ ready, envId, key,
 *    threads, root }` on stdout (the SSH channel: the key never reaches a file
 *    or a log), then `{ id, method, params }` lines on stdin answered `{ id,
 *    result | error }` from its local socket, plus `digest`, `bridge`,
 *    `timed` (a request timed around its own socket call), `ping`, `sink`
 *    (the link's round trip and upload rate), `logTail` and `quit`.
 *
 * The timing leg (docs/computer-protocol.md "What the bridge costs") runs the
 * same calls from a box thread and from a thread of the Mac instance in
 * interleaved pairs and judges the difference by BRIDGE_TIMING_RULE
 * (scripts/lib/computerBridgeTiming.ts): in `--gate` and in the full mode.
 *
 * No model turn: every computer call is the box thread's `app.computer` with
 * its computer token. Tiers ax and process only; no session-tier action is
 * ever sent, every window stays in the background, so it runs at any time.
 * Nothing touches /Applications/TempCode.app, the box's temp-code.service, a
 * real HOME or the person's apps.
 *
 * Run on the Mac, in a clone of the branch with `TEMP_CODE_REQUIRE_NATIVE=1
 * electron-vite build` done on both hosts:
 *   TC_BOX_SSH="ssh -i ~/.orbstack/ssh/id_ed25519 box" TC_BOX_CLONE=<the box's clone> bun run script:e2e-computer-bridge
 * TC_BOX_BUN names bun on the box (default /srv/agents/home/.bun/bin/bun);
 * TC_BOX_REPORT_DIR where the report is copied there.
 */
import { gateScreenSkip, parseMacScreen, readyMacScreen } from './lib/macScreen'
import { coverWord, probeCover, type CoverWindow } from './lib/windowCover'
import { spawn, type ChildProcess, execFileSync } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'

import { proofDescendants } from './lib/proofProcesses'
import { cleanupProbeApp } from './lib/tcProbeApp'
import { COMPUTER_PROOF_ENV, sweepComputerProofProcesses } from './lib/computerProofProcesses'
import { bridgeCancelledProbeRead, bridgeHasOneRemoteNote, bridgeHeldId, bridgeProbeEnvironment, bridgeProbePing, waitForBridgeProofCall } from './lib/computerBridgeProof'
import { shortHostName } from '../src/shared/hostNames'
import { BRIDGE_TIMING_RULE, judgeBridgeTiming, median, timingTable, type TimingKind, type TimingSample } from './lib/computerBridgeTiming'
import { parseTimingLine } from '../src/shared/computer/bridgeTiming'
import { proofElectron } from './lib/proofElectron'
import { waitForGateBuild } from './lib/gateBuild'
import { computerProofMode, computerProofPolicy, requireGateNative, waitForComputerProof } from './lib/computerProofGate'

const GATE = computerProofMode(process.argv).gate
if (GATE) process.env.TC_PROOF_UNGATED = '1'
const REPO = resolve(import.meta.dir, '..')
/** TEMP_CODE_COMPUTER_HELD_MS for both instances: the held answer at 3 s, computer_result's wait 3 s, the unread cancel at 8 s. */
const HELD_SEAM = '3000,3000,8000'
const HELD = /^(Held after|Still held, )/
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const freePort = (): Promise<number> =>
  new Promise((ok) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => ok(port))
    })
  })
const until = async (ms: number, test: () => Promise<boolean> | boolean): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await Promise.resolve(test()).catch(() => false)) return true
    await sleep(250)
  }
  return false
}
/** The token a thread's bridge carries: HMAC of `<purpose>:<sessionId>` under the instance's seed (macTools.ts MacThreadTokens). */
const tokenFor = (seed: string, purpose: 'mac-bridge' | 'computer', sessionId: string): string =>
  createHmac('sha256', Buffer.from(seed, 'hex')).update(`${purpose}:${sessionId}`).digest('base64url')

// ── one isolated instance of the built tree (scripts/e2e-mac-bridge.ts's recipe) ──

interface Inst {
  name: string
  home: string
  data: string
  tmp: string
  log: string
  proc?: ChildProcess
}
function mkInst(root: string, name: string): Inst {
  const inst = { name, home: join(root, `${name}-home`), data: join(root, `${name}-data`), tmp: join(root, `${name}-tmp`), log: join(root, `${name}.log`) }
  for (const d of [inst.home, inst.data, inst.tmp]) mkdirSync(d, { recursive: true })
  return inst
}
function launch(inst: Inst, extra: Record<string, string>): void {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: inst.home,
    TMPDIR: inst.tmp,
    TEMP_CODE_USER_DATA: inst.data,
    TEMP_CODE_HEADLESS: '1',
    TEMP_CODE_WARM_HARNESS: '0',
    TEMP_CODE_ALIAX_DATA_DIR: join(inst.data, 'aliax'),
    TEMP_CODE_CLAIM_SHIM: '0',
    AGENT_CLI_CREDENTIAL_STORE: 'file',
    NODE_ENV: 'production',
    SHELL: '/bin/bash',
    ...COMPUTER_PROOF_ENV,
    ...extra
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TEMP_CODE_DEBUG_PORT
  const electron = proofElectron(REPO)
  const argv =
    process.platform === 'linux'
      ? ['xvfb-run', '-a', '-s', '-screen 0 1280x800x24 -nolisten tcp', 'dbus-run-session', '--', electron, '.']
      : [electron, '.']
  const proc = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
  proc.once('error', (error) => appendFileSync(inst.log, `launch failed: ${error.message}\n`))
  proc.stdout?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  proc.stderr?.on('data', (c: Buffer) => appendFileSync(inst.log, c))
  inst.proc = proc
}
const logOf = (inst: Inst): string => (existsSync(inst.log) ? readFileSync(inst.log, 'utf8') : '')
const portOf = (inst: Inst): number => (JSON.parse(readFileSync(join(inst.data, 'server.json'), 'utf8')) as { port: number }).port
async function rpc<T = unknown>(inst: Inst, method: string, params: unknown = {}): Promise<T> {
  const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
  return new Promise<T>((ok, fail) => {
    const timer = setTimeout(() => {
      ws.close()
      fail(new Error(`${inst.name}: no answer to ${method}`))
    }, 600_000)
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
      fail(new Error(`${inst.name}: socket error on ${method}`))
    })
  })
}
function kill(inst: Inst): void {
  const pid = inst.proc?.pid
  if (!pid) return
  // Some utility and CLI children use their own groups. Read their ancestry
  // while the Electron parent still exists, before killing its group.
  let descendants: number[] = []
  try { descendants = proofDescendants(execFileSync('ps', ['-Ao', 'pid=,ppid='], { encoding: 'utf8' }), pid) } catch { /* group cleanup still follows */ }
  for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
    for (const child of descendants) {
      try { process.kill(child, sig) } catch { /* gone */ }
    }
    try { process.kill(-pid, sig) } catch { /* gone */ }
  }
}


// ── the box half ────────────────────────────────────────────────────────

/**
 * One socket to an instance for every app.computer call: a call that answered
 * "Held" stays pending on its socket until computer_result reads it, and a
 * closed socket cancels it (computer/pending.ts), so the calls cannot each
 * open and close their own as rpc() does.
 */
function persistentRpc(inst: Inst): <T = unknown>(method: string, params: unknown) => Promise<T> {
  let opening: Promise<WebSocket> | null = null
  const waiting = new Map<string, (frame: { ok?: boolean; result?: unknown; error?: string }) => void>()
  let n = 0
  const open = (): Promise<WebSocket> =>
    (opening ??= new Promise<WebSocket>((ok, fail) => {
      const ws = new WebSocket(`ws://127.0.0.1:${portOf(inst)}/`)
      ws.addEventListener('open', () => ok(ws))
      ws.addEventListener('error', () => fail(new Error(`${inst.name}: socket error`)))
      ws.addEventListener('close', () => {
        opening = null
        for (const answer of waiting.values()) answer({ ok: false, error: `${inst.name}: the socket closed` })
        waiting.clear()
      })
      ws.addEventListener('message', (ev) => {
        const frame = JSON.parse(String(ev.data)) as { id?: string; ok?: boolean; result?: unknown; error?: string }
        if (typeof frame.id !== 'string') return
        waiting.get(frame.id)?.(frame)
        waiting.delete(frame.id)
      })
    }))
  return async <T,>(method: string, params: unknown): Promise<T> => {
    const ws = await open()
    const id = `p${++n}`
    return await new Promise<T>((ok, fail) => {
      waiting.set(id, (frame) => (frame.ok ? ok(frame.result as T) : fail(new Error(frame.error))))
      ws.send(JSON.stringify({ id, method, params }))
    })
  }
}

async function boxHalf(): Promise<void> {
  const port = Number(arg('--port'))
  const seed = arg('--seed') ?? ''
  if (!Number.isInteger(port) || !/^[0-9a-f]{64}$/.test(seed)) throw new Error('--box-half needs --port <n> and --seed <64 hex>')
  if (!existsSync(join(REPO, 'out', 'main', 'index.js'))) throw new Error('out/main is missing on the box: run electron-vite build first')
  const root = mkdtempSync(join(tmpdir(), 'tc-computer-bridge-box-'))
  const box = mkInst(root, 'box')
  const quit = (): void => {
    kill(box)
    rmSync(root, { recursive: true, force: true })
    process.exit(0)
  }
  process.on('SIGTERM', quit)
  process.on('SIGINT', quit)
  process.once('exit', () => { kill(box); rmSync(root, { recursive: true, force: true }) })
  // Entered as root and dropped to agents, the shell keeps root's XDG_RUNTIME_DIR and an AppArmor context
  // where Electron falls back to its setuid sandbox and aborts: this isolated test instance runs without either.
  const runtime = process.env.XDG_RUNTIME_DIR
  if (runtime && process.getuid && !runtime.endsWith(`/${process.getuid()}`)) delete process.env.XDG_RUNTIME_DIR
  launch(box, {
    ...(arg('--pair') === 'local' ? { TEMP_CODE_BUILD_PLATFORM: 'linux' } : {}),
    TEMP_CODE_REMOTE_PORT: String(port),
    TEMP_CODE_MAC_TOKEN_SEED: seed,
    TEMP_CODE_E2E_STATUS: '1',
    // a held call answers at 3 s, computer_result waits 3 s, a pending call nobody reads goes at 8 s (the held leg)
    TEMP_CODE_COMPUTER_HELD_MS: HELD_SEAM,
    // one `[computer-bridge] timing` line per call, which the timing leg reads back through logTail
    TEMP_CODE_COMPUTER_TRACE: '1',
    ELECTRON_DISABLE_SANDBOX: '1'
  })
  if (!(await until(120_000, () => existsSync(join(box.data, 'server.json'))))) {
    console.log(JSON.stringify({ ready: false, error: 'the box instance did not start', log: logOf(box).slice(-2_000) }))
    return quit()
  }
  const { environmentId } = await rpc<{ environmentId: string }>(box, 'remote.status')
  const key = await rpc<{ token: string }>(box, 'remote.keys.create', { name: 'Studio', audience: 'client', caps: ['read', 'operate', 'approve', 'admin'] })
  const cwd = join(box.home, 'work')
  mkdirSync(cwd, { recursive: true })
  const threads: string[] = []
  for (const title of ['computer bridge e2e 1', 'computer bridge e2e 2'])
    threads.push((await rpc<{ id: string }>(box, 'session.create', { provider: 'claude', cwd, title, threadType: 'chat' })).id)
  console.log(JSON.stringify({ ready: true, envId: environmentId, key: key.token, threads, root }))
  const persistent = persistentRpc(box)
  const sessions = new Map<string, BridgeSession>()
  let sessionSeq = 0

  // Each request runs on its own, answered by id: a call held on the Mac never holds up the pause or Stop that ends it.
  const handle = async (req: { id: number; method: string; params: Record<string, unknown> }): Promise<void> => {
    const answer = (out: { result: unknown } | { error: string }): void => console.log(JSON.stringify({ id: req.id, ...out }))
    try {
      if (req.method === 'digest') {
        const path = resolve(String(req.params.path))
        if (!path.startsWith(root + sep)) throw new Error("refused: not under the box half's root")
        const bytes = readFileSync(path)
        answer({ result: { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length } })
      } else if (req.method === 'bridge') {
        answer({ result: await stdioBridge(seed, String(req.params.sessionId), String(req.params.images), req.params.request as Record<string, unknown>, portOf(box)) })
      } else if (req.method === 'bridge.open') {
        // one bridge process kept for several requests, as codex keeps it for a thread
        const key = `b${++sessionSeq}`
        sessions.set(key, await BridgeSession.open(seed, String(req.params.sessionId), String(req.params.images), portOf(box)))
        answer({ result: key })
      } else if (req.method === 'bridge.ask') {
        const session = sessions.get(String(req.params.key))
        if (!session) throw new Error('no such bridge session')
        answer({ result: await session.ask(String(req.params.method), req.params.params ?? {}) })
      } else if (req.method === 'bridge.close') {
        sessions.get(String(req.params.key))?.close()
        sessions.delete(String(req.params.key))
        answer({ result: null })
      } else if (req.method === 'timed') {
        // the bridged side's boundary: this host's own request, timed here, so the SSH channel is outside it
        const t0 = performance.now()
        const result = await persistent(String(req.params.method), req.params.params)
        answer({ result: { ms: performance.now() - t0, answer: result } })
      } else if (req.method === 'ping') {
        answer({ result: null })
      } else if (req.method === 'sink') {
        answer({ result: String(req.params.data ?? '').length })
      } else if (req.method.startsWith('app.computer')) {
        answer({ result: await persistent(req.method, req.params) })
      } else if (req.method === 'log') {
        answer({ result: logOf(box) })
      } else if (req.method === 'logTail') {
        const text = logOf(box)
        answer({ result: { text: text.slice(Number(req.params.from ?? 0)), end: text.length } })
      } else {
        answer({ result: await rpc(box, req.method, req.params) })
      }
    } catch (err) {
      answer({ error: err instanceof Error ? err.message : String(err) })
    }
  }
  for await (const line of createInterface({ input: process.stdin })) {
    let req: { id: number; method: string; params: Record<string, unknown> }
    try {
      req = JSON.parse(line)
    } catch {
      continue
    }
    if (req.method === 'quit') {
      console.log(JSON.stringify({ id: req.id, result: null }))
      break
    }
    void handle(req)
  }
  quit()
}

/** scripts/app-mcp-bridge.mjs as codex spawns it for the thread, initialized, kept for as many requests as the proof asks. */
class BridgeSession {
  private readonly answers = new Map<number, unknown>()
  private next = 0

  private constructor(private readonly child: ChildProcess) {
    let buf = ''
    child.stdout!.on('data', (c: Buffer) => {
      buf += c.toString()
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const msg = JSON.parse(buf.slice(0, nl)) as { id: number; result?: unknown; error?: unknown }
        buf = buf.slice(nl + 1)
        this.answers.set(msg.id, msg.result ?? msg.error)
      }
    })
  }

  static async open(seed: string, sessionId: string, images: string, local: number): Promise<BridgeSession> {
    const child = spawn(process.execPath, [join(REPO, 'scripts', 'app-mcp-bridge.mjs')], {
      env: {
        PATH: process.env.PATH ?? '',
        TEMP_CODE_PORT: String(local),
        TEMP_CODE_SESSION: sessionId,
        TEMP_CODE_MAC_TOKEN: tokenFor(seed, 'mac-bridge', sessionId),
        TEMP_CODE_COMPUTER_TOKEN: tokenFor(seed, 'computer', sessionId),
        TEMP_CODE_COMPUTER_IMAGES: images
      },
      stdio: ['pipe', 'pipe', 'inherit']
    })
    const session = new BridgeSession(child)
    await session.ask('initialize', { protocolVersion: '2025-03-26' })
    return session
  }

  async ask(method: string, params: unknown): Promise<unknown> {
    const id = ++this.next
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    const end = Date.now() + 300_000
    while (!this.answers.has(id) && Date.now() < end) await sleep(50)
    const answer = this.answers.get(id)
    this.answers.delete(id)
    return answer
  }

  close(): void {
    this.child.kill()
  }
}

/** One request through a fresh bridge process: initialize, the request, the process gone. */
async function stdioBridge(seed: string, sessionId: string, images: string, request: Record<string, unknown>, local: number): Promise<unknown> {
  const session = await BridgeSession.open(seed, sessionId, images, local)
  try {
    return await session.ask(String(request.method), request.params ?? {})
  } finally {
    session.close()
  }
}

// ── the orchestrator, on the Mac ────────────────────────────────────────

type Outcome = 'passed' | 'failed' | 'skipped'
interface AppComputerAnswer {
  text: string
  isError: boolean
  images: { label: string; data: string; mimeType: string; width: number; height: number }[]
}
interface BridgeRequest {
  id: string
  kind: string
  sessionId: string
  status: string
  computer?: { app: string; window: string | null; actions: string[] }
  held?: { reason: string; position: number }
}

async function orchestrator(): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log('skipped: macOS only')
    return
  }
  const screenSkip = gateScreenSkip(GATE, REPO)
  if (screenSkip) {
    console.log(screenSkip)
    process.exit(0)
  }

  const WORK = '/tmp/tc-computer-bridge'
  const REPORT = join(WORK, 'report.json')
  const NONCE = randomBytes(4).toString('hex')
  const SEED = randomBytes(32).toString('hex')
  const BIN = join(REPO, 'resources/native/tc-computer')
  const PROBE = join(WORK, 'computer-proof-probe')
  // Every call names the window as well: TC Probe's is never main, so a call naming none finds no window.
  const APP = 'TC Probe'
  const PROBE_APP = join(WORK, `${APP}.app`)
  const PROBE_BUNDLE_ID = 'dev.landon.tempcode.computer-bridge-probe'
  if (GATE) await waitForGateBuild({ tree: REPO, log: console.log })
  await waitForComputerProof(console.log)
  sweepComputerProofProcesses(console.log)
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  console.log('tiers ax and process only, TC Probe in the background; no idle gate, no model turn')

  const report = {
    startedAt: new Date().toISOString(),
    finishedAt: '',
    checks: [] as { name: string; outcome: Outcome; at: string; detail?: string }[],
    steps: [] as string[],
    bounce: null as string | null,
    stopped: null as string | null,
    screenWaits: [] as { at: string; ms: number }[],
    timing: null as null | { mode: 'gate' | 'full'; roundTripMs: number | null; uploadMbps: number | null; samples: TimingSample[]; table: string; failures: string[] }
  }
  let failures = 0
  const check = (name: string, ok: boolean | 'skipped', detail = ''): boolean => {
    const outcome: Outcome = ok === 'skipped' ? 'skipped' : ok ? 'passed' : 'failed'
    if (outcome === 'failed') failures++
    report.checks.push({ name, outcome, at: new Date().toISOString(), ...(detail ? { detail } : {}) })
    console.log(`${outcome === 'passed' ? 'PASS' : outcome === 'failed' ? 'FAIL' : 'SKIP'}  ${name}${detail && outcome !== 'passed' ? ` — ${detail}` : ''}`)
    return outcome === 'passed'
  }
  const saveReport = (): void => writeFileSync(REPORT, JSON.stringify({ ...report, finishedAt: new Date().toISOString() }, null, 2))

  // the box half over SSH, its local socket forwarded to this Mac
  const sshWords = (process.env.TC_BOX_SSH || 'ssh box').split(/\s+/).filter(Boolean)
  const localPair = computerProofMode(process.argv).localPair
  const clone = process.env.TC_BOX_CLONE
  if (!localPair && !clone) throw new Error('TC_BOX_CLONE names the clone of this branch on the box')
  const boxBun = process.env.TC_BOX_BUN || '/srv/agents/home/.bun/bin/bun'
  const boxPort = localPair ? await freePort() : 20_000 + Math.floor(Math.random() * 20_000)
  const tunnel = localPair ? boxPort : await freePort()

  let scratchPid = 0
  const macRoot = mkdtempSync(join(tmpdir(), 'tc-computer-bridge-mac-'))
  const mac = mkInst(macRoot, 'mac')
  let ssh: ChildProcess | null = null
  const pending = new Map<number, (out: { result?: unknown; error?: string }) => void>()
  let nextId = 0
  const boxCall = <T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise<T>((ok, fail) => {
      const id = ++nextId
      pending.set(id, (out) => (out.error !== undefined ? fail(new Error(out.error)) : ok(out.result as T)))
      ssh?.stdin?.write(JSON.stringify({ id, method, params }) + '\n')
    })

  const cleanup = async (): Promise<void> => {
    if (ssh) await Promise.race([boxCall('quit').catch(() => null), sleep(5_000)])
    ssh?.kill()
    kill(mac)
    cleanupProbeApp({ app: PROBE_APP, binary: join(PROBE_APP, 'Contents/MacOS', APP), bundleId: PROBE_BUNDLE_ID }, scratchPid)
    scratchPid = 0
    saveReport()
    copyFiles(mac)
    rmSync(macRoot, { recursive: true, force: true })
    for (const name of readdirSync(WORK)) if (name !== 'report.json' && name !== 'mac-trace.log') rmSync(join(WORK, name), { recursive: true, force: true })
  }
  const copyFiles = (inst: Inst): void => {
    writeFileSync(join(WORK, 'mac-trace.log'), logOf(inst).split('\n').filter((l) => /\[computer\]|\[mac-bridge\]/.test(l)).join('\n'))
    if (localPair) return
    const dir = process.env.TC_BOX_REPORT_DIR || '/srv/agents/work/temp-code/.temp-code/computer-bridge/mac'
    const host = sshWords[sshWords.length - 1]
    const opts = sshWords.slice(1, -1)
    try {
      execFileSync(sshWords[0], [...opts, host, `mkdir -p ${dir} && chmod 1777 ${dir}`], { stdio: 'pipe', timeout: 30_000 })
      execFileSync('scp', [...opts, REPORT, join(WORK, 'mac-trace.log'), `${host}:${dir}/`], { stdio: 'pipe', timeout: 60_000 })
      console.log(`      report copied to ${host}:${dir}`)
    } catch (err) {
      console.log(`      the report stays here, not copied: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const stop = async (why: string): Promise<never> => {
    console.log(`STOP  ${why}`)
    report.stopped = why
    await cleanup()
    process.exit(1)
  }

  process.once('exit', () => {
    ssh?.kill()
    kill(mac)
    if (scratchPid) { try { process.kill(scratchPid, 'SIGKILL') } catch { /* gone */ } }
  })
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
    report.stopped = `received ${signal}`
    void cleanup().finally(() => process.exit(1))
  })

  try {
  // ── setup: tc-computer, the probe, the grants, TC Probe ──
  const { buildTcComputer } = await import('./lib/tcComputerBuild')
  if (GATE) requireGateNative(REPO)
  buildTcComputer({ root: REPO, require: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', PROBE, join(REPO, 'scripts/mac/computer-proof-probe.swift')], { stdio: 'pipe' })
  execFileSync('codesign', ['-s', '-', '--force', PROBE], { stdio: 'pipe' })
  const frontmost = (): { pid: number; bundleId: string | null } => JSON.parse(execFileSync(PROBE, ['frontmost'], { encoding: 'utf8', timeout: 10_000 }))
  /** Why a check on what TC Probe draws cannot be judged now (it is covered or off screen), or null (windowCover.ts). */
  const probeCovered = (): string | null => coverWord(probeCover(JSON.parse(execFileSync(PROBE, ['windows'], { encoding: 'utf8', timeout: 10_000 })) as CoverWindow[], scratchPid))
  const screenReady = (): boolean => {
    // a passwordless screen saver is dismissed and read again (macScreen.ts readyMacScreen)
    const screen = readyMacScreen(() => parseMacScreen(execFileSync(PROBE, ['screen'], { encoding: 'utf8', timeout: 10_000 })))
    return !!screen && !screen.locked && !screen.asleep && !screen.saver
  }
  /** AX sees no window on a locked or dark screen: wait for it to be unlocked and awake (at most 90 minutes), else stop. */
  const awaitScreen = async (): Promise<void> => {
    if (screenReady()) return
    if (GATE) throw new Error('gate proof needs an unlocked, awake Mac')
    const t0 = Date.now()
    console.log('      the Mac is locked or dark; waiting for it')
    if (!(await until(90 * 60_000, screenReady))) await stop('not run: the Mac stayed locked or dark for 90 minutes')
    report.screenWaits.push({ at: new Date().toISOString(), ms: Date.now() - t0 })
  }
  const grants = JSON.parse(execFileSync(BIN, ['permissions'], { encoding: 'utf8' })) as { accessibility: boolean; screenRecording: boolean }
  if (!grants.accessibility) await stop('Accessibility is off for the session holder (TempCode.app from Publish): turn it on under System Settings → Privacy & Security → Accessibility, then run this again')
  const policy = computerProofPolicy(GATE, grants)
  const pictures = policy.pictures
  if (policy.settings.length) {
    const sql = 'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);' + policy.settings.map(([k, v]) => `INSERT OR REPLACE INTO settings VALUES ('${k}', '${v}');`).join('')
    execFileSync('/usr/bin/sqlite3', [join(mac.data, 'temp-code.db')], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] })
  }
  if (!pictures) console.log('      Screen Recording is off: every step runs but the picture checks')

  mkdirSync(join(PROBE_APP, 'Contents/MacOS'), { recursive: true })
  execFileSync('xcrun', ['swiftc', '-O', '-o', join(PROBE_APP, 'Contents/MacOS', APP), join(REPO, 'scripts/mac/computer-probe-app.swift')], { stdio: 'pipe' })
  writeFileSync(
    join(PROBE_APP, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${PROBE_BUNDLE_ID}</string>
  <key>CFBundleName</key><string>${APP}</string>
  <key>CFBundleExecutable</key><string>${APP}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`
  )
  execFileSync('codesign', ['-s', '-', '--force', PROBE_APP], { stdio: 'pipe' })
  await awaitScreen()
  const probePids = (): number[] => {
    try {
      return execFileSync('pgrep', ['-f', `${PROBE_APP}/Contents/MacOS/`], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
    } catch {
      return []
    }
  }
  const personBefore = frontmost()
  execFileSync('open', ['-n', '-g', PROBE_APP], { env: bridgeProbeEnvironment() })
  for (let i = 0; i < 40 && !scratchPid; i++) {
    await sleep(250)
    scratchPid = probePids()[0] ?? 0
  }
  if (!scratchPid) await stop('open -n gave no TC Probe pid within 10 s')
  await sleep(1_000)
  // The person accepts a scratch window coming forward; it is noted, and their app put back.
  if (!GATE && frontmost().pid === scratchPid) {
    report.bounce = 'TC Probe came to the front at launch'
    if (personBefore.bundleId)
      try {
        execFileSync('osascript', ['-e', `tell application id "${personBefore.bundleId}" to activate`])
      } catch {
        /* noted only */
      }
  }

  // ── the box half ──
  // The Mac's key may log in as root, and Electron refuses to run as root: the half runs as the agents user then.
  const half = `${boxBun} scripts/e2e-computer-bridge.ts --box-half --port ${boxPort} --seed ${SEED}`
  const boxCommand = `cd ${clone} && if [ "$(id -u)" = 0 ]; then exec runuser -u agents -- env HOME=/srv/agents/home ${half}; else exec ${half}; fi`
  ssh = localPair ? spawn(process.execPath, [join(REPO, 'scripts/e2e-computer-bridge.ts'), '--box-half', '--pair', 'local', '--port', String(boxPort), '--seed', SEED], { cwd: REPO, stdio: ['pipe', 'pipe', 'inherit'] }) : spawn(sshWords[0], [...sshWords.slice(1, -1), '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${tunnel}:127.0.0.1:${boxPort}`, sshWords[sshWords.length - 1], boxCommand], {
    stdio: ['pipe', 'pipe', 'inherit']
  })
  ssh.once('error', (error) => {
    for (const answer of pending.values()) answer({ error: `box half: ${error.message}` })
    pending.clear()
  })
  type ReadyLine = { ready: boolean; envId: string; key: string; threads: [string, string]; root: string; error?: string; log?: string }
  const halfLine: { ready: ReadyLine | null } = { ready: null }
  createInterface({ input: ssh.stdout! }).on('line', (line) => {
    let msg: { id?: number; ready?: boolean; result?: unknown; error?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.ready !== undefined) halfLine.ready = msg as ReadyLine
    else if (msg.id !== undefined) pending.get(msg.id)?.(msg)
  })
  await until(180_000, () => halfLine.ready !== null)
  if (!halfLine.ready?.ready) await stop(`the box half did not come up: ${halfLine.ready?.error ?? 'no ready line'}${halfLine.ready?.log ? `\n--- the box instance's log, its end ---\n${halfLine.ready.log}` : ''}`)
  const { envId: boxId, key, threads, root: boxRoot } = halfLine.ready as ReadyLine
  const [t1, t2] = threads
  const token = (sid: string): string => tokenFor(SEED, 'computer', sid)
  let callSeq = 0
  /** One call over the box's kept socket; a call held past the seam's 3 s is read on with computer_result until it answers. */
  const callThrough = async (sid: string, tool: string, args: Record<string, unknown>, images: 'parts' | 'none'): Promise<AppComputerAnswer> => {
    let answer = await boxCall<AppComputerAnswer>('app.computer', { sessionId: sid, token: token(sid), call: ++callSeq, tool, args, images })
    const id = answer.text.match(/computer_result with id "(c\d+)"/)?.[1]
    while (id && HELD.test(answer.text))
      answer = await boxCall<AppComputerAnswer>('app.computer', { sessionId: sid, token: token(sid), call: ++callSeq, tool: 'computer_result', args: { id }, images })
    return answer
  }
  const computer = (sid: string, tool: string, args: Record<string, unknown>, images: 'parts' | 'none' = 'parts'): Promise<AppComputerAnswer> => {
    const safeArgs = policy.observeArgs(args)
    policy.assertRequest(tool, safeArgs)
    return waitForBridgeProofCall(
      callThrough(sid, tool, safeArgs, images),
      {
        standing: async () => {
          const call = (await macActivity()).calls.find((c) => c.environmentId === boxId && c.sessionId === sid && c.status === 'held')
          return call ? JSON.stringify(call.held) : null
        },
        log: console.log
      }
    ).then((a) => {
      report.steps.push(...a.text.split('\n').filter((l) => / · (ax|process|session)\b/.test(l)))
      return a
    })
  }
  const tools = (sid: string): Promise<{ tools: { name: string; description: string }[] }> => boxCall('app.computerTools', { sessionId: sid, token: token(sid) })
  const sessionsOnBox = async (): Promise<{ threadId: string; macPeer?: string; macName?: string; apps: { name: string }[]; running: { words: string } | null; asking?: { line: string } }[]> =>
    (await boxCall<{ sessions: never[] }>('computer.sessions', {})).sessions
  /** The box thread's own status line, as the rail, the board and the phone read it. */
  const detailOnBox = async (sid: string): Promise<string | null> => {
    const page = await boxCall<{ sessions?: { id: string; statusDetail?: string | null }[] } | { id: string; statusDetail?: string | null }[]>('session.list', {})
    return (Array.isArray(page) ? page : (page.sessions ?? [])).find((m) => m.id === sid)?.statusDetail ?? null
  }

  // ── the Mac instance, headless, computer use on, TC Probe pinned to its pid ──
  launch(mac, {
    TEMP_CODE_REMOTE_PORT: '0',
    TEMP_CODE_COMPUTER: '1',
    TEMP_CODE_COMPUTER_PIN: `${APP}=${scratchPid},${PROBE_BUNDLE_ID}=${scratchPid}`,
    TEMP_CODE_COMPUTER_TRACE: '1',
    TEMP_CODE_COMPUTER_BIN: BIN,
    TEMP_CODE_COMPUTER_HELD_MS: HELD_SEAM,
    // the timing leg's Mac-local thread calls app.computer with its own token, and is marked running
    TEMP_CODE_MAC_TOKEN_SEED: SEED,
    TEMP_CODE_E2E_STATUS: '1'
  })
  if (!(await until(120_000, () => existsSync(join(mac.data, 'server.json'))))) await stop(`the Mac instance did not start; log ${mac.log}`)
  const macId = (await rpc<{ environmentId: string }>(mac, 'remote.status')).environmentId
  // The host announces its short name; the pairing key's label is not its name.
  const macName = shortHostName(hostname())
  await rpc(mac, 'remote.environments.add', { url: `http://127.0.0.1:${tunnel}`, key, name: 'box' })
  const registered = await until(60_000, async () => (await rpc<{ registered: boolean }[]>(mac, 'macBridge.policy.get'))[0]?.registered === true)
  if (!check('the Mac registered on the box over the tunnel', registered)) await stop('no registration')
  await rpc(mac, 'macBridge.policy.set', { environmentId: boxId, policy: 'read' })
  for (const sid of threads) await boxCall('macBridge.thread.set', { sessionId: sid, macPeer: macId })
  await boxCall('session.permission', { sessionId: t1, permission: 'auto' })
  await boxCall('session.permission', { sessionId: t2, permission: 'auto' })
  await boxCall('session.markStatus', { sessionId: t1, status: 'running' })
  const macPending = (): Promise<BridgeRequest[]> => rpc<BridgeRequest[]>(mac, 'macBridge.pending')
  const macActivity = (): Promise<{ calls: (BridgeRequest & { environmentId: string })[] }> => rpc(mac, 'macBridge.activity')
  const macCalls = (sid: string): number => logOf(mac).split('\n').filter((l) => l.includes(`thread=${sid} mac.computer `)).length

    // 1. off
    await awaitScreen()
    check('off: the box lists no computer tools', (await tools(t1)).tools.length === 0)
    const off = await computer(t1, 'computer_observe', { app: APP, window: APP })
    check('off: a call answers the switch line', off.isError && off.text.includes('computer use is off for this host'), off.text)

    // 2. on
    await awaitScreen()
    await rpc(mac, 'macBridge.computer.set', { environmentId: boxId, on: true })
    const offered = await until(5_000, async () => (await tools(t1)).tools.length === 5)
    check('on: within 5 s the box lists the four tools and computer_result', offered)
    const listed = await tools(t1)
    check('on: only computer_apps ends with the bridge note', bridgeHasOneRemoteNote(listed.tools), JSON.stringify(listed.tools.map((t) => ({ name: t.name, description: t.description }))))
    check("on: the box kept the Mac's offer", (await boxCall<string>('log')).includes(`${macId}: computer use offered`))

    // 3. observe
    await awaitScreen()
    const seen = await computer(t1, 'computer_observe', { app: APP, window: APP, screenshot: true })
    check('observe: the header names the scratch window', !seen.isError && seen.text.includes(`window "${APP}"`), seen.text.slice(0, 300))
    const shotLine = seen.text.split('\n').find((l) => l.startsWith('screenshot 1 (observation): '))
    if (pictures) {
      const path = shotLine?.match(/^screenshot 1 \(observation\): (\S+) \((\d+)×(\d+)\)/)
      check("observe: one shot line names a file under the box thread's attachments", !!path && path[1].startsWith(boxRoot) && path[1].includes('/computer/'), shotLine ?? '')
      check('observe: one image part', seen.images.length === 1)
      if (path && seen.images[0]) {
        const box = await boxCall<{ sha256: string; size: number }>('digest', { path: path[1] })
        const bytes = Buffer.from(seen.images[0].data, 'base64')
        check('observe: the image part is the box file, byte for byte', createHash('sha256').update(bytes).digest('hex') === box.sha256 && bytes.length === box.size)
        check('observe: its size matches the line', String(seen.images[0].width) === path[2] && String(seen.images[0].height) === path[3])
      }
    } else check('observe: the picture checks', 'skipped', 'Screen Recording is off')
    const activity = await macActivity()
    check(
      "observe: the Mac lists one computer call running for the box's thread",
      activity.calls.filter((c) => c.kind === 'computer' && c.environmentId === boxId && c.sessionId === t1 && c.status === 'running').length === 1,
      JSON.stringify(activity.calls)
    )
    const row = (await sessionsOnBox()).find((r) => r.threadId === t1)
    check("observe: the box's row names the Mac and TC Probe", row?.macPeer === macId && row?.macName === macName && row.apps[0]?.name === APP, JSON.stringify(row))

    // 4. act
    await awaitScreen()
    const field = seen.text.match(/\[(\d+)\] input\b/)?.[1]
    const ping = seen.text.match(/\[(\d+)\] button "Ping"/)?.[1]
    if (!field || !ping) await stop('the scratch window shows no input or Ping button')
    const set = await computer(t1, 'computer_act', { app: APP, window: APP, action: 'set_value', element: Number(field), value: `Lunch ${NONCE}?` })
    check('act: set_value runs at ax and changes the window', !set.isError && /set_value .* · ax · changed/.test(set.text), set.text.slice(0, 300))
    // The act's own answer already carried the change, so a plain read would be "no changes": read the whole tree.
    const after = await computer(t1, 'computer_observe', { app: APP, window: APP, full: true })
    check('act: the observation shows the value', after.text.includes(`Lunch ${NONCE}?`), after.text.slice(0, 300))

    // 4b. timing: the same calls from a box thread and a Mac thread, interleaved pairs, each timed by its own host's request
    await awaitScreen()
    {
      // loopback (both halves on this Mac, as in --gate) is judged by the gate bound; over SSH by the run's own round trip
      const mode = localPair ? 'gate' : 'full'
      const macThread = (await rpc<{ id: string }>(mac, 'session.create', { provider: 'claude', cwd: mac.home, title: 'computer bridge timing', threadType: 'chat' })).id
      await rpc(mac, 'session.permission', { sessionId: macThread, permission: 'auto' })
      await rpc(mac, 'session.markStatus', { sessionId: macThread, status: 'running' })
      const macSocket = persistentRpc(mac)
      const kinds: TimingKind[] = pictures ? ['observe', 'observe-shot', 'set-value'] : ['observe', 'set-value']
      const fieldOf: Record<'box' | 'mac', number | null> = { box: Number(field), mac: null }
      const argsOf = (kind: TimingKind, side: 'box' | 'mac', pair: number): { tool: string; args: Record<string, unknown> } => {
        if (kind === 'set-value') return { tool: 'computer_act', args: policy.observeArgs({ app: APP, window: APP, action: 'set_value', element: fieldOf[side], value: `Timing ${pair} ${side}` }) }
        return { tool: 'computer_observe', args: policy.observeArgs({ app: APP, window: APP, screenshot: kind === 'observe-shot' }) }
      }
      const boxTimed = async (kind: TimingKind, pair: number): Promise<{ ms: number; legs: ReturnType<typeof parseTimingLine> }> => {
        const { tool, args } = argsOf(kind, 'box', pair)
        policy.assertRequest(tool, args)
        const from = (await boxCall<{ end: number }>('logTail', { from: Number.MAX_SAFE_INTEGER })).end
        const out = await boxCall<{ ms: number; answer: AppComputerAnswer }>('timed', { method: 'app.computer', params: { sessionId: t1, token: token(t1), call: ++callSeq, tool, args, images: 'parts' } })
        if (out.answer.isError) throw new Error(`timing: the box's ${kind} failed: ${out.answer.text.slice(0, 200)}`)
        // the instance's stdout reaches its log a moment after the answer
        let legs: ReturnType<typeof parseTimingLine> = null
        await until(2_000, async () => {
          const line = (await boxCall<{ text: string }>('logTail', { from })).text.split('\n').find((l) => l.includes(`[computer-bridge] thread=${t1} timing `))
          legs = line ? parseTimingLine(line) : null
          return legs !== null
        })
        return { ms: out.ms, legs }
      }
      const macTimed = async (kind: TimingKind, pair: number): Promise<number> => {
        const { tool, args } = argsOf(kind, 'mac', pair)
        policy.assertRequest(tool, args)
        const t0 = performance.now()
        const answer = await macSocket<AppComputerAnswer>('app.computer', { sessionId: macThread, token: tokenFor(SEED, 'computer', macThread), call: ++callSeq, tool, args, images: 'parts' })
        const ms = performance.now() - t0
        if (answer.isError) throw new Error(`timing: the Mac's ${kind} failed: ${answer.text.slice(0, 200)}`)
        // the Mac thread's own book numbers the field: read it from its first observe
        if (kind === 'observe' && fieldOf.mac === null) fieldOf.mac = Number(answer.text.match(/\[(\d+)\] input\b/)?.[1] ?? NaN)
        return ms
      }
      // the link apart from the calls: ten pings, three 1 MB sinks (base64 of random bytes, which nothing compresses)
      const pings: number[] = []
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now()
        await boxCall('ping')
        pings.push(performance.now() - t0)
      }
      const roundTripMs = median(pings)
      const blob = randomBytes(750_000).toString('base64')
      const sinks: number[] = []
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now()
        await boxCall('sink', { data: blob })
        sinks.push(performance.now() - t0)
      }
      const sinkMs = Math.max(1, (median(sinks) ?? 1) - (roundTripMs ?? 0))
      const uploadMbps = (blob.length * 8) / (sinkMs / 1000) / 1e6
      const samples: TimingSample[] = []
      for (let pair = 0; pair <= BRIDGE_TIMING_RULE.pairs; pair++) {
        await awaitScreen()
        for (const kind of kinds) {
          const bridged = await boxTimed(kind, pair)
          const localMs = await macTimed(kind, pair)
          samples.push({ kind, pair, bridgedMs: Math.round(bridged.ms), localMs: Math.round(localMs), legs: bridged.legs })
        }
      }
      const ctx = { roundTripMs, uploadMbps, ...(pictures ? {} : { skipped: { 'observe-shot': 'Screen Recording is off' } as const }) }
      const verdict = judgeBridgeTiming(samples, mode, ctx)
      const table = timingTable(verdict, ctx)
      console.log(table.split('\n').map((l) => `      ${l}`).join('\n'))
      report.timing = { mode, roundTripMs, uploadMbps, samples, table, failures: verdict.failures }
      check(`timing: the bridge adds within its bound (${mode})`, verdict.ok, verdict.failures.join('; '))
      await rpc(mac, 'session.markStatus', { sessionId: macThread, status: 'idle' })
    }

    // 5. the card
    await awaitScreen()
    await boxCall('session.permission', { sessionId: t1, permission: 'safe' })
    await computer(t1, 'computer_observe', { app: APP, window: APP })
    check('card: an observe raises no request on the Mac', (await macPending()).filter((r) => r.status === 'pending').length === 0)
    const clickArgs = { app: APP, window: APP, action: 'left_click', element: Number(ping) }
    const denied = computer(t1, 'computer_act', clickArgs)
    let card: BridgeRequest | undefined
    await until(30_000, async () => !!(card = (await macPending()).find((r) => r.kind === 'computer' && r.status === 'pending')))
    check("card: the Mac's request is kind computer and names the click", !!card && /click/i.test(card.computer?.actions[0] ?? ''), JSON.stringify(card))
    const asking = (await sessionsOnBox()).find((r) => r.threadId === t1)
    check("card: the box's row asks and says where", !!asking?.asking && asking.macPeer === macId && asking.macName === macName && asking.running?.words === `Waiting for approval on ${macName}`, JSON.stringify(asking))
    if (card) await rpc(mac, 'macBridge.decide', { id: card.id, allow: false })
    const deniedOut = await denied
    check('card: a denial answers denied', deniedOut.isError && deniedOut.text.includes('denied: the person did not allow it'), deniedOut.text)
    const allowed = computer(t1, 'computer_act', clickArgs)
    await until(30_000, async () => !!(card = (await macPending()).find((r) => r.kind === 'computer' && r.status === 'pending')))
    if (card) await rpc(mac, 'macBridge.decide', { id: card.id, allow: true })
    const allowedOut = await allowed
    const allowCover = probeCovered()
    check('card: an Allow runs the click', !allowCover && !allowedOut.isError && / · (ax|process) · changed/.test(allowedOut.text), allowCover ?? allowedOut.text.slice(0, 300))

    // 6. the cap
    await awaitScreen()
    await rpc(mac, 'macBridge.limits.set', { environmentId: boxId, maxComputer: 1 })
    // t2's turn runs before its call, so the box thread's status can say the Mac's hold
    await boxCall('session.markStatus', { sessionId: t2, status: 'running' })
    const second = computer(t2, 'computer_observe', { app: APP, window: APP })
    const held = await until(30_000, async () => (await macActivity()).calls.some((c) => c.sessionId === t2 && c.status === 'held' && c.held?.reason === 'computer' && c.held.position === 1))
    check("cap: the Mac holds the second thread's session, reason computer, 1st in line", held)
    const heldRow = (await sessionsOnBox()).find((r) => r.threadId === t2)
    check("cap: the second thread's box row says its place", heldRow?.running?.words === 'Waiting for the Mac, 1 of 1 computer sessions, 1st in line', JSON.stringify(heldRow))
    const heldLine = 'Waiting for the Mac, 1 of 1 computer sessions, 1st in line'
    const saidHeld = await until(10_000, async () => (await detailOnBox(t2)) === heldLine)
    check("cap: the second box thread's own status says the Mac's hold", saidHeld, String(await detailOnBox(t2)))
    await boxCall('session.markStatus', { sessionId: t1, status: 'idle' })
    const secondOut = await second
    check("cap: the first thread's settle frees the slot and the second runs", !secondOut.isError, secondOut.text.slice(0, 200))
    const detailAfter = await detailOnBox(t2)
    check("cap: once the second runs, its status no longer says the hold", detailAfter !== heldLine, String(detailAfter))
    await boxCall('session.markStatus', { sessionId: t2, status: 'idle' })

    // 6b. a held call answers the model in time (computer/pending.ts), through the real stdio bridge
    await awaitScreen()
    const macRuns = (): number => logOf(mac).split('\n').filter((l) => l.includes('action.run')).length
    type McpOut = { content?: { type: string; text?: string }[]; isError?: boolean }
    const textOf = (out: McpOut): string => (out.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n')
    // t2 reads TC Probe first, keeping its Ping index; its settle ends its live session
    await boxCall('session.markStatus', { sessionId: t2, status: 'running' })
    const t2Read = await computer(t2, 'computer_observe', { app: APP, window: APP, full: true })
    const t2Ping = bridgeProbePing(t2Read.text)
    await boxCall('session.markStatus', { sessionId: t2, status: 'idle' })
    // t1 holds the one live session
    await boxCall('session.markStatus', { sessionId: t1, status: 'running' })
    await computer(t1, 'computer_observe', { app: APP, window: APP })
    await boxCall('session.markStatus', { sessionId: t2, status: 'running' })
    const session = await boxCall<string>('bridge.open', { sessionId: t2, images: 'none' })
    const ask = (name: string, args: Record<string, unknown>): Promise<McpOut> =>
      boxCall<McpOut>('bridge.ask', { key: session, method: 'tools/call', params: { name, arguments: args } })
    const runsBefore = macRuns()
    const sentAt = Date.now()
    const firstHeld = textOf(await ask('computer_act', { app: APP, window: APP, action: 'left_click', element: t2Ping }))
    const heldId = bridgeHeldId(firstHeld)
    check('held: within 5 s the click answers held, the cap line and an id', Date.now() - sentAt < 5_000 && firstHeld.startsWith('Held after') && firstHeld.includes('computer sessions') && !!heldId, firstHeld)
    const pendingRow = (await sessionsOnBox()).find((r) => r.threadId === t2)
    check("held: the Activity row keeps the hold", /computer sessions/.test(pendingRow?.running?.words ?? ''), JSON.stringify(pendingRow))
    const quiet = await until(5_000, async () => !/computer sessions/.test((await detailOnBox(t2)) ?? ''))
    check("held: the thread's status no longer says the hold while nobody reads the call", quiet, String(await detailOnBox(t2)))
    await boxCall('session.markStatus', { sessionId: t1, status: 'idle' })
    const ready = await until(15_000, async () => (await sessionsOnBox()).find((r) => r.threadId === t2)?.running?.words === 'Ready, waiting for the thread')
    check("held: once admitted the row says it waits for the thread", ready, JSON.stringify((await sessionsOnBox()).find((r) => r.threadId === t2)))
    check('held: the click has not run unread', macRuns() === runsBefore)
    let read = textOf(await ask('computer_result', { id: heldId }))
    while (read.startsWith('Still held')) read = textOf(await ask('computer_result', { id: heldId }))
    const heldCover = probeCovered()
    check("held: computer_result returns the click's step line", !heldCover && / · (ax|process) · changed/.test(read), heldCover ?? read.slice(0, 300))
    // a second held click left unread is cancelled on the Mac and never runs
    await boxCall('session.markStatus', { sessionId: t2, status: 'idle' })
    await boxCall('session.markStatus', { sessionId: t1, status: 'running' })
    check('held: t1 takes the live session again', !(await computer(t1, 'computer_observe', { app: APP, window: APP })).isError)
    await boxCall('session.markStatus', { sessionId: t2, status: 'running' })
    const runsUnread = macRuns()
    const secondAt = Date.now()
    const secondHeld = textOf(await ask('computer_act', { app: APP, window: APP, action: 'left_click', element: t2Ping }))
    bridgeHeldId(secondHeld)
    check('held: the second click answers held', secondHeld.startsWith('Held after'), secondHeld)
    const heldOnMac = async (): Promise<boolean> => (await macActivity()).calls.some((c) => c.sessionId === t2 && c.status === 'held')
    check('held: the second click waits on the Mac', await until(5_000, heldOnMac))
    const unreadAt = Date.now()
    const cancelledOnMac = await until(20_000, async () => !(await heldOnMac()))
    check('held: left unread, it is cancelled on the Mac after 8 s', cancelledOnMac && Date.now() - secondAt >= 8_000, `${Date.now() - unreadAt} ms after it was seen held`)
    await boxCall('session.markStatus', { sessionId: t1, status: 'idle' })
    check('held: the unread click never ran', macRuns() === runsUnread)
    const openedOut = await ask('computer_observe', { app: APP, window: APP })
    const opened = textOf(openedOut)
    check("held: t2's next answer opens with the cancelled line", bridgeCancelledProbeRead(opened, openedOut.isError), opened.slice(0, 300))
    await boxCall('bridge.close', { key: session })
    await boxCall('session.markStatus', { sessionId: t2, status: 'idle' })
    await rpc(mac, 'macBridge.limits.set', { environmentId: boxId, maxComputer: null })

    // 7. pause
    await awaitScreen()
    await boxCall('session.markStatus', { sessionId: t1, status: 'running' })
    const inFlight = computer(t1, 'computer_act', clickArgs)
    await until(30_000, async () => (await macPending()).some((r) => r.kind === 'computer' && r.status === 'pending'))
    const pausedAt = Date.now()
    await boxCall('session.pause', { sessionId: t1 })
    const pausedOut = await inFlight
    check('pause: the call in flight answers cancelled within a second', pausedOut.text.includes('cancelled: the thread was paused') && Date.now() - pausedAt < 1_500, pausedOut.text)
    check("pause: the card leaves the Mac's pending list", await until(5_000, async () => !(await macPending()).some((r) => r.kind === 'computer' && r.status === 'pending')))
    const callsBefore = macCalls(t1)
    const whilePaused = await computer(t1, 'computer_observe', { app: APP, window: APP })
    check('pause: a call while paused is refused on the box', whilePaused.text.includes('refused: the thread is paused'), whilePaused.text)
    check('pause: the Mac never heard it', macCalls(t1) === callsBefore)
    await boxCall('session.markStatus', { sessionId: t1, status: 'running' })

    // 8. Stop
    await awaitScreen()
    const toStop = computer(t1, 'computer_act', clickArgs)
    await until(30_000, async () => (await macPending()).some((r) => r.kind === 'computer' && r.status === 'pending'))
    await boxCall('computer.stop', { sessionId: t1 })
    const stoppedOut = await toStop
    check("stop: the call answers stopped through the Mac's reply", stoppedOut.text.includes('stopped by the person'), stoppedOut.text)
    check("stop: the card is gone", await until(5_000, async () => !(await macPending()).some((r) => r.kind === 'computer' && r.status === 'pending')))
    const stopCalls = macCalls(t1)
    const later = await computer(t1, 'computer_observe', { app: APP, window: APP })
    check('stop: the next call in the turn answers stopped with no Mac call', later.text.includes('stopped by the person') && macCalls(t1) === stopCalls)
    await boxCall('session.markStatus', { sessionId: t1, status: 'idle' })
    await boxCall('session.markStatus', { sessionId: t1, status: 'running' })
    check('stop: the next turn reads again', !(await computer(t1, 'computer_observe', { app: APP, window: APP })).isError)

    // 9. Away
    await awaitScreen()
    await rpc(mac, 'away.set', { enabled: true })
    await until(10_000, async () => (await boxCall<{ enabled: boolean }>('away.get', {})).enabled === true)
    const awayOut = await computer(t1, 'computer_act', clickArgs)
    const awayCover = probeCovered()
    check('away: an acting call that would ask is allowed and marked away', !awayCover && !awayOut.isError && / · (ax|process) · changed/.test(awayOut.text) && logOf(mac).includes('card allowed (away)'), awayCover ?? awayOut.text)
    // The local socket answers session.events as the rows themselves; a remote one wraps them in { rows }.
    type Row = { event: { type: string; kind?: string; away?: { kind: string; text: string } } }
    const events = await boxCall<Row[] | { rows: Row[] }>('session.events', { sessionId: t1, afterSeq: 0 })
    const eventRows = Array.isArray(events) ? events : events.rows
    check('away: the box thread has an Allowed while away notice', eventRows.some((r) => r.event.type === 'notice' && r.event.kind === 'away' && r.event.away?.kind === 'allowed'))
    const runsBeforePay = macRuns()
    const paid = await computer(t1, 'computer_act', { ...clickArgs, confirm: { kind: 'pay', what: 'Pay in TC Probe (proof only)' } })
    check('away: a pay-flagged act is refused with MAC_AWAY_REFUSAL', paid.isError && paid.text.includes('denied: the person is away and this act spends money') && logOf(mac).includes('refused (away, spends money)'), paid.text)
    check('away: the pay-flagged click never ran', macRuns() === runsBeforePay)
    check('away: an observe still works', !(await computer(t1, 'computer_observe', { app: APP, window: APP })).isError)
    await rpc(mac, 'away.set', { enabled: false })

    // 10. codex
    await awaitScreen()
    const codexTools = (await boxCall<{ tools: { name: string }[] }>('bridge', { sessionId: t2, images: 'none', request: { method: 'tools/list' } })).tools.map((t) => t.name)
    check('codex: the stdio bridge lists the four tools and computer_result', ['computer_apps', 'computer_observe', 'computer_act', 'computer_batch', 'computer_result'].every((n) => codexTools.includes(n)), codexTools.join(','))
    await boxCall('session.markStatus', { sessionId: t2, status: 'running' })
    const codexOut = await boxCall<{ content: { type: string; text?: string }[] }>('bridge', {
      sessionId: t2,
      images: 'none',
      request: { method: 'tools/call', params: { name: 'computer_observe', arguments: policy.observeArgs({ app: APP, window: APP, screenshot: true }) } }
    })
    check(
      'codex: an observe answers text with its shot line and no image part',
      codexOut.content.every((c) => c.type === 'text') && (!pictures || (codexOut.content[0]?.text ?? '').includes('screenshot 1 (observation): ')),
      JSON.stringify(codexOut).slice(0, 300)
    )

    if (!pictures) check('codex: the picture checks', 'skipped', 'Screen Recording is off')

    // 11. the switch off mid-turn
    await awaitScreen()
    await computer(t1, 'computer_observe', { app: APP, window: APP })
    await rpc(mac, 'macBridge.computer.set', { environmentId: boxId, on: false })
    check("switch off: the Mac's activity has no computer call", !(await macActivity()).calls.some((c) => c.kind === 'computer'))
    const offAgain = await computer(t1, 'computer_observe', { app: APP, window: APP })
    check('switch off: the next call answers the switch line', offAgain.text.includes('computer use is off for this host'), offAgain.text)

    // 12. archive
    await awaitScreen()
    await rpc(mac, 'macBridge.computer.set', { environmentId: boxId, on: true })
    await until(5_000, async () => (await tools(t1)).tools.length === 5)
    await computer(t1, 'computer_observe', { app: APP, window: APP })
    const ledger = await boxCall<{ resources: { kind: string; environmentId: string; id: string }[] }>('resources.list', { sessionId: t1 })
    check('archive: the box ledger has a computer row on the Mac', ledger.resources.some((r) => r.kind === 'computer' && r.environmentId === macId), JSON.stringify(ledger.resources))
    const closesBefore = (logOf(mac).match(/session\.close/g) ?? []).length
    await boxCall('session.archive', { sessionId: t1, archived: true, removeResources: true })
    check("archive: the Mac's trace closes the bridged session", await until(15_000, () => (logOf(mac).match(/session\.close/g) ?? []).length > closesBefore))
    const gone = await until(15_000, async () => !(await boxCall<{ resources: { kind: string }[] }>('resources.list', { sessionId: t1 })).resources.some((r) => r.kind === 'computer'))
    check('archive: the ledger row is removed', gone)

    // 13. offline
    await awaitScreen()
    await rpc(mac, 'remote.environments.remove', { id: boxId })
    await sleep(2_000)
    const offline = await computer(t2, 'computer_observe', { app: APP, window: APP })
    check('offline: a call answers Mac offline', offline.text.includes('Mac offline'), offline.text)
    check('every step line named ax or process', report.steps.length > 0 && report.steps.every((l) => / · (ax|process)\b/.test(l)), report.steps.join(' | '))
  } catch (err) {
    check('the run finished', false, err instanceof Error ? (err.stack ?? err.message) : String(err))
  } finally {
    await cleanup()
  }
  console.log(failures ? `${failures} check(s) failed; report ${REPORT}` : `all checks passed; report ${REPORT}`)
  process.exit(failures ? 1 : 0)
}

if (process.argv.includes('--box-half')) await boxHalf()
else await orchestrator()
