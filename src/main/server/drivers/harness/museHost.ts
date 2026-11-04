import {
  MspError,
  ProtocolError,
  spawnMspConnection,
  type Connection,
  type ExitClassification,
  type SpawnedMspConnection
} from '@muse-code/sdk'
import type { InitializeResult } from '@muse-code/sdk/dist/src/msp'
import { version as appVersion } from '../../../../../package.json'
import { guardInstanceEnv, THREAD_MARK } from '../../processGuard'
import { harnessEnv } from '../binaries'
import { resolveMuseBinary } from './child'

/**
 * One `muse serve` per thread, owned through Meta's own SDK (the Muse
 * Session Protocol, newline JSON-RPC over stdio). The SDK spawns the
 * binary, runs the `initialize` handshake (and the `initialized` notice
 * the raw wire needs after it), checks the schema fingerprint against its
 * pin, classifies the exit and keeps a bounded stderr tail. This module
 * mirrors `MuseClient.spawn` but keeps the raw `Connection` and builds no
 * `MuseClient`: the facade hides the connection, drops every notification
 * that names no session (`usage/changed`, the subscription's own windows)
 * and lacks `turn/steer`, `turn/cancel`, `model/list`, `usage/read`,
 * `session/compact` and `task/stop`. The driver (drivers/muse.ts) owns the
 * session over `Connection.command` and the notification handler.
 *
 * The environment REPLACES the child's (the SDK passes it through verbatim):
 * the login PATH and the gateway-free `harnessEnv()`, the process guard's
 * marks, `XDG_CONFIG_HOME` for the account's config dir (museConfigDirs.ts)
 * and contributor mode off unless a setting turns it on, since the person's
 * code is not training data by default.
 */
export interface MuseHostOptions {
  sessionId: string
  cwd: string
  /** The account's config dir (`<dir>/muse/auth.json`); absent = the CLI's own `~/.config`. */
  configDir?: string | null
  contributorMode?: boolean
  /** Extra variables, after the defaults (the app-tools bridge's). */
  env?: Record<string, string>
  /** Extra `muse serve` arguments (`--disable-sandbox` where the host says the sandbox is gone). */
  args?: string[]
  onStderr?: (chunk: string) => void
  onExit?: (exit: ExitClassification) => void
  /** The binary, for tests; the login PATH otherwise. */
  museBin?: string
}

export interface MuseHost {
  connection: Connection
  init: InitializeResult
  pid: number | null
  alive: () => boolean
  exit: Promise<ExitClassification>
  close: () => Promise<void>
}

/** `clientInfo.name` must match ^[a-z0-9_]+$ (SS1.4.1): a hyphen is refused. */
export const MUSE_CLIENT_INFO = { name: 'temp_code', version: appVersion } as const

export async function museEnv(opts: Pick<MuseHostOptions, 'sessionId' | 'configDir' | 'contributorMode' | 'env'>): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {
    ...(await harnessEnv()),
    ...guardInstanceEnv(),
    [THREAD_MARK]: opts.sessionId,
    MUSE_CONTRIBUTOR_MODE: opts.contributorMode ? '1' : '0',
    ...(opts.env ?? {})
  }
  if (opts.configDir) env.XDG_CONFIG_HOME = opts.configDir
  return env
}

export async function spawnMuseHost(opts: MuseHostOptions): Promise<MuseHost> {
  const museBin = opts.museBin ?? (await resolveMuseBinary()).path
  const env = await museEnv(opts)
  const handshake = spawnMspConnection({
    command: museBin,
    args: ['serve', ...(opts.args ?? [])],
    cwd: opts.cwd,
    env,
    onStderr: opts.onStderr,
    shutdownTimeoutMs: 5_000
  })
  let spawned: SpawnedMspConnection
  try {
    spawned = await handshake.initialize({
      clientInfo: MUSE_CLIENT_INFO,
      capabilities: { requestedCapabilities: ['sessionMcp'], experimentalApi: true }
    })
  } catch (error) {
    await handshake.close().catch(() => undefined)
    if (error instanceof MspError || (error instanceof ProtocolError && error.line !== undefined)) throw error
    const tail = handshake.child.stderrTail.map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ')
    throw new Error(`muse serve exited unexpectedly before answering initialize${tail ? `: ${tail}` : ''}`)
  }
  if (spawned.fingerprintWarning) console.log(`[muse] ${opts.sessionId}: ${spawned.fingerprintWarning.message}`)
  let alive = true
  const exit = spawned.child.exit.then((e) => {
    alive = false
    opts.onExit?.(e)
    return e
  })
  exit.catch(() => undefined)
  return {
    connection: spawned.connection,
    init: spawned.initializeResult,
    pid: pidOf(spawned),
    alive: () => alive,
    exit,
    close: () => spawned.close().then(() => undefined, () => undefined)
  }
}

/** The SDK keeps the child process behind a symbol-keyed method on
 *  `MuseServeChild` (its owned transport); the pid is read through it for
 *  the admission sampler and the guard. null when the SDK's shape moved. */
function pidOf(spawned: SpawnedMspConnection): number | null {
  try {
    const child = spawned.child as unknown as Record<symbol, () => { child?: { pid?: number } }>
    for (const sym of Object.getOwnPropertySymbols(Object.getPrototypeOf(child))) {
      if (typeof child[sym] !== 'function') continue
      const pid = child[sym]()?.child?.pid
      if (typeof pid === 'number') return pid
    }
  } catch {
    // a moved SDK shape: no pid, the sampler reads the median
  }
  return null
}

/** The row's words for a host that ended on its own (the SDK's SS2.11 exit
 *  classification). `exited unexpectedly` keeps failureKind's HARNESS_CRASHED
 *  match for a crash; a config refusal names the stderr tail so the person
 *  can fix the settings file it refused. */
export function exitWords(exit: ExitClassification): string | null {
  const tail = (lines: readonly string[]): string => lines.map((l) => l.trim()).filter(Boolean).slice(-3).join(' · ')
  switch (exit.kind) {
    case 'cleanShutdown':
      return null
    case 'configError':
      return `Muse Code config error: ${tail(exit.stderrTail) || 'muse serve refused its settings'}`
    case 'leaseUnavailable':
      return 'Muse Code session in use by another client'
    case 'usageError':
      return `Muse Code refused the client (version mismatch?): ${tail(exit.stderrTail) || `exit ${exit.exitCode}`}`
    case 'sdkSurfaceUnavailable':
      return `Muse Code's SDK surface is unavailable: ${tail(exit.stderrTail) || `exit ${exit.exitCode}`}`
    case 'unhandledError':
      return `muse serve exited unexpectedly (${exit.exitCode})${exit.stderrTail.length ? `: ${tail(exit.stderrTail)}` : ''}`
    case 'crash':
      return `muse serve exited unexpectedly (${exit.exitSignal ?? exit.exitCode ?? 'crash'})${exit.stderrTail.length ? `: ${tail(exit.stderrTail)}` : ''}`
  }
}
