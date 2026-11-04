import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { GuardProc } from './processGuard'

/**
 * The process table off `/proc`, for the guard on Linux: pid, ppid, pgid,
 * RSS and the command line of every process of one user, with no child
 * process at all (`ps` was a fork of main every 10 s and at every call end,
 * 50-70 ms of stalled loop each on the box; docs/box.md "The exec
 * broker"). Three small reads per process on the threadpool: `stat` for
 * ppid, pgid and resident pages, `cmdline` for the arguments, and the pid
 * dir's owner for the uid (the kernel gives the dir to the process's
 * effective uid). A process that leaves mid-read is skipped. `root` and the
 * page size are injectable so the parser runs over a fixture tree.
 */

export interface ProcScanOptions {
  /** `/proc`, or a fixture tree with `<pid>/stat` and `<pid>/cmdline` files. */
  root?: string
  /** Keep only this uid's processes; absent, every process. */
  uid?: number
  /** Bytes per page, for RSS; read from the host's auxv when absent, 4096 if that fails. */
  pageSize?: number
}

/** The fields of `/proc/<pid>/stat` the guard reads: `comm` may hold spaces and parens, so the split starts after the last `)`. */
export function parseProcStat(text: string): { pid: number; ppid: number; pgid: number; rssPages: number } | null {
  const close = text.lastIndexOf(')')
  if (close < 0) return null
  const pid = Number(text.slice(0, text.indexOf(' ')))
  const rest = text.slice(close + 2).split(' ')
  // After `)`: state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime priority nice threads itrealvalue starttime vsize rss …
  const ppid = Number(rest[1])
  const pgid = Number(rest[2])
  const rssPages = Number(rest[21])
  if (![pid, ppid, pgid, rssPages].every(Number.isFinite)) return null
  return { pid, ppid, pgid, rssPages }
}

/** `/proc/<pid>/cmdline` (NUL-separated) as `ps` prints `args`; a kernel thread has none. */
export const argsOfCmdline = (text: string): string => text.replace(/\0+$/, '').replace(/\0/g, ' ')

/** AT_PAGESZ (6) out of `/proc/self/auxv`: 8-byte little-endian pairs on 64-bit Linux. */
export function pageSizeFromAuxv(buf: Buffer): number | null {
  for (let i = 0; i + 16 <= buf.length; i += 16) {
    const type = Number(buf.readBigUInt64LE(i))
    if (type === 6) return Number(buf.readBigUInt64LE(i + 8))
    if (type === 0) break
  }
  return null
}

let pageSizeCache: number | null = null
async function hostPageSize(): Promise<number> {
  if (pageSizeCache) return pageSizeCache
  const fromAuxv = await readFile('/proc/self/auxv').then(pageSizeFromAuxv, () => null)
  pageSizeCache = fromAuxv && fromAuxv > 0 ? fromAuxv : 4096
  return pageSizeCache
}

export async function readProcTable(options: ProcScanOptions = {}): Promise<GuardProc[]> {
  const root = options.root ?? '/proc'
  const pageSize = options.pageSize ?? (await hostPageSize())
  const names = (await readdir(root)).filter((n) => /^\d+$/.test(n))
  const rows = await Promise.all(
    names.map(async (name): Promise<GuardProc | null> => {
      const dir = join(root, name)
      try {
        if (options.uid !== undefined && (await stat(dir)).uid !== options.uid) return null
        const [statText, cmdline] = await Promise.all([readFile(join(dir, 'stat'), 'utf8'), readFile(join(dir, 'cmdline'), 'utf8').catch(() => '')])
        const parsed = parseProcStat(statText)
        if (!parsed) return null
        const comm = /\((.*)\)/.exec(statText)?.[1] ?? name
        return { pid: parsed.pid, ppid: parsed.ppid, pgid: parsed.pgid, rssKb: Math.round((parsed.rssPages * pageSize) / 1024), args: argsOfCmdline(cmdline) || `[${comm}]` }
      } catch {
        // Gone between the listing and the read.
        return null
      }
    })
  )
  return rows.filter((r): r is GuardProc => r !== null)
}
