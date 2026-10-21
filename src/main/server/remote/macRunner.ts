import { spawn } from 'node:child_process'
import { MAC_RUN_OUTPUT_CAP, type MacRunResult } from '@shared/contract-macbridge'
import { loginShell } from '../loginShell'
import { trackChild } from '../spawnBudget'
import { HeadTailOutput, ProgressPacer } from './peerStreams'

/**
 * The Mac bridge's command runner (docs/box.md "The Mac bridge"). Only ever
 * reached after the person at the Mac allowed the exact argv and cwd. The
 * command runs through the login shell (loginShell.ts) so the Mac's PATH
 * (Homebrew, …) is there, with no stdin, in a process group of its own, and
 * an environment scrubbed down to who and where: nothing of the app's own
 * (no TEMP_CODE_*, no provider keys, no ELECTRON_*). Past the timeout or on
 * stop() the whole group goes: SIGTERM, then SIGKILL after a grace. Output
 * past MAC_RUN_OUTPUT_CAP keeps its head and tail (peerStreams.ts
 * HeadTailOutput), and `onOutput` hears it line by line while it runs
 * (ProgressPacer: one frame per 100 ms at most, 64 KiB each).
 */

const KEEP_ENV = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TZ']
const BASE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export const KILL_GRACE_MS = 2_000

export function scrubbedEnv(src: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of KEEP_ENV) if (src[key]) out[key] = src[key] as string
  out.PATH = BASE_PATH
  out.TERM = 'dumb'
  out.NO_COLOR = '1'
  return out
}

/** The login shell's argv for a command: argv runs as given ("$@", no word splitting), a command string as the shell reads it. */
export function shellArgv(
  spec: { argv?: string[]; command?: string },
  shell: string = loginShell()
): string[] {
  if (spec.argv?.length) return [shell, '-lc', 'exec "$@"', 'mac-bridge', ...spec.argv]
  if (spec.command) return [shell, '-lc', spec.command]
  throw new Error('mac.run needs argv or command')
}

export interface RunningCommand {
  result: Promise<MacRunResult>
  /** Kill the process group (a denial after the start, the person pressed Stop). */
  stop: () => void
  pid: number | undefined
}

export function runMacCommand(opts: {
  argv?: string[]
  command?: string
  cwd: string
  timeoutMs: number
  outputCap?: number
  shell?: string
  env?: Record<string, string>
  /** The output so far, as progress frames (peerStreams.ts ProgressPacer); the last one comes before the result. */
  onOutput?: (chunk: string, skipped: number) => void
  progressMs?: number
}): RunningCommand {
  const cap = opts.outputCap ?? MAC_RUN_OUTPUT_CAP
  const [file, ...args] = shellArgv(opts, opts.shell)
  const startedAt = Date.now()
  const child = trackChild(
    spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? scrubbedEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  )
  // The first quarter of the cap is the head, the rest the tail (1 MiB + 3 MiB at 4 MiB).
  const output = new HeadTailOutput(Math.floor(cap / 4), cap - Math.floor(cap / 4))
  const pacer = opts.onOutput
    ? new ProgressPacer({
        send: opts.onOutput,
        ...(opts.progressMs !== undefined ? { intervalMs: opts.progressMs } : {})
      })
    : null
  let timedOut = false
  let killTimer: NodeJS.Timeout | null = null
  const killGroup = (): void => {
    if (killTimer) return
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          /* gone */
        }
      }
    }
    signal('SIGTERM')
    killTimer = setTimeout(() => signal('SIGKILL'), KILL_GRACE_MS)
    killTimer.unref()
  }
  const take = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    output.push(stream, chunk)
    pacer?.push(stream, chunk)
  }
  child.stdout?.on('data', take('stdout'))
  child.stderr?.on('data', take('stderr'))
  const timer = setTimeout(() => {
    timedOut = true
    killGroup()
  }, opts.timeoutMs)
  timer.unref()
  const result = new Promise<MacRunResult>((resolve) => {
    let done = false
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, extra = ''): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      // The shell is gone; anything it left in the group goes with it.
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* the group is empty */
      }
      if (killTimer) clearTimeout(killTimer)
      pacer?.end()
      resolve({
        exitCode,
        signal,
        stdout: output.text('stdout'),
        stderr: output.text('stderr') + extra,
        truncated: output.truncated,
        timedOut,
        durationMs: Date.now() - startedAt,
        ...(output.truncated ? { droppedBytes: output.dropped } : {})
      })
    }
    // A background child of the command holding the pipes open would keep
    // 'close' from firing: once the shell exits, the rest of its group goes.
    child.on('exit', () => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        /* the group is empty */
      }
    })
    child.on('error', (e) => finish(null, null, e.message))
    child.on('close', (code, signal) => finish(code, signal))
  })
  return { result, stop: killGroup, pid: child.pid }
}
