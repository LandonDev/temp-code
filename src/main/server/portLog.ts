import { execFile } from 'node:child_process'
import { open, readlink, stat } from 'node:fs/promises'
import type { DevPortLog } from '@shared/contract-devservers'
import type { ThreadResource } from '@shared/contract-resources'
import type { SharedScanner } from './threadPorts'

/**
 * The console of a dev server a thread opened (a `port` row on the ledger,
 * threadPorts.ts). Its output is wherever the process writes: Claude's
 * background shell sends stdout and stderr to a file, so the listener (or the
 * shell above it) has fd 1 or 2 on a regular file, read on Linux through
 * /proc/<pid>/fd and on macOS through lsof. That file is tailed from an
 * offset the caller keeps; a file Claude deleted is still read through the
 * process's fd, and a file the call named (portSweep.ts) once the process is
 * gone. Without one, the shell call's output in the transcript is the log. A
 * row that ended says when and why, so the console can close with it.
 */

/** The first read of a file starts this far from its end. */
const FIRST_BYTES = 256 * 1024
/** At most this much per read. */
const READ_BYTES = 1024 * 1024
/** How many processes up from the listener to look for the file. */
const ANCESTORS = 3

export interface PortLogDeps {
  row: (resourceId: string) => ThreadResource | null
  /** The output file the row's shell call named (portSweep.ts), read when the process no longer points at one. */
  callFile?: (row: ThreadResource) => string | null
  /** The shell call's output from the transcript, null when it has none yet. */
  callOutput: (row: ThreadResource) => string | null
  scanner: SharedScanner
  platform?: NodeJS.Platform
}

const isLogPath = (p: string): boolean => p.startsWith('/') && !p.startsWith('/dev/') && !p.endsWith(' (deleted)')

function lsofFiles(pid: number): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('lsof', ['-a', '-p', String(pid), '-d', '1,2', '-Fn'], { timeout: 3_000 }, (_err, stdout) =>
      resolve(String(stdout ?? '').split('\n').flatMap((l) => (l.startsWith('n') ? [l.slice(1)] : [])))
    )
  })
}

/** fd 1 and 2's files; a deleted one (Claude removes its task file) is still read through the fd itself. */
async function linuxFiles(pid: number): Promise<string[]> {
  const out: string[] = []
  for (const fd of [1, 2]) {
    const target = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => null)
    if (target) out.push(target.endsWith(' (deleted)') && target.startsWith('/') ? `/proc/${pid}/fd/${fd}` : target)
  }
  return out
}

export class PortLogs {
  private readonly paths = new Map<string, string>()

  constructor(private readonly deps: PortLogDeps) {}

  /** The file the row's process writes to, found once per row. */
  private async fileOf(row: ThreadResource): Promise<string | null> {
    const known = this.paths.get(row.id)
    if (known) return known
    const linux = (this.deps.platform ?? process.platform) === 'linux'
    const { parents } = row.pid ? await this.deps.scanner.get(2_000) : { parents: new Map<number, number>() }
    let pid: number | undefined = row.pid ?? undefined
    for (let i = 0; pid && pid > 1 && i <= ANCESTORS; i++) {
      for (const p of await (linux ? linuxFiles(pid) : lsofFiles(pid))) {
        if (!isLogPath(p)) continue
        const st = await stat(p).catch(() => null)
        if (!st?.isFile()) continue
        this.paths.set(row.id, p)
        return p
      }
      pid = parents.get(pid)
    }
    const named = this.deps.callFile?.(row)
    if (named && (await stat(named).catch(() => null))?.isFile()) {
      this.paths.set(row.id, named)
      return named
    }
    return null
  }

  async read(resourceId: string, from: number | undefined): Promise<DevPortLog> {
    const row = this.deps.row(resourceId)
    if (!row || row.kind !== 'port') throw new Error(`unknown dev server: ${resourceId}`)
    const ended = row.removedAt === null ? {} : { endedAt: row.removedAt, note: row.note }
    const path = await this.fileOf(row).catch(() => null)
    if (path) {
      const size = (await stat(path).catch(() => null))?.size ?? 0
      // A file that shrank was truncated or replaced: start it over.
      const start = from === undefined || from > size ? Math.max(0, size - FIRST_BYTES) : from
      const end = Math.min(size, start + READ_BYTES)
      if (end <= start) return { source: 'file', path, data: '', next: start, ...ended }
      const fh = await open(path, 'r')
      try {
        const buf = Buffer.alloc(end - start)
        const { bytesRead } = await fh.read(buf, 0, buf.length, start)
        return { source: 'file', path, data: buf.subarray(0, bytesRead).toString('utf8'), next: start + bytesRead, ...ended }
      } finally {
        await fh.close()
      }
    }
    const output = this.deps.callOutput(row)
    if (output === null) return { source: 'none', path: null, data: '', next: 0, ...ended }
    const at = from === undefined || from > output.length ? 0 : from
    return { source: 'transcript', path: null, data: output.slice(at), next: output.length, ...ended }
  }
}
