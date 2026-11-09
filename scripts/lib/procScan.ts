/** Process marks for the proofs, on Linux and macOS. Never shell-quote a command. */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

export interface ProcessRow {
  pid: number
  command: string
  environment: string[]
}

/** macOS ps appends space-separated environment entries after the command. */
export function parsePs(text: string): ProcessRow[] {
  return text.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match
      ? [{ pid: Number(match[1]), command: match[2]!, environment: match[2]!.split(/\s+/) }]
      : []
  })
}

export function parsePpid(text: string): number | null {
  return /^\s*\d+\s*$/.test(text) ? Number(text.trim()) : null
}

export function hasEnv(row: ProcessRow, mark: string, prefix = false): boolean {
  return row.environment.some((entry) => (prefix ? entry.startsWith(mark) : entry === mark))
}

export function commandMatches(row: ProcessRow, ...parts: string[]): boolean {
  return parts.every((part) => row.command.includes(part))
}

interface ScanOptions {
  platform?: string
  listProc?: () => string[]
  read?: (path: string) => string
  exec?: (file: string, args: string[], options: ExecFileSyncOptionsWithStringEncoding) => string
}

export function createProcScan(options: ScanOptions = {}) {
  const platform = options.platform ?? process.platform
  const read = options.read ?? ((path: string) => readFileSync(path, 'utf8'))
  const run = options.exec ?? execFileSync
  const exec = (file: string, args: string[]): string => {
    try {
      // A busy Mac's full process environments can exceed Node's 1 MiB default.
      return run(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' })
    } catch (error) {
      // Child-process errors retain stdout/stderr, including private environments.
      // Fail the proof without passing that captured output to its log or cause.
      const failure = error as { code?: unknown; status?: unknown }
      const code = typeof failure?.code === 'string' && /^[A-Z0-9_]+$/.test(failure.code)
        ? failure.code
        : Number.isInteger(failure?.status) ? `exit ${failure.status}` : 'unknown error'
      throw new Error(`process scan failed: ${code}`)
    }
  }
  return {
    processes(): ProcessRow[] {
      if (platform === 'darwin') return parsePs(exec('ps', ['-axwwE', '-o', 'pid=,command=']))
      if (platform !== 'linux') throw new Error(`process scan unsupported on ${platform}`)
      return (options.listProc ?? (() => readdirSync('/proc')))()
        .filter((pid) => /^\d+$/.test(pid))
        .flatMap((pid) => {
          try {
            return [
              {
                pid: Number(pid),
                command: read(`/proc/${pid}/cmdline`).replaceAll('\0', ' '),
                environment: read(`/proc/${pid}/environ`).split('\0')
              }
            ]
          } catch {
            return [] // Gone, or another user's process.
          }
        })
    },
    ppidOf(pid: number): number | null {
      try {
        if (platform === 'darwin') return parsePpid(exec('ps', ['-o', 'ppid=', '-p', String(pid)]))
        if (platform !== 'linux') throw new Error(`process scan unsupported on ${platform}`)
        // comm may itself contain spaces and parentheses.
        const stat = read(`/proc/${pid}/stat`)
        return parsePpid(stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[1] ?? '')
      } catch {
        return null // Gone between the scan and the parent lookup.
      }
    }
  }
}
