import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { WebSocket } from 'ws'
import type { LspStatusRow } from '@shared/domain'
import { harnessEnv } from './drivers/binaries'

const execFileP = promisify(execFile)

/**
 * The language-server pool (docs/PLAN-3.md M13). Servers run here as child
 * processes; the renderer is the LSP client (Monaco providers) and speaks
 * raw JSON-RPC over a dedicated `/lsp/<serverId>` WS path — one WS text
 * frame per LSP message, re-framed to Content-Length stdio here.
 *
 * Lifecycle is the "not much load" contract: lazy start, LRU caps
 * (2 jdtls / 3 vtsls), 10-minute idle stop, warm persistent caches
 * (jdtls -data per project). Editing never depends on any of this.
 */

export type LspLang = 'java' | 'web' | 'idea'

// idea: 2 keeps the engines of the two most recent projects warm for
// instant switching; the third evicts the LRU (whose renderer connection
// stays down by design — see onClose in the renderer).
const CAPS: Record<LspLang, number> = { java: 2, web: 3, idea: 2 }
// intellij-server boots slowly and indexes expensively — keep it warm far
// longer than the cheap-to-restart servers.
const IDLE_STOP_MS: Record<LspLang, number> = {
  java: 10 * 60_000,
  web: 10 * 60_000,
  idea: 60 * 60_000
}
const CRASH_WINDOW_MS = 30_000

const JDTLS_VERSION = '1.60.0'
const jdtlsRoot = (): string => join(homedir(), '.temp-code', 'jdtls')
const jdtlsDist = (): string => join(jdtlsRoot(), 'dist', JDTLS_VERSION)

// intellij-server (docs/PLAN-4.md): IDEA's engine as an LSP server.
// Pinned preview build + per-platform artifact, sha256 from JetBrains'
// Open VSX server-bundle.json (spike 2026-08-15).
const IDEA_BUILD = '263.2689.0'
const IDEA_ARTIFACTS: Partial<Record<string, { name: string; sha256: string }>> = {
  'darwin-arm64': {
    name: `intellij-server-${IDEA_BUILD}-aarch64.sit`,
    sha256: 'bde4aeb8565a854408a16d4368774f4cc401b12100f75198b90ae407f9b2dc53'
  }
}
const ideaRoot = (): string => join(homedir(), '.temp-code', 'intellij-server')
const ideaEulaFile = (): string => join(ideaRoot(), 'eula-accepted.json')
const ideaCurrentFile = (): string => join(ideaRoot(), 'current.json')

/** Update channel (M21): current.json points at the active build; the
 *  pinned constant is the floor for fresh installs. */
interface IdeaCurrent {
  build: string
  url: string
  sha256: string
}
function ideaCurrent(): IdeaCurrent {
  try {
    const cur = JSON.parse(readFileSync(ideaCurrentFile(), 'utf8')) as IdeaCurrent
    if (cur.build && cur.sha256 && cur.url) return cur
  } catch {
    // fall through to the pinned floor
  }
  const artifact = IDEA_ARTIFACTS[`${process.platform}-${process.arch}`]
  return {
    build: IDEA_BUILD,
    url: `https://download.jetbrains.com/language-server/intellij-server/${IDEA_BUILD}/${artifact?.name ?? ''}`,
    sha256: artifact?.sha256 ?? ''
  }
}
const ideaDist = (): string => join(ideaRoot(), `dist-${ideaCurrent().build}`)

/** Ask Open VSX for the newest build (preview builds expire ~30 days).
 *  Newer → download + sha-verify + extract + repoint current.json; the
 *  EULA gate re-arms per build. */
export async function ideaCheckUpdate(): Promise<{
  current: string
  latest: string
  updated: boolean
}> {
  const platform = `${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const current = ideaCurrent()
  const meta = (await (
    await fetch(`https://open-vsx.org/api/JetBrains/intellij-server/${platform}`)
  ).json()) as { version?: string; files?: { download?: string } }
  const vsixUrl = meta.files?.download
  if (!vsixUrl) throw new Error('update check: no download in Open VSX metadata')
  const vsix = Buffer.from(await (await fetch(vsixUrl)).arrayBuffer())
  const vsixPath = join(tmpdir(), 'tc-ij-update.vsix')
  writeFileSync(vsixPath, vsix)
  const { stdout } = await execFileP('unzip', ['-p', vsixPath, 'extension/server-bundle.json'])
  rmSync(vsixPath, { force: true })
  const bundle = JSON.parse(stdout) as IdeaCurrent & { version: string }
  if (bundle.version === current.build) {
    return { current: current.build, latest: bundle.version, updated: false }
  }
  const next: IdeaCurrent = { build: bundle.version, url: bundle.url, sha256: bundle.sha256 }
  await downloadIdeaDist(next)
  mkdirSync(ideaRoot(), { recursive: true })
  writeFileSync(ideaCurrentFile(), JSON.stringify(next))
  return { current: current.build, latest: bundle.version, updated: true }
}

// ── stdio framing ────────────────────────────────────────────────────

/** Content-Length de-framer for the server's stdout. */
class StdioFrames {
  private buf: Buffer = Buffer.alloc(0)
  push(chunk: Buffer, onMessage: (body: string) => void): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    for (;;) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const header = this.buf.subarray(0, headerEnd).toString('ascii')
      const m = /Content-Length:\s*(\d+)/i.exec(header)
      if (!m) {
        this.buf = this.buf.subarray(headerEnd + 4)
        continue
      }
      const len = Number(m[1])
      const start = headerEnd + 4
      if (this.buf.length < start + len) return
      onMessage(this.buf.subarray(start, start + len).toString('utf8'))
      this.buf = this.buf.subarray(start + len)
    }
  }
}

const frame = (body: string): Buffer =>
  Buffer.from(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`, 'utf8')

// ── JDK discovery ────────────────────────────────────────────────────

export interface JavaRuntime {
  /** jdtls runtime name, e.g. JavaSE-21 */
  name: string
  path: string
  version: number
}

async function javaMajor(javaHome: string): Promise<number | null> {
  try {
    const { stderr, stdout } = await execFileP(join(javaHome, 'bin', 'java'), ['-version'], {
      timeout: 10_000
    })
    const m = /version "(\d+)(?:\.(\d+))?/.exec(stderr + stdout)
    if (!m) return null
    const major = Number(m[1])
    return major === 1 ? Number(m[2]) : major // "1.8.0" → 8
  } catch {
    return null
  }
}

let jdksP: Promise<JavaRuntime[]> | null = null

/** JAVA_HOME → /usr/libexec/java_home -V → `java` on PATH, deduped. */
export function discoverJdks(): Promise<JavaRuntime[]> {
  jdksP ??= (async () => {
    const homes = new Set<string>()
    if (process.env.JAVA_HOME) homes.add(process.env.JAVA_HOME)
    if (process.platform === 'darwin') {
      try {
        const { stderr } = await execFileP('/usr/libexec/java_home', ['-V'], { timeout: 10_000 })
        for (const line of stderr.split('\n')) {
          const m = /(\/[^\s]+)\s*$/.exec(line.trim())
          if (m && m[1].includes('/')) homes.add(m[1])
        }
      } catch {
        // no Apple JDK shim or none installed
      }
    }
    try {
      const env = await harnessEnv()
      const { stdout } = await execFileP('/bin/zsh', ['-lc', 'command -v java'], { env })
      const bin = stdout.trim().split('\n').at(-1)
      if (bin?.startsWith('/')) {
        const { stdout: real } = await execFileP('readlink', ['-f', bin]).catch(() => ({
          stdout: bin
        }))
        homes.add(join(real.trim(), '..', '..'))
      }
    } catch {
      // no java on PATH
    }
    const runtimes: JavaRuntime[] = []
    for (const home of homes) {
      if (!existsSync(join(home, 'bin', 'java'))) continue
      const version = await javaMajor(home)
      if (version === null) continue
      if (runtimes.some((r) => r.path === home)) continue
      runtimes.push({ name: `JavaSE-${version}`, path: home, version })
    }
    return runtimes.sort((a, b) => b.version - a.version)
  })()
  return jdksP
}

export interface JavaDoctor {
  found: boolean
  path?: string
  version?: string
  /** jdtls dist present on disk (downloaded on first Java surface) */
  jdtls: boolean
  /** IntelliJ engine (docs/PLAN-4.md): dist + EULA state */
  ideaServer?: { dist: boolean; accepted: boolean; build: string }
  error?: string
}

/** The doctor.get Java row: JDK found, version, jdtls downloaded. */
export async function javaDoctor(): Promise<JavaDoctor> {
  const jdtls = existsSync(join(jdtlsDist(), 'plugins'))
  const ideaServer = {
    dist: existsSync(join(ideaDist(), 'bin', 'intellij-server')),
    accepted: ideaEulaAccepted(),
    build: ideaCurrent().build
  }
  const jdks = await discoverJdks()
  const best = jdks[0]
  if (!best)
    return { found: false, jdtls, ideaServer, error: 'no JDK found (JAVA_HOME, java_home, PATH)' }
  if (best.version < 21) {
    return {
      found: true,
      path: best.path,
      version: String(best.version),
      jdtls,
      ideaServer,
      error: `jdtls needs JDK 21+ to run (newest found: ${best.version})`
    }
  }
  return { found: true, path: best.path, version: String(best.version), jdtls, ideaServer }
}

// ── jdtls download (pinned release, cached, honest failure) ──────────

let downloadP: Promise<void> | null = null

async function ensureJdtlsDist(): Promise<void> {
  if (existsSync(join(jdtlsDist(), 'plugins'))) return
  downloadP ??= (async () => {
    const base = `https://download.eclipse.org/jdtls/milestones/${JDTLS_VERSION}`
    let url = `${base}/jdt-language-server-${JDTLS_VERSION}.tar.gz`
    try {
      const latest = await fetch(`${base}/latest.txt`)
      if (latest.ok) url = `${base}/${(await latest.text()).trim()}`
    } catch {
      // fall through to the unstamped guess; the fetch below reports honestly
    }
    const res = await fetch(url)
    if (!res.ok || !res.body) throw new Error(`jdtls download failed: HTTP ${res.status}`)
    const tarPath = join(tmpdir(), `jdtls-${JDTLS_VERSION}.tar.gz`)
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tarPath))
    const staging = `${jdtlsDist()}.partial`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    await execFileP('tar', ['xzf', tarPath, '-C', staging])
    rmSync(tarPath, { force: true })
    renameSync(staging, jdtlsDist()) // atomic: never a half-extracted dist
  })().finally(() => {
    downloadP = null
  })
  return downloadP
}

// ── intellij-server download + EULA gate (docs/PLAN-4.md M15) ────────

let ideaDownloadP: Promise<void> | null = null

async function downloadIdeaDist(target: IdeaCurrent): Promise<void> {
  const dist = join(ideaRoot(), `dist-${target.build}`)
  if (existsSync(join(dist, 'bin', 'intellij-server'))) return
  if (!target.sha256) {
    throw new Error(`intellij-server: no artifact pinned for ${process.platform}-${process.arch}`)
  }
  const res = await fetch(target.url)
  if (!res.ok || !res.body) throw new Error(`intellij-server download failed: HTTP ${res.status}`)
  const zipPath = join(tmpdir(), `intellij-server-${target.build}.zip`)
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(zipPath))
  const digest = createHash('sha256').update(readFileSync(zipPath)).digest('hex')
  if (digest !== target.sha256) {
    rmSync(zipPath, { force: true })
    throw new Error('intellij-server download failed its sha256 check')
  }
  const staging = `${dist}.partial`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  await execFileP('unzip', ['-q', '-o', zipPath, '-d', staging]) // .sit is a zip
  rmSync(zipPath, { force: true })
  // The archive wraps everything in intellij-server-<build>/.
  const inner = join(staging, `intellij-server-${target.build}`)
  renameSync(existsSync(join(inner, 'bin')) ? inner : staging, dist)
  rmSync(staging, { recursive: true, force: true })
}

async function ensureIdeaDist(): Promise<void> {
  if (existsSync(join(ideaDist(), 'bin', 'intellij-server'))) return
  ideaDownloadP ??= downloadIdeaDist(ideaCurrent()).finally(() => {
    ideaDownloadP = null
  })
  return ideaDownloadP
}

/** First 16 hex chars of sha256(EULA.txt) — the acceptance handshake the
 *  server checks in initializationOptions. */
function ideaEulaHash(): string {
  return createHash('sha256')
    .update(readFileSync(join(ideaDist(), 'EULA.txt')))
    .digest('hex')
    .slice(0, 16)
}

function ideaEulaAccepted(): boolean {
  try {
    const rec = JSON.parse(readFileSync(ideaEulaFile(), 'utf8')) as { build?: string }
    return rec.build === ideaCurrent().build
  } catch {
    return false
  }
}

/** Settings gate: EULA text (downloads the dist to get it) + state. */
export async function ideaEula(): Promise<{ build: string; text: string; accepted: boolean }> {
  await ensureIdeaDist()
  return {
    build: ideaCurrent().build,
    text: readFileSync(join(ideaDist(), 'EULA.txt'), 'utf8'),
    accepted: ideaEulaAccepted()
  }
}

export function ideaAcceptEula(): { accepted: boolean } {
  mkdirSync(ideaRoot(), { recursive: true })
  writeFileSync(
    ideaEulaFile(),
    JSON.stringify({ build: ideaCurrent().build, hash: ideaEulaHash(), acceptedAt: Date.now() })
  )
  return { accepted: true }
}

// ── the pool ─────────────────────────────────────────────────────────

interface PoolServer {
  id: string
  projectId: string
  cwd: string
  lang: LspLang
  state: 'starting' | 'downloading' | 'running' | 'error'
  error?: string
  proc: ChildProcess | null
  sockets: Set<WebSocket>
  lastUsed: number
  lastCrashAt: number
  /** intellij-server refuses a second initialize; the pool replays the
   *  first InitializeResult to reconnecting clients (page reloads). */
  initCache?: unknown
  initPendingId?: string | number | null
}

const pool = new Map<string, PoolServer>()
let sweepTimer: NodeJS.Timeout | null = null

function stopServer(server: PoolServer): void {
  pool.delete(`${server.projectId}:${server.lang}`)
  for (const ws of server.sockets) ws.close(4001, 'server stopped')
  server.sockets.clear()
  const proc = server.proc
  server.proc = null
  if (proc && proc.exitCode === null) {
    // Graceful LSP goodbye, then escalate.
    try {
      proc.stdin?.write(
        frame(JSON.stringify({ jsonrpc: '2.0', id: 'tc-shutdown', method: 'shutdown' }))
      )
      proc.stdin?.write(frame(JSON.stringify({ jsonrpc: '2.0', method: 'exit' })))
    } catch {
      // stdin already gone
    }
    const term = setTimeout(() => proc.kill('SIGTERM'), 1500)
    const kill = setTimeout(() => proc.kill('SIGKILL'), 5000)
    proc.once('exit', () => {
      clearTimeout(term)
      clearTimeout(kill)
    })
  }
}

/** Kill every engine rooted in a project before its worktree goes away.
 *  A survivor exits when its cwd vanishes and the silent crash-restart
 *  respawns it from the deleted directory — the JVM dies at VM init
 *  with a "Cannot start the IDE" alert. */
export async function stopProjectLsp(projectId: string): Promise<void> {
  for (const s of [...pool.values()]) {
    if (s.projectId === projectId) stopServer(s)
  }
  await cancelWarm(projectId)
}

/** Least-recently-used server of a language beyond its cap stops first. */
function evictForCap(lang: LspLang): void {
  const of = [...pool.values()].filter((s) => s.lang === lang)
  if (of.length < CAPS[lang]) return
  const lru = of.sort((a, b) => a.lastUsed - b.lastUsed)[0]
  if (lru) stopServer(lru)
}

async function spawnWeb(server: PoolServer): Promise<void> {
  const require2 = createRequire(import.meta.url)
  const bin = require2.resolve('@vtsls/language-server/bin/vtsls.js')
  const env = { ...(await harnessEnv()), ELECTRON_RUN_AS_NODE: '1' }
  server.proc = spawn(process.execPath, [bin, '--stdio'], { cwd: server.cwd, env })
}

async function spawnJava(server: PoolServer): Promise<void> {
  const jdks = await discoverJdks()
  const jdk = jdks.find((r) => r.version >= 21)
  if (!jdk) throw new Error('jdtls needs JDK 21+ (none found — see Settings → Java)')
  if (!existsSync(join(jdtlsDist(), 'plugins'))) {
    server.state = 'downloading'
    await ensureJdtlsDist()
  }
  const launcher = readdirSync(join(jdtlsDist(), 'plugins')).find(
    (f) => f.startsWith('org.eclipse.equinox.launcher_') && f.endsWith('.jar')
  )
  if (!launcher) throw new Error('jdtls dist is missing its launcher jar')
  const configName =
    process.platform === 'darwin'
      ? process.arch === 'arm64' && existsSync(join(jdtlsDist(), 'config_mac_arm'))
        ? 'config_mac_arm'
        : 'config_mac'
      : process.platform === 'win32'
        ? 'config_win'
        : process.arch === 'arm64' && existsSync(join(jdtlsDist(), 'config_linux_arm'))
          ? 'config_linux_arm'
          : 'config_linux'
  // Per-project copy of the config area: OSGi writes into it, and two
  // parallel instances (cap 2) must not fight over locks.
  const config = join(jdtlsRoot(), 'config', server.projectId)
  if (!existsSync(config)) {
    mkdirSync(join(jdtlsRoot(), 'config'), { recursive: true })
    cpSync(join(jdtlsDist(), configName), config, { recursive: true })
  }
  // The index (-data) persists across restarts: first open of a big Maven
  // project pays the import once; every later open is warm.
  const data = join(jdtlsRoot(), 'data', server.projectId)
  mkdirSync(data, { recursive: true })
  server.proc = spawn(
    join(jdk.path, 'bin', 'java'),
    [
      '-Declipse.application=org.eclipse.jdt.ls.core.id1',
      '-Dosgi.bundles.defaultStartLevel=4',
      '-Declipse.product=org.eclipse.jdt.ls.core.product',
      '-Dlog.level=WARN',
      // The reference launcher's GC tuning — throughput GC keeps builds
      // (and thus diagnostics) responsive.
      '-XX:+UseParallelGC',
      '-XX:GCTimeRatio=4',
      '-XX:AdaptiveSizePolicyWeight=90',
      '-Dsun.zip.disableMemoryMapping=true',
      '-Xmx1500m',
      '--add-modules=ALL-SYSTEM',
      '--add-opens',
      'java.base/java.util=ALL-UNNAMED',
      '--add-opens',
      'java.base/java.lang=ALL-UNNAMED',
      '-jar',
      join(jdtlsDist(), 'plugins', launcher),
      '-configuration',
      config,
      '-data',
      data
    ],
    { cwd: server.cwd, env: await harnessEnv() }
  )
}

async function spawnIdea(server: PoolServer): Promise<void> {
  if (!existsSync(join(ideaDist(), 'bin', 'intellij-server'))) {
    server.state = 'downloading'
    await ensureIdeaDist()
  }
  // Per-project state/lock dir; the heavy index cache is the server's own
  // (~/Library/Caches/JetBrains/analyzer), keyed by project path.
  const system = join(ideaRoot(), 'system', server.projectId)
  mkdirSync(system, { recursive: true })
  server.proc = spawn(
    join(ideaDist(), 'bin', 'intellij-server'),
    ['--stdio', '--system-path', system],
    {
      cwd: server.cwd,
      env: {
        ...(await harnessEnv()),
        INTELLIJ_DATA_SHARING: 'none',
        IJ_JAVA_OPTIONS: '-Xmx3g'
      }
    }
  )
}

const spawnFor = (server: PoolServer): Promise<void> =>
  server.lang === 'java'
    ? spawnJava(server)
    : server.lang === 'idea'
      ? spawnIdea(server)
      : spawnWeb(server)

// Server→client requests the pool answers itself for the engine: the
// renderer would answer them with nulls anyway, and a request broadcast
// while no client is attached (page reload window) would otherwise hang
// the awaiting server coroutine forever — import stalls, templates-only
// completions (found the hard way).
const POOL_ANSWERED = new Set([
  'workspace/configuration',
  'window/workDoneProgress/create',
  'client/registerCapability',
  'client/unregisterCapability',
  'window/showMessageRequest'
])

/** The pool's answer to an engine server→client request. */
function ideaAnswerFor(method: string, params: unknown): unknown {
  if (method === 'workspace/configuration') {
    return ((params as { items?: unknown[] } | undefined)?.items ?? []).map(() => null)
  }
  if (method === 'window/showMessageRequest') {
    // "Build tool conflicts are detected…" — a null answer makes the
    // engine skip the import entirely (found the hard way on a repo with
    // both pom.xml and .idea). Choose like IDEA would: build files over
    // the checked-in project model.
    const actions = (params as { actions?: { title: string }[] } | undefined)?.actions
    if (actions?.length) {
      const order = ['maven', 'gradle', 'bazel', 'jps']
      const rank = (t: string): number => {
        const at = order.findIndex((o) => t.toLowerCase().includes(o))
        return at < 0 ? order.length : at
      }
      return [...actions].sort((a, b) => rank(a.title) - rank(b.title))[0] ?? null
    }
  }
  return null
}

function wireProcess(server: PoolServer): void {
  const proc = server.proc
  if (!proc) return
  const frames = new StdioFrames()
  proc.stdout?.on('data', (chunk: Buffer) => {
    server.lastUsed = Date.now()
    frames.push(chunk, (body) => {
      if (server.lang === 'idea') {
        try {
          const msg = JSON.parse(body) as {
            id?: string | number
            method?: string
            result?: unknown
            params?: { items?: unknown[]; actions?: { title: string }[] }
          }
          if (msg.id !== undefined && msg.method && POOL_ANSWERED.has(msg.method)) {
            proc.stdin?.write(
              frame(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: ideaAnswerFor(msg.method, msg.params)
                })
              )
            )
            return
          }
          if (
            server.initPendingId != null &&
            msg.id === server.initPendingId &&
            msg.result !== undefined
          ) {
            server.initCache = msg.result
            server.initPendingId = null
          }
        } catch {
          // not JSON — fall through to broadcast
        }
      }
      for (const ws of server.sockets) {
        if (ws.readyState === ws.OPEN) ws.send(body)
      }
    })
  })
  proc.stderr?.on('data', () => {}) // jdtls chatter — not ours to relay
  proc.on('exit', () => {
    if (server.proc !== proc) return // deliberate stop already handled it
    server.proc = null
    for (const ws of server.sockets) ws.close(4002, 'language server exited')
    server.sockets.clear()
    const now = Date.now()
    if (now - server.lastCrashAt < CRASH_WINDOW_MS) {
      // Two crashes in one burst: stop retrying, surface honestly.
      server.state = 'error'
      server.error = 'language server crashed repeatedly'
      return
    }
    server.lastCrashAt = now
    server.initCache = undefined
    server.initPendingId = null
    if (!existsSync(server.cwd)) {
      // cwd deleted out from under it — a respawn would die at VM init.
      pool.delete(`${server.projectId}:${server.lang}`)
      return
    }
    // One silent restart; clients reconnect on socket close and re-init.
    void (async () => {
      try {
        server.state = 'starting'
        await spawnFor(server)
        wireProcess(server)
        server.state = 'running'
      } catch (err) {
        server.state = 'error'
        server.error = err instanceof Error ? err.message : String(err)
      }
    })()
  })
  proc.on('error', (err) => {
    if (server.proc !== proc) return
    server.state = 'error'
    server.error = err.message
  })
}

// Repos with a checked-in .idea make the engine's build-tool detection
// skip the import silently (A/B-tested); an explicit buildTools entry
// in initializationOptions forces the importer and everything works.
function detectBuildTool(cwd: string): string | undefined {
  return existsSync(join(cwd, 'pom.xml'))
    ? 'maven'
    : ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'].some((f) =>
          existsSync(join(cwd, f))
        )
      ? 'gradle'
      : undefined
}

export interface EnsureResult {
  serverId: string
  wsPath: string
  status: PoolServer['state'] | 'needs-eula'
  error?: string
  /** web: the project's own TypeScript lib dir, when it has one */
  tsdkPath?: string
  /** java: every discovered JDK, for java.configuration.runtimes */
  javaRuntimes?: JavaRuntime[]
  /** idea: the EULA acceptance handshake + default JDK for resolution */
  eulaHash?: string
  defaultSdk?: string
  /** idea: forced importer for the project root (maven/gradle) */
  buildTool?: string
}

async function ensureExtras(server: PoolServer): Promise<Partial<EnsureResult>> {
  if (server.lang === 'web') {
    const tsdk = join(server.cwd, 'node_modules', 'typescript', 'lib')
    return existsSync(join(tsdk, 'tsserverlibrary.js')) || existsSync(join(tsdk, 'typescript.js'))
      ? { tsdkPath: tsdk }
      : {}
  }
  if (server.lang === 'idea') {
    const jdks = await discoverJdks()
    const sdk = jdks.find((r) => r.version >= 21) ?? jdks[0]
    const buildTool = detectBuildTool(server.cwd)
    return {
      eulaHash: ideaEulaHash(),
      ...(sdk ? { defaultSdk: sdk.path } : {}),
      ...(buildTool ? { buildTool } : {})
    }
  }
  return { javaRuntimes: await discoverJdks() }
}

/** Idempotent: (projectId, lang) → one server, rooted at the project cwd. */
export async function ensureLsp(
  projectId: string,
  cwd: string,
  lang: LspLang
): Promise<EnsureResult> {
  if (!sweepTimer) {
    sweepTimer = setInterval(() => {
      const now = Date.now()
      for (const s of [...pool.values()]) {
        if (s.sockets.size === 0 && now - s.lastUsed > IDLE_STOP_MS[s.lang]) stopServer(s)
      }
    }, 60_000)
    sweepTimer.unref()
  }
  // The IntelliJ engine never runs before its EULA is accepted (Settings
  // shows the text; acceptance is stored per build).
  if (lang === 'idea' && !ideaEulaAccepted()) {
    return { serverId: '', wsPath: '', status: 'needs-eula' }
  }
  const key = `${projectId}:${lang}`
  const existing = pool.get(key)
  if (existing && existing.state !== 'error') {
    existing.lastUsed = Date.now()
    return {
      serverId: existing.id,
      wsPath: `/lsp/${existing.id}`,
      status: existing.state,
      ...(await ensureExtras(existing))
    }
  }
  if (existing) pool.delete(key) // error state: a fresh ensure retries
  // A background warm job holds the same --system-path lock — the live
  // engine wins; the index it wrote so far is crash-tolerant.
  if (lang === 'idea') await cancelWarm(projectId)
  evictForCap(lang)
  const server: PoolServer = {
    id: `${lang}-${projectId}-${Date.now().toString(36)}`,
    projectId,
    cwd,
    lang,
    state: 'starting',
    proc: null,
    sockets: new Set(),
    lastUsed: Date.now(),
    lastCrashAt: 0
  }
  pool.set(key, server)
  try {
    await spawnFor(server)
    wireProcess(server)
    server.state = 'running'
  } catch (err) {
    server.state = 'error'
    server.error = err instanceof Error ? err.message : String(err)
  }
  return {
    serverId: server.id,
    wsPath: `/lsp/${server.id}`,
    status: server.state,
    error: server.error,
    ...(await ensureExtras(server))
  }
}

/** Tunnel attach: `/lsp/<serverId>` upgrade lands here. */
export function attachLspSocket(serverId: string, ws: WebSocket): void {
  const server = [...pool.values()].find((s) => s.id === serverId)
  if (!server || server.state === 'error' || !server.proc) {
    ws.close(4000, 'no such language server')
    return
  }
  server.sockets.add(ws)
  server.lastUsed = Date.now()
  ws.on('message', (data) => {
    server.lastUsed = Date.now()
    const raw = String(data)
    if (server.lang === 'idea') {
      try {
        const msg = JSON.parse(raw) as { id?: string | number; method?: string }
        if (msg.method === 'initialize' && msg.id !== undefined) {
          if (server.initCache !== undefined) {
            // Already initialized: replay instead of forwarding — the
            // engine would error the session otherwise.
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: server.initCache }))
            return
          }
          server.initPendingId = msg.id
        }
      } catch {
        // non-JSON frame — forward as-is
      }
    }
    server.proc?.stdin?.write(frame(raw))
  })
  ws.on('close', () => {
    server.sockets.delete(ws)
    server.lastUsed = Date.now()
  })
}

// ── background index warming ─────────────────────────────────────────
// The engine's first import of a project takes minutes; its index cache
// persists across runs. A sequential queue warms every Java project's
// index ahead of use: spawn the engine at background QoS (taskpolicy -b),
// initialize, wait for its `intellij/ready-for-test` notification (the
// signal the dist's own bin/warmup.py waits for), shut down. Re-warms
// when the git HEAD or the engine build moves. A live pool server always
// wins the --system-path lock: ensureLsp cancels any in-flight warm.

interface WarmState {
  head: string | null
  build: string
  warmedAt: number
  cwd: string
}
interface WarmJob {
  projectId: string
  cwd: string
  proc: ChildProcess | null
  cancelled: boolean
}

const WARM_TIMEOUT_MS = 30 * 60_000
const WARM_RETRY_MS = 60 * 60_000
const warmDir = (): string => join(ideaRoot(), 'warm')
const warmStateFile = (projectId: string): string => join(warmDir(), `${projectId}.json`)
const warmQueue: WarmJob[] = []
let warmActive: WarmJob | null = null
/** Failed warms wait an hour before retrying (no hot loop on a broken repo). */
const warmFailedAt = new Map<string, number>()

function readWarmState(projectId: string): WarmState | null {
  try {
    return JSON.parse(readFileSync(warmStateFile(projectId), 'utf8')) as WarmState
  } catch {
    return null
  }
}

async function gitHead(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], { cwd })
    return stdout.trim() || null
  } catch {
    return null
  }
}

async function warmOne(job: WarmJob): Promise<void> {
  await ensureIdeaDist()
  const system = join(ideaRoot(), 'system', job.projectId)
  mkdirSync(system, { recursive: true })
  const bin = join(ideaDist(), 'bin', 'intellij-server')
  const args = ['--stdio', '--system-path', system]
  // Background QoS: indexing never competes with the user's foreground.
  const nice = existsSync('/usr/sbin/taskpolicy')
  const jdks = await discoverJdks()
  const sdk = jdks.find((r) => r.version >= 21) ?? jdks[0]
  const rootUri = pathToFileURL(job.cwd).toString()
  const buildTool = detectBuildTool(job.cwd)

  const proc = spawn(nice ? '/usr/sbin/taskpolicy' : bin, nice ? ['-b', bin, ...args] : args, {
    cwd: job.cwd,
    env: { ...(await harnessEnv()), INTELLIJ_DATA_SHARING: 'none', IJ_JAVA_OPTIONS: '-Xmx3g' }
  })
  job.proc = proc
  const send = (msg: object): void => {
    try {
      proc.stdin?.write(frame(JSON.stringify(msg)))
    } catch {
      // stdin already gone — exit handling reports it
    }
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new Error('warm-up timed out'))
    }, WARM_TIMEOUT_MS)
    const frames = new StdioFrames()
    proc.stdout?.on('data', (chunk: Buffer) =>
      frames.push(chunk, (body) => {
        let msg: { id?: string | number; method?: string; error?: { message?: string } }
        try {
          msg = JSON.parse(body) as typeof msg
        } catch {
          return
        }
        if (msg.id !== undefined && msg.method) {
          // Any unanswered server→client request hangs the engine's import
          // coroutine (found the hard way in the pool) — answer everything.
          send({
            jsonrpc: '2.0',
            id: msg.id,
            result: ideaAnswerFor(msg.method, (msg as { params?: unknown }).params)
          })
        } else if (msg.id === 1) {
          if (msg.error) {
            clearTimeout(timer)
            reject(new Error(msg.error.message ?? 'initialize failed'))
          } else {
            send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          }
        } else if (msg.method === 'intellij/ready-for-test') {
          clearTimeout(timer)
          resolve()
        }
      })
    )
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      reject(new Error(job.cancelled ? 'cancelled' : 'engine exited during warm-up'))
    })
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        processId: process.pid,
        rootUri,
        capabilities: {},
        workspaceFolders: [{ uri: rootUri, name: job.projectId }],
        initializationOptions: {
          eulaHash: ideaEulaHash(),
          ...(sdk ? { defaultSdk: sdk.path } : {}),
          ...(buildTool ? { buildTools: { [rootUri]: buildTool } } : {})
        }
      }
    })
  }).finally(() => {
    if (proc.exitCode !== null) return
    send({ jsonrpc: '2.0', id: 'tc-shutdown', method: 'shutdown' })
    send({ jsonrpc: '2.0', method: 'exit' })
    const term = setTimeout(() => proc.kill('SIGTERM'), 1500)
    const kill = setTimeout(() => proc.kill('SIGKILL'), 5000)
    proc.once('exit', () => {
      clearTimeout(term)
      clearTimeout(kill)
    })
  })
}

function kickWarmQueue(): void {
  if (warmActive) return
  const job = warmQueue.shift()
  if (!job) return
  warmActive = job
  void (async () => {
    try {
      // HEAD from before the warm: commits landing mid-warm re-warm later.
      const head = await gitHead(job.cwd)
      await warmOne(job)
      mkdirSync(warmDir(), { recursive: true })
      writeFileSync(
        warmStateFile(job.projectId),
        JSON.stringify({
          head,
          build: ideaCurrent().build,
          warmedAt: Date.now(),
          cwd: job.cwd
        } satisfies WarmState)
      )
      warmFailedAt.delete(job.projectId)
    } catch {
      if (!job.cancelled) warmFailedAt.set(job.projectId, Date.now())
    } finally {
      warmActive = null
      kickWarmQueue()
    }
  })()
}

/** A live engine needs the warm job's --system-path lock gone first. */
function cancelWarm(projectId: string): Promise<void> {
  const queued = warmQueue.findIndex((j) => j.projectId === projectId)
  if (queued >= 0) warmQueue.splice(queued, 1)
  const active = warmActive
  if (!active || active.projectId !== projectId) return Promise.resolve()
  active.cancelled = true
  const proc = active.proc
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    proc.once('exit', () => resolve())
    proc.kill('SIGTERM')
    setTimeout(() => proc.kill('SIGKILL'), 3000).unref()
  })
}

/** Queue warm-ups for every project that needs one. Skips: EULA
 *  unaccepted, no build files, live engine running, HEAD + build
 *  unchanged since the last warm, failed less than an hour ago. */
export async function warmIdeaIndexes(projects: { id: string; cwd: string }[]): Promise<void> {
  if (!ideaEulaAccepted()) return
  for (const p of projects) {
    if (!existsSync(p.cwd) || !detectBuildTool(p.cwd)) continue
    const live = pool.get(`${p.id}:idea`)
    if (live && live.state !== 'error') continue
    if (warmActive?.projectId === p.id || warmQueue.some((j) => j.projectId === p.id)) continue
    const failed = warmFailedAt.get(p.id)
    if (failed && Date.now() - failed < WARM_RETRY_MS) continue
    const state = readWarmState(p.id)
    if (state && state.build === ideaCurrent().build && state.head === (await gitHead(p.cwd)))
      continue
    warmQueue.push({ projectId: p.id, cwd: p.cwd, proc: null, cancelled: false })
  }
  kickWarmQueue()
}

/** Deleted projects leave warm-state files behind — sweep those. Only
 *  those: the per-project system dirs are megabytes and shared with any
 *  other app instance (a dev build's sweep must never rip a lock dir out
 *  from under the installed app's engine), and the analyzer's index
 *  cache key is opaque; it lives in ~/Library/Caches where macOS may
 *  purge it. */
export function sweepIdeaWarmState(knownIds: string[]): void {
  const known = new Set(knownIds)
  let entries: string[]
  try {
    entries = readdirSync(warmDir())
  } catch {
    return
  }
  for (const entry of entries) {
    if (known.has(entry.replace(/\.json$/, ''))) continue
    try {
      rmSync(join(warmDir(), entry), { force: true })
    } catch {
      // already gone — fine
    }
  }
}

async function rssBytes(pid: number): Promise<number | null> {
  if (process.platform === 'win32') return null
  try {
    const { stdout } = await execFileP('ps', ['-o', 'rss=', '-p', String(pid)])
    const kb = Number(stdout.trim())
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}

/** Running servers, memory, idle time — Settings/debug visibility. */
export async function lspStatus(): Promise<LspStatusRow[]> {
  const now = Date.now()
  const rows: LspStatusRow[] = await Promise.all(
    [...pool.values()].map(async (s) => ({
      serverId: s.id,
      projectId: s.projectId,
      lang: s.lang,
      state: s.state,
      memoryBytes: s.proc?.pid ? await rssBytes(s.proc.pid) : null,
      idleMs: Math.max(0, now - s.lastUsed),
      ...(s.error ? { error: s.error } : {})
    }))
  )
  if (warmActive) {
    rows.push({
      serverId: `warm-${warmActive.projectId}`,
      projectId: warmActive.projectId,
      lang: 'idea',
      state: 'indexing',
      memoryBytes: warmActive.proc?.pid ? await rssBytes(warmActive.proc.pid) : null,
      idleMs: 0
    })
  }
  return rows
}

/** Shutdown/test hook. */
export function stopAllLsp(): void {
  for (const s of [...pool.values()]) stopServer(s)
  warmQueue.length = 0
  if (warmActive) {
    warmActive.cancelled = true
    warmActive.proc?.kill('SIGKILL')
  }
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
