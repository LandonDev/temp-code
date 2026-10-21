import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { RouteScope } from 'aliax-core'
import { gateway } from '../gateway'
import { WarmPool, type WarmSpec } from './warm'

/**
 * The warm Claude process (drivers/warm.ts, "Warm harness" in docs/box.md).
 *
 * The Agent SDK fixes a CLI's model, cwd, tools, permission mode, MCP
 * server names and settings in its argv at spawn, but sends the system
 * prompt, hooks and in-process MCP servers later, over stdin, in its
 * `initialize` control request; and it accepts a process someone else
 * spawned (`spawnClaudeCodeProcess`). So a CLI spawned from the argv of
 * the last thread can sit with its MCP servers attached and no session,
 * and the next thread of the same argv adopts it: the SDK initializes it
 * with that thread's prompt and servers as if it had just spawned.
 *
 * The one per-thread thing in a spawn is the gateway base URL that names
 * the thread's account scope. A warm process gets `~w=<id>` instead and the
 * gateway rewrites that id into the adopting thread's scope (rebindWarmPath).
 */

/** The env key a thread's scope rides in; rebound at adoption, left out of the shape. */
export const CLAUDE_REBIND = ['ANTHROPIC_BASE_URL']

const STDERR_LINES = 40

/**
 * Spawn the CLI the way the SDK's own transport would (piped stdio, the
 * abort signal when the SDK gave one) and keep a stderr tail: the SDK reads
 * stderr only for processes it spawned itself, and the tail is the only
 * account of a CLI that died at boot.
 */
export function spawnClaude(spec: WarmSpec, signal: AbortSignal | undefined, label: string): ChildProcess {
  const proc = spawn(spec.command, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(signal ? { signal } : {}),
    windowsHide: true
  })
  const tail: string[] = []
  if (proc.stderr) {
    createInterface({ input: proc.stderr }).on('line', (line) => {
      if (!line.trim()) return
      tail.push(line)
      if (tail.length > STDERR_LINES) tail.shift()
    })
  }
  proc.once('exit', (code, sig) => {
    if (code === 0 || sig === 'SIGTERM' || signal?.aborted) return
    console.warn(`[claude] ${label}: CLI exited ${code ?? sig}${tail.length ? `: ${tail.slice(-5).join(' | ')}` : ''}`)
  })
  proc.on('error', () => {
    // The SDK listens for 'error' on the process it was handed; this keeps an unhandled one from throwing here.
  })
  return proc
}

const killClaude = (proc: ChildProcess): void => {
  if (!proc.killed && proc.exitCode === null) proc.kill('SIGTERM')
}

export const claudeWarm = new WarmPool<ChildProcess>({
  driver: 'claude',
  rebind: CLAUDE_REBIND,
  enabled: () => process.env.TEMP_CODE_WARM_HARNESS !== '0' && gateway()?.url('claude') != null,
  spawn: async (id, spec, onExit) => {
    const url = gateway()?.warmClaudeUrl(id)
    if (!url) throw new Error('the gateway is not running')
    const proc = spawnClaude({ ...spec, env: claudeWarm.envFor(spec, { ANTHROPIC_BASE_URL: url }) }, undefined, `warm ${id}`)
    proc.once('exit', () => {
      gateway()?.releaseWarm(id)
      onExit()
    })
    return proc
  },
  kill: killClaude
})

export interface ClaudeSpawnChoice {
  /** The thread this spawn is for. */
  thread: string
  /** The scope its requests spend under (null: unscoped). */
  scope: RouteScope | null
  /** Whether a warm process may be adopted or kept for this thread: a fresh thread (no resume) whose traffic our own gateway routes. */
  warmable: boolean
}

/**
 * What `spawnClaudeCodeProcess` hands the SDK: the warm process when one of
 * this spec's shape is waiting (rebound to the thread's scope), else a cold
 * spawn, which for a warmable thread also becomes the shape to keep warm.
 */
export function spawnOrAdoptClaude(spec: WarmSpec, signal: AbortSignal | undefined, choice: ClaudeSpawnChoice): { proc: ChildProcess; warmId: string | null } {
  if (choice.warmable) {
    const warm = claudeWarm.adopt(spec)
    if (warm) {
      gateway()?.adoptWarm(warm.id, choice.scope)
      // A local spawn dies with the SDK's abort signal; the adopted one does the same.
      if (signal) signal.addEventListener('abort', () => killClaude(warm.proc), { once: true })
      console.log(`[claude] ${choice.thread}: adopted the warm process ${warm.id}`)
      return { proc: warm.proc, warmId: warm.id }
    }
    claudeWarm.noteStart(spec)
  }
  return { proc: spawnClaude(spec, signal, choice.thread), warmId: null }
}
