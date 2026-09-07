import { spawn, type ChildProcess } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { access, constants } from 'node:fs/promises'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { harnessEnv as baseHarnessEnv, loginPath, resolveBinary } from '../binaries'

/**
 * Child-process bridge for the ported harness engines (fx, grok, pi, omp,
 * opencode). Same call shapes as src/lib/harness/child.ts so an engine
 * ports with import changes only. What the Tauri version needed and this
 * one does not: the replay buffer (spawn is synchronous here, so a watcher
 * set before spawnChild sees every line) and the pid guard (handlers bind
 * to the ChildProcess; a stale exit is dropped by an identity check).
 */

type LineHandler = (line: string) => void
type ExitHandler = (code: number | null) => void
type SseHandler = (data: string) => void
type SseEndHandler = (error?: string) => void

interface Watch {
  onLine: LineHandler
  onExit: ExitHandler
  onStderr?: LineHandler
}

const children = new Map<string, ChildProcess>()
const watches = new Map<string, Watch>()
const sseWatches = new Map<string, { onData: SseHandler; onEnd?: SseEndHandler }>()
const sseOpen = new Map<string, AbortController>()

// ── environment ─────────────────────────────────────────────────────

/** Keys a GUI-launched server lacks but the user's terminal has. Without
 *  a Gateway key fx falls back to the Keychain and can hang on a prompt
 *  nobody sees; grok reads its API key the same way. */
const LOGIN_ENV_KEYS = [
  'AI_GATEWAY_API_KEY',
  'FX_AI_GATEWAY_API_KEY',
  'VERCEL_OIDC_TOKEN',
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY'
]

let loginEnvP: Promise<Record<string, string>> | null = null
/** The user's interactive-shell exports (`-lic`: .zshrc is where people
 *  put API keys), filtered to LOGIN_ENV_KEYS. Read once. */
function loginEnv(): Promise<Record<string, string>> {
  loginEnvP ??= run(process.env.SHELL || '/bin/zsh', ['-lic', 'printenv'], { timeoutMs: 10_000 })
    .then(({ stdout }) => {
      const env: Record<string, string> = {}
      for (const line of stdout.split('\n')) {
        const i = line.indexOf('=')
        if (i <= 0) continue
        const key = line.slice(0, i)
        const value = line.slice(i + 1)
        if (LOGIN_ENV_KEYS.includes(key) && value) env[key] = value
      }
      return env
    })
    .catch(() => ({}))
  return loginEnvP
}

/** binaries.harnessEnv (login PATH, host build vars stripped) plus the
 *  login shell's API keys when the server itself has none. */
export async function harnessEnv(): Promise<NodeJS.ProcessEnv> {
  const env = await baseHarnessEnv()
  const login = await loginEnv()
  for (const key of LOGIN_ENV_KEYS) if (!env[key] && login[key]) env[key] = login[key]
  return env
}

// ── one-shot processes ──────────────────────────────────────────────

interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

function run(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout!.on('data', (d) => (stdout += d))
    proc.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          proc.kill('SIGKILL')
          reject(new Error(`${command} timed out after ${opts.timeoutMs}ms`))
        }, opts.timeoutMs)
      : undefined
    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
}

/** Run a command under harnessEnv and return its stdout; rejects on a
 *  non-zero exit with the stderr tail. */
export async function execChild(command: string, args: string[], cwd?: string): Promise<string> {
  const { stdout, stderr, code } = await run(command, args, { cwd, env: await harnessEnv(), timeoutMs: 60_000 })
  if (code !== 0) throw new Error(`${command} exited (${code}): ${stderr.trim()}`)
  return stdout
}

// ── long-lived children ─────────────────────────────────────────────

export function watchChild(sessionId: string, onLine: LineHandler, onExit: ExitHandler, onStderr?: LineHandler): void {
  watches.set(sessionId, { onLine, onExit, onStderr })
}

export function unwatchChild(sessionId: string): void {
  watches.delete(sessionId)
}

/** Spawn the session's child. Resolves once the process is running and
 *  rejects if it cannot start (missing binary). A child already running
 *  under this session is killed and its exit never reaches the watcher. */
export async function spawnChild(sessionId: string, command: string, args: string[], cwd: string): Promise<void> {
  const env = await harnessEnv()
  const previous = children.get(sessionId)
  if (previous) terminate(previous)
  const proc = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  children.set(sessionId, proc)
  proc.stdin!.on('error', () => undefined)
  createInterface({ input: proc.stdout! }).on('line', (line) => watches.get(sessionId)?.onLine(line))
  createInterface({ input: proc.stderr! }).on('line', (line) => watches.get(sessionId)?.onStderr?.(line))
  proc.on('exit', (code) => {
    // identity check: a respawn must not let the old child's exit fail the new turn
    if (children.get(sessionId) !== proc) return
    children.delete(sessionId)
    watches.get(sessionId)?.onExit(code)
  })
  await new Promise<void>((resolve, reject) => {
    proc.once('spawn', resolve)
    proc.once('error', (err) => {
      if (children.get(sessionId) === proc) children.delete(sessionId)
      reject(err)
    })
  })
}

export function writeChild(sessionId: string, line: string): Promise<void> {
  const proc = children.get(sessionId)
  if (!proc?.stdin || proc.stdin.destroyed) {
    return Promise.reject(new Error(`no running child for session ${sessionId}`))
  }
  return new Promise((resolve, reject) => {
    proc.stdin!.write(`${line}\n`, (err) => (err ? reject(err) : resolve()))
  })
}

function terminate(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  proc.kill('SIGTERM')
  const hard = setTimeout(() => proc.kill('SIGKILL'), 2_000)
  hard.unref()
  proc.once('exit', () => clearTimeout(hard))
}

/** Stop the session's child. The watcher is dropped first, so a kill
 *  never reads as an unexpected exit. */
export async function killChild(sessionId: string): Promise<void> {
  unwatchChild(sessionId)
  const proc = children.get(sessionId)
  if (!proc) return
  children.delete(sessionId)
  terminate(proc)
}

export async function killAllChildren(): Promise<void> {
  for (const id of [...children.keys()]) await killChild(id)
  for (const id of [...sseOpen.keys()]) await closeHarnessSse(id)
}

// ── HTTP + SSE (opencode) ───────────────────────────────────────────

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** The bridge only talks to harnesses on this machine. */
function assertLoopback(url: string): void {
  if (!LOOPBACK.has(new URL(url).hostname)) throw new Error(`harness http: ${url} is not loopback`)
}

export async function harnessHttp(input: {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}): Promise<{ status: number; body: string }> {
  assertLoopback(input.url)
  const res = await fetch(input.url, {
    method: input.method,
    headers: input.headers,
    body: input.body,
    signal: AbortSignal.timeout(input.timeoutMs ?? 30_000)
  })
  return { status: res.status, body: await res.text() }
}

export function watchSse(sessionId: string, onData: SseHandler, onEnd?: SseEndHandler): void {
  sseWatches.set(sessionId, { onData, onEnd })
}

export function unwatchSse(sessionId: string): void {
  sseWatches.delete(sessionId)
}

/** Open an event stream; resolves once the response headers are in.
 *  Each event's data lines (joined by \n) go to the session's watcher;
 *  onEnd fires when the server closes the stream, not on closeHarnessSse. */
export async function openHarnessSse(sessionId: string, url: string, headers?: Record<string, string>): Promise<void> {
  assertLoopback(url)
  sseOpen.get(sessionId)?.abort()
  const ctl = new AbortController()
  sseOpen.set(sessionId, ctl)
  const res = await fetch(url, { headers: { accept: 'text/event-stream', ...headers }, signal: ctl.signal })
  if (!res.ok || !res.body) {
    if (sseOpen.get(sessionId) === ctl) sseOpen.delete(sessionId)
    throw new Error(`sse ${url}: HTTP ${res.status}`)
  }
  void pumpSse(sessionId, ctl, res.body)
}

async function pumpSse(sessionId: string, ctl: AbortController, body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let error: string | undefined
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let end: number
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const data = buf
          .slice(0, end)
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).replace(/^ /, ''))
          .join('\n')
        buf = buf.slice(end + 2)
        if (data) sseWatches.get(sessionId)?.onData(data)
      }
    }
  } catch (err) {
    if (!ctl.signal.aborted) error = err instanceof Error ? err.message : String(err)
  }
  if (sseOpen.get(sessionId) !== ctl) return
  sseOpen.delete(sessionId)
  sseWatches.get(sessionId)?.onEnd?.(error)
}

export async function closeHarnessSse(sessionId: string): Promise<void> {
  unwatchSse(sessionId)
  const ctl = sseOpen.get(sessionId)
  sseOpen.delete(sessionId)
  ctl?.abort()
}

export function freeHarnessPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : null
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

// ── binaries ────────────────────────────────────────────────────────

function executable(path: string): Promise<boolean> {
  return access(path, constants.X_OK).then(
    () => true,
    () => false
  )
}

/** resolveBinary over the login PATH, then the installer's own bin dir
 *  for tools whose installer does not touch the PATH. Throws when absent. */
function resolver(name: string, fallbackDirs: string[] = []): () => Promise<{ path: string }> {
  return async () => {
    const found = await resolveBinary(name)
    if (found) return { path: found }
    for (const dir of fallbackDirs) {
      const candidate = join(homedir(), dir, name)
      if (await executable(candidate)) return { path: candidate }
    }
    throw new Error(`${name} not found on the login-shell PATH`)
  }
}

export const resolveGrokBinary = resolver('grok', ['.grok/bin'])
export const resolveOpenCodeBinary = resolver('opencode', ['.opencode/bin'])
export const resolvePiBinary = resolver('pi')
export const resolveOmpBinary = resolver('omp')

/** An `fx` on the PATH may be the unrelated JSON viewer: the agent is the
 *  first `fx` whose binary carries its markers or whose --help talks ACP. */
const FX_MARKERS = ['vercel-labs/fx', 'FX_MODEL', 'createFxAgent', 'fx acp']
let fxP: Promise<{ path: string }> | null = null
export function resolveFxBinary(): Promise<{ path: string }> {
  fxP ??= (async () => {
    for (const dir of (await loginPath()).split(':')) {
      if (!dir) continue
      const candidate = join(dir, 'fx')
      if ((await executable(candidate)) && (await isFxAgent(candidate))) return { path: candidate }
    }
    throw new Error('fx (the Vercel agent) not found on the login-shell PATH')
  })()
  fxP.catch(() => (fxP = null))
  return fxP
}

async function isFxAgent(path: string): Promise<boolean> {
  return (await fileMentions(path, FX_MARKERS)) || (await fxHelpMentionsAcp(path))
}

/** Scan a whole file for any marker; compiled binaries keep theirs
 *  megabytes in, so a head read is not enough. */
function fileMentions(path: string, markers: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let carry = ''
    const stream = createReadStream(path, { highWaterMark: 1 << 20 })
    stream.on('data', (chunk) => {
      const text = carry + chunk.toString('latin1')
      if (markers.some((m) => text.includes(m))) {
        resolve(true)
        stream.destroy()
        return
      }
      carry = text.slice(-64)
    })
    stream.on('error', () => resolve(false))
    stream.on('close', () => resolve(false))
  })
}

async function fxHelpMentionsAcp(path: string): Promise<boolean> {
  try {
    const { stdout, stderr } = await run(path, ['--help'], { env: await harnessEnv(), timeoutMs: 2_000 })
    const text = `${stdout}${stderr}`.toLowerCase()
    return text.includes('acp') && (text.includes('ask') || text.includes('gateway'))
  } catch {
    return false
  }
}
