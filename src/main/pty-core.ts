/**
 * PTY logic with no Electron or node-pty in it, so the batching, the byte
 * credits and the foreground-process formatter can be tested directly.
 * Ported from MonoCode's `src-tauri/src/pty.rs`.
 */

/** A busy shell hands us reads far faster than a webview can paint them. */
export const PTY_CHUNK = 32 * 1024
export const PTY_COALESCE_MS = 8

/** Bytes the renderer may owe us before the pty is paused, and the debt it
 *  has to pay down to before it resumes. */
export const ACK_HIGH_WATER = 1024 * 1024
export const ACK_LOW_WATER = 256 * 1024

/** Kept bytes go out at a full chunk or once the coalesce window closes. */
export function shouldFlush(buffered: number, sinceMs: number): boolean {
  return buffered >= PTY_CHUNK || sinceMs >= PTY_COALESCE_MS
}

/**
 * Byte credits. IPC gives no backpressure of its own: main counts what it
 * sent, the renderer acks what xterm consumed, and the pty is paused while
 * the gap is too wide.
 */
export class FlowControl {
  private unacked = 0
  private isPaused = false
  pauses = 0
  resumes = 0

  constructor(
    private readonly high = ACK_HIGH_WATER,
    private readonly low = ACK_LOW_WATER
  ) {}

  get pending(): number {
    return this.unacked
  }

  get paused(): boolean {
    return this.isPaused
  }

  /** True when this send crossed the high-water mark and the pty must pause. */
  sent(bytes: number): boolean {
    this.unacked += bytes
    if (this.isPaused || this.unacked <= this.high) return false
    this.isPaused = true
    this.pauses += 1
    return true
  }

  /** True when this ack cleared the low-water mark and the pty may resume. */
  acked(bytes: number): boolean {
    this.unacked = Math.max(0, this.unacked - bytes)
    if (!this.isPaused || this.unacked >= this.low) return false
    this.isPaused = false
    this.resumes += 1
    return true
  }
}

export function loginArgs(shell: string): string[] {
  const base = shell.split('/').pop() || shell
  return base === 'zsh' || base === 'bash' || base === 'sh' || base === 'fish' ? ['-l'] : []
}

export function defaultShell(
  platform: string,
  env: NodeJS.ProcessEnv
): { shell: string; args: string[] } {
  const shell = env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return { shell, args: loginArgs(shell) }
}

const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python3', 'ruby', 'deno', 'bun'])
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'nu', 'dash', 'ksh', 'tcsh', 'zsh5'])

export function isInterpreter(name: string): boolean {
  return INTERPRETERS.has(name)
}

/** A login shell shows up as `-zsh`, so the leading dash comes off first. */
export function isShellName(name: string): boolean {
  return SHELLS.has(name.startsWith('-') ? name.slice(1) : name)
}

/**
 * The name worth showing in a tab title. `node …/npm run build` is npm, not
 * node; anything else is its own basename.
 */
export function commandLabel(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return null
  const base = basename(parts[0])
  if (!base) return null
  if (isInterpreter(base)) {
    for (const part of parts.slice(1)) {
      if (part.startsWith('-')) continue
      const name = basename(part)
      if (name && !name.startsWith('-')) return name
    }
  }
  return base
}

function basename(path: string): string {
  return path.split('/').pop() || path
}

/**
 * Foreground process of a terminal, read out of
 * `ps -t <tty> -o pid=,pgid=,stat=,args=`. The foreground process group is
 * the one macOS flags with `+`; its leader is the process the user started.
 * Returns null when that is the login shell itself.
 */
export function foregroundLabel(psOutput: string, shellPid: number): string | null {
  for (const line of psOutput.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const [, pidText, pgidText, stat, args] = m
    if (!stat.includes('+')) continue
    const pid = Number(pidText)
    if (pid !== Number(pgidText)) continue
    if (pid === shellPid) return null
    const label = commandLabel(args)
    if (!label || isShellName(label)) return null
    return label
  }
  return null
}
