import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import type { AdmissionMemory, AdmissionState } from '@shared/contract-admission'

/**
 * Admission control: how many harness processes may run on this host at
 * once. Hundreds of threads may exist; a bounded number run, the rest wait
 * `queued` in the scheduler (scheduler.ts) and start oldest first as slots
 * free.
 *
 * The cap is the `admission.maxRunning` setting when pinned, else sized
 * from memory: floor((budget − reserve) / perProcess).
 *   budget     the smaller of the process's cgroup memory.high / memory.max
 *              (any level up the cgroup v2 tree; `max` and absent ignored)
 *              and the machine's total memory;
 *   reserve    the larger of 25% of the budget and 8 GiB on Linux, of 50%
 *              and 16 GiB on macOS (the desktop, the browser, the IDE);
 *   perProcess the median RSS of the live harness children, read every
 *              60 s (/proc/<pid>/status VmRSS on Linux, `ps -o rss=`
 *              elsewhere), 450 MB until five readings exist.
 * Admission also pauses while available memory is under 10% of the
 * budget: MemAvailable on Linux; on macOS the kernel's free percentage
 * (`kern.memorystatus_level`, what `memory_pressure` prints), because
 * os.freemem() there counts only never-used pages and reads a few GiB on
 * a machine with half its memory to spare; os.freemem() elsewhere.
 *
 * Every OS read goes through `AdmissionIo`, so the sizing is tested on a
 * fake cgroup and fake samples.
 */

export const ADMISSION_SETTING = 'admission.maxRunning'
export const DEFAULT_PER_PROCESS_MB = 450
export const MIN_SAMPLES = 5
/** Readings kept for the median: enough for a full box, small enough to follow a change. */
const MAX_SAMPLES = 512
export const SAMPLE_EVERY_MS = 60_000
export const FREE_EVERY_MS = 15_000
export const LOW_MEMORY_FRACTION = 0.1
export const MAX_CAP = 10_000

const MB = 1024 * 1024
const GIB_MB = 1024

export interface AdmissionIo {
  platform: NodeJS.Platform
  /** A file's text, null when it cannot be read. */
  readFile(path: string): string | null
  totalmem(): number
  freemem(): number
  /** Resident set size in KB per pid, in the order given; null for a pid that is gone. */
  rssKb(pids: number[]): Promise<(number | null)[]>
  /** macOS: the kernel's free-memory percentage (kern.memorystatus_level); null when unknown. */
  freePercent?(): Promise<number | null>
}

export interface AdmissionDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string | null): void
  /** The live harness children's pids. */
  pids(): number[]
  /** Running slots taken and threads queued, as the scheduler counts them. */
  counts(): { running: number; queued: number }
  /** The cap or the memory floor moved: the scheduler looks again. */
  onChange?(): void
  io?: AdmissionIo
  log?(line: string): void
}

/** The tightest numeric memory.high / memory.max from the process's cgroup up to the root (cgroup v2). */
export function cgroupLimitBytes(io: Pick<AdmissionIo, 'readFile'>): number | null {
  const self = io.readFile('/proc/self/cgroup')
  if (!self) return null
  // v2: the one line `0::/agents.slice/temp-code.service`.
  const line = self.split('\n').find((l) => l.startsWith('0::'))
  if (!line) return null
  const parts = line.slice(3).trim().split('/').filter(Boolean)
  let limit: number | null = null
  for (let depth = parts.length; depth >= 0; depth--) {
    const dir = ['/sys/fs/cgroup', ...parts.slice(0, depth)].join('/')
    for (const file of ['memory.high', 'memory.max']) {
      const raw = io.readFile(`${dir}/${file}`)?.trim()
      if (!raw || raw === 'max') continue
      const n = Number(raw)
      if (Number.isFinite(n) && n > 0) limit = limit === null ? n : Math.min(limit, n)
    }
  }
  return limit
}

/** The budget in bytes: the cgroup's limit when tighter than the machine. */
export function budgetBytes(io: Pick<AdmissionIo, 'readFile' | 'totalmem' | 'platform'>): number {
  const total = io.totalmem()
  const cgroup = io.platform === 'linux' ? cgroupLimitBytes(io) : null
  return cgroup !== null ? Math.min(cgroup, total) : total
}

export function reserveMB(budgetMB: number, platform: NodeJS.Platform): number {
  return platform === 'darwin'
    ? Math.max(budgetMB * 0.5, 16 * GIB_MB)
    : Math.max(budgetMB * 0.25, 8 * GIB_MB)
}

/** floor((budget − reserve) / perProcess), never under one. */
export function defaultCap(budgetMB: number, reserve: number, perProcessMB: number): number {
  return Math.max(1, Math.floor((budgetMB - reserve) / Math.max(1, perProcessMB)))
}

export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Linux MemAvailable in bytes, null when /proc/meminfo has none. */
export function memAvailableBytes(io: Pick<AdmissionIo, 'readFile'>): number | null {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(io.readFile('/proc/meminfo') ?? '')
  return m ? Number(m[1]) * 1024 : null
}

export function parsePinned(raw: string | null): number | null {
  if (raw === null) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_CAP) : null
}

export class Admission {
  private readonly io: AdmissionIo
  private readonly samples: number[] = []
  private budget: number
  /** Available memory; null on a Mac before the kernel's first answer (unknown is not low). */
  private freeBytes: number | null
  private timers: ReturnType<typeof setInterval>[] = []
  private lastCap: number | null = null
  private lastLow: boolean | null = null

  constructor(private readonly deps: AdmissionDeps) {
    this.io = deps.io ?? nodeIo()
    this.budget = budgetBytes(this.io)
    this.freeBytes = this.kernelFree() ? null : this.syncFree()
  }

  /** macOS: free memory is the kernel's percentage, read off the main path. */
  private kernelFree(): boolean {
    return this.io.platform === 'darwin' && !!this.io.freePercent
  }

  /** Read RSS every minute and free memory every 15 s; both timers unref'd. */
  start(): void {
    if (this.timers.length) return
    const rss = setInterval(() => void this.sample(), SAMPLE_EVERY_MS)
    const free = setInterval(() => void this.refreshFree(), FREE_EVERY_MS)
    rss.unref?.()
    free.unref?.()
    this.timers = [rss, free]
    void this.refreshFree()
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  /** One RSS reading of every live harness child. */
  async sample(): Promise<void> {
    this.budget = budgetBytes(this.io)
    const pids = this.deps.pids()
    if (pids.length > 0) {
      try {
        const kb = await this.io.rssKb(pids)
        for (const v of kb) if (v !== null && v > 0) this.samples.push(v / 1024)
        if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
      } catch (error) {
        this.deps.log?.(`[admission] rss read failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    this.changed()
  }

  async refreshFree(): Promise<void> {
    if (this.kernelFree()) {
      // A failed read keeps the last answer: os.freemem() there would read low.
      const pct = await this.io.freePercent!().catch(() => null)
      if (pct !== null) this.freeBytes = (pct / 100) * this.io.totalmem()
    } else {
      this.freeBytes = this.syncFree()
    }
    this.changed()
  }

  private syncFree(): number {
    if (this.io.platform === 'linux') return memAvailableBytes(this.io) ?? this.io.freemem()
    return this.io.freemem()
  }

  pinned(): number | null {
    return parsePinned(this.deps.getSetting(ADMISSION_SETTING))
  }

  memory(): AdmissionMemory {
    const budgetMB = Math.round(this.budget / MB)
    return {
      budgetMB,
      reserveMB: Math.round(reserveMB(budgetMB, this.io.platform)),
      perProcessMB: Math.round(this.samples.length >= MIN_SAMPLES ? median(this.samples) : DEFAULT_PER_PROCESS_MB),
      freeMB: Math.round((this.freeBytes ?? this.io.freemem()) / MB),
      floorMB: Math.round(budgetMB * LOW_MEMORY_FRACTION)
    }
  }

  defaultCap(): number {
    const m = this.memory()
    return defaultCap(m.budgetMB, m.reserveMB, m.perProcessMB)
  }

  cap(): number {
    return this.pinned() ?? this.defaultCap()
  }

  /** Available memory is under the floor: admit nothing new until it recovers. */
  memoryLow(): boolean {
    if (this.freeBytes === null) return false
    const m = this.memory()
    return m.freeMB < m.floorMB
  }

  state(): AdmissionState {
    const { running, queued } = this.deps.counts()
    return { cap: this.cap(), pinned: this.pinned(), default: this.defaultCap(), running, queued, memory: this.memory() }
  }

  /** Pin the cap (a number) or go back to the default (null). */
  set(cap: number | null): AdmissionState {
    if (cap !== null && (!Number.isInteger(cap) || cap < 1 || cap > MAX_CAP)) {
      throw new Error(`admission cap must be a whole number from 1 to ${MAX_CAP}`)
    }
    this.deps.setSetting(ADMISSION_SETTING, cap === null ? null : String(cap))
    this.changed()
    return this.state()
  }

  private changed(): void {
    const cap = this.cap()
    const low = this.memoryLow()
    if (cap === this.lastCap && low === this.lastLow) return
    this.lastCap = cap
    this.lastLow = low
    this.deps.onChange?.()
  }
}

function nodeIo(): AdmissionIo {
  const run = (cmd: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) =>
      // `ps` exits 1 when any pid is gone; what it printed is still good.
      execFile(cmd, args, { timeout: 10_000 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)))
    )
  return {
    platform: process.platform,
    readFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    totalmem: () => os.totalmem(),
    freemem: () => os.freemem(),
    rssKb: async (pids) => {
      if (process.platform === 'linux') {
        return pids.map((pid) => {
          try {
            const m = /^VmRSS:\s+(\d+)\s*kB/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))
            return m ? Number(m[1]) : null
          } catch {
            return null
          }
        })
      }
      const out = await run('ps', ['-o', 'pid=,rss=', '-p', pids.join(',')]).catch(() => '')
      const byPid = new Map<number, number>()
      for (const line of out.split('\n')) {
        const [pid, rss] = line.trim().split(/\s+/).map(Number)
        if (pid && Number.isFinite(rss)) byPid.set(pid, rss!)
      }
      return pids.map((pid) => byPid.get(pid) ?? null)
    },
    freePercent: async () => {
      const n = Number((await run('sysctl', ['-n', 'kern.memorystatus_level'])).trim())
      return Number.isFinite(n) && n > 0 && n <= 100 ? n : null
    }
  }
}
