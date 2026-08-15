import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import {
  createWriteStream,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

export type LspLang = 'java' | 'web'

const CAPS: Record<LspLang, number> = { java: 2, web: 3 }
const IDLE_STOP_MS = 10 * 60_000
const CRASH_WINDOW_MS = 30_000

const JDTLS_VERSION = '1.60.0'
const jdtlsRoot = (): string => join(homedir(), '.temp-code', 'jdtls')
const jdtlsDist = (): string => join(jdtlsRoot(), 'dist', JDTLS_VERSION)

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
  error?: string
}

/** The doctor.get Java row: JDK found, version, jdtls downloaded. */
export async function javaDoctor(): Promise<JavaDoctor> {
  const jdtls = existsSync(join(jdtlsDist(), 'plugins'))
  const jdks = await discoverJdks()
  const best = jdks[0]
  if (!best) return { found: false, jdtls, error: 'no JDK found (JAVA_HOME, java_home, PATH)' }
  if (best.version < 21) {
    return {
      found: true,
      path: best.path,
      version: String(best.version),
      jdtls,
      error: `jdtls needs JDK 21+ to run (newest found: ${best.version})`
    }
  }
  return { found: true, path: best.path, version: String(best.version), jdtls }
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

function wireProcess(server: PoolServer): void {
  const proc = server.proc
  if (!proc) return
  const frames = new StdioFrames()
  proc.stdout?.on('data', (chunk: Buffer) => {
    server.lastUsed = Date.now()
    frames.push(chunk, (body) => {
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
    // One silent restart; clients reconnect on socket close and re-init.
    void (async () => {
      try {
        server.state = 'starting'
        await (server.lang === 'java' ? spawnJava(server) : spawnWeb(server))
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

export interface EnsureResult {
  serverId: string
  wsPath: string
  status: PoolServer['state']
  error?: string
  /** web: the project's own TypeScript lib dir, when it has one */
  tsdkPath?: string
  /** java: every discovered JDK, for java.configuration.runtimes */
  javaRuntimes?: JavaRuntime[]
}

async function ensureExtras(server: PoolServer): Promise<Partial<EnsureResult>> {
  if (server.lang === 'web') {
    const tsdk = join(server.cwd, 'node_modules', 'typescript', 'lib')
    return existsSync(join(tsdk, 'tsserverlibrary.js')) || existsSync(join(tsdk, 'typescript.js'))
      ? { tsdkPath: tsdk }
      : {}
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
        if (s.sockets.size === 0 && now - s.lastUsed > IDLE_STOP_MS) stopServer(s)
      }
    }, 60_000)
    sweepTimer.unref()
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
    await (lang === 'java' ? spawnJava(server) : spawnWeb(server))
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
    server.proc?.stdin?.write(frame(String(data)))
  })
  ws.on('close', () => {
    server.sockets.delete(ws)
    server.lastUsed = Date.now()
  })
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
  return Promise.all(
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
}

/** Shutdown/test hook. */
export function stopAllLsp(): void {
  for (const s of [...pool.values()]) stopServer(s)
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}
