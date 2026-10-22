import { describe, expect, it, vi } from 'vitest'
import {
  ADMISSION_SETTING,
  Admission,
  budgetBytes,
  cgroupLimitBytes,
  DEFAULT_PER_PROCESS_MB,
  type AdmissionIo
} from './admission'

/**
 * Admission sizing (admission.ts) on fake OS reads: the cgroup budget, the
 * reserve per platform, the RSS median after five readings, the memory
 * floor, and the pinned cap.
 */

const GiB = 1024 ** 3

function fakeIo(over: Partial<AdmissionIo> & { files?: Record<string, string>; rss?: number[] } = {}): AdmissionIo {
  const files = over.files ?? {}
  return {
    platform: 'linux',
    readFile: (path) => files[path] ?? null,
    totalmem: () => 128 * GiB,
    freemem: () => 60 * GiB,
    rssKb: async (pids) => pids.map((_, i) => (over.rss ?? [])[i] ?? null),
    ...over
  }
}

/** The box: temp-code.service under agents.slice, the slice capped at 80 GiB high / 88 GiB max. */
const BOX_FILES: Record<string, string> = {
  '/proc/self/cgroup': '0::/agents.slice/temp-code.service\n',
  '/sys/fs/cgroup/agents.slice/temp-code.service/memory.high': 'max\n',
  '/sys/fs/cgroup/agents.slice/temp-code.service/memory.max': 'max\n',
  '/sys/fs/cgroup/agents.slice/memory.high': `${80 * GiB}\n`,
  '/sys/fs/cgroup/agents.slice/memory.max': `${88 * GiB}\n`,
  '/proc/meminfo': `MemTotal: ${128 * 1024 * 1024} kB\nMemAvailable: ${40 * 1024 * 1024} kB\n`
}

function admission(io: AdmissionIo, settings = new Map<string, string>(), pids: number[] = []) {
  return new Admission({
    io,
    getSetting: (k) => settings.get(k) ?? null,
    setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)),
    pids: () => pids,
    counts: () => ({ running: 3, queued: 1 })
  })
}

describe('the budget', () => {
  it('takes the tightest memory.high/max up the cgroup tree, ignoring max', () => {
    expect(cgroupLimitBytes(fakeIo({ files: BOX_FILES }))).toBe(80 * GiB)
    expect(budgetBytes(fakeIo({ files: BOX_FILES }))).toBe(80 * GiB)
  })

  it('falls back to total memory with no cgroup, or a cgroup without a limit, or off Linux', () => {
    expect(budgetBytes(fakeIo())).toBe(128 * GiB)
    expect(budgetBytes(fakeIo({ files: { '/proc/self/cgroup': '0::/user.slice\n', '/sys/fs/cgroup/user.slice/memory.max': 'max' } }))).toBe(128 * GiB)
    expect(budgetBytes(fakeIo({ platform: 'darwin', files: BOX_FILES, totalmem: () => 48 * GiB }))).toBe(48 * GiB)
  })

  it('is the machine when the cgroup allows more than it has', () => {
    expect(budgetBytes(fakeIo({ files: BOX_FILES, totalmem: () => 64 * GiB }))).toBe(64 * GiB)
  })
})

describe('the default cap', () => {
  it('on the box: (80 GiB − 25%) / 450 MB until five readings, then the median', async () => {
    const a = admission(fakeIo({ files: BOX_FILES, rss: [331 * 1024, 340 * 1024, 320 * 1024] }), new Map(), [1, 2, 3])
    expect(a.memory()).toMatchObject({ budgetMB: 81920, reserveMB: 20480, perProcessMB: DEFAULT_PER_PROCESS_MB })
    expect(a.defaultCap()).toBe(Math.floor((81920 - 20480) / 450))
    await a.sample()
    // Three readings: still the 450 MB guess.
    expect(a.memory().perProcessMB).toBe(450)
    await a.sample()
    // Six readings: the median of 320, 320, 331, 331, 340, 340.
    expect(a.memory().perProcessMB).toBe(331)
    expect(a.defaultCap()).toBe(Math.floor(61440 / 331))
  })

  it('on a 48 GiB Mac: the larger of 50% and 16 GiB stays free', () => {
    const a = admission(fakeIo({ platform: 'darwin', totalmem: () => 48 * GiB, freemem: () => 20 * GiB }))
    expect(a.memory()).toMatchObject({ budgetMB: 49152, reserveMB: 24576 })
    expect(a.defaultCap()).toBe(Math.floor(24576 / 450))
  })

  it('a small machine: the reserve floor (8 GiB on Linux, 16 GiB on a Mac) wins, and the cap never drops under one', () => {
    expect(admission(fakeIo({ totalmem: () => 16 * GiB })).memory().reserveMB).toBe(8192)
    expect(admission(fakeIo({ platform: 'darwin', totalmem: () => 16 * GiB })).defaultCap()).toBe(1)
  })

  it('a pid gone between the list and the read is skipped', async () => {
    const a = admission(fakeIo({ rss: [400 * 1024] }), new Map(), [1, 2])
    await a.sample()
    await a.sample()
    await a.sample()
    await a.sample()
    expect(a.memory().perProcessMB).toBe(450)
    await a.sample()
    expect(a.memory().perProcessMB).toBe(400)
  })
})

describe('the memory floor', () => {
  it('pauses admission under 10% of the budget available (MemAvailable on Linux)', () => {
    const files = { ...BOX_FILES, '/proc/meminfo': `MemAvailable: ${7 * 1024 * 1024} kB\n` }
    const a = admission(fakeIo({ files }))
    expect(a.memory()).toMatchObject({ freeMB: 7168, floorMB: 8192 })
    expect(a.memoryLow()).toBe(true)
    expect(admission(fakeIo({ files: BOX_FILES })).memoryLow()).toBe(false)
  })

  it('reads the kernel free percentage on a Mac, never os.freemem', async () => {
    let pct: number | null = 60
    const a = admission(
      fakeIo({ platform: 'darwin', totalmem: () => 48 * GiB, freemem: () => 0.1 * GiB, freePercent: async () => pct })
    )
    // Before the first read the floor is unknown, not tripped: os.freemem's 100 MB means nothing on a Mac.
    expect(a.memoryLow()).toBe(false)
    await a.refreshFree()
    expect(a.memory().freeMB).toBe(Math.round(0.6 * 48 * 1024))
    expect(a.memoryLow()).toBe(false)
    pct = 5
    await a.refreshFree()
    expect(a.memoryLow()).toBe(true)
    // A failed read keeps the last answer.
    pct = null
    await a.refreshFree()
    expect(a.memoryLow()).toBe(true)
  })
})

describe('the pinned cap', () => {
  it('wins over the default, and null goes back', () => {
    const settings = new Map<string, string>()
    const onChange = vi.fn()
    const a = new Admission({
      io: fakeIo({ files: BOX_FILES }),
      getSetting: (k) => settings.get(k) ?? null,
      setSetting: (k, v) => (v === null ? settings.delete(k) : settings.set(k, v)),
      pids: () => [],
      counts: () => ({ running: 118, queued: 7 }),
      onChange
    })
    const dflt = a.defaultCap()
    expect(a.state()).toMatchObject({ cap: dflt, pinned: null, default: dflt, running: 118, queued: 7 })
    expect(a.set(120)).toMatchObject({ cap: 120, pinned: 120, default: dflt })
    expect(settings.get(ADMISSION_SETTING)).toBe('120')
    expect(onChange).toHaveBeenCalled()
    expect(a.set(null)).toMatchObject({ cap: dflt, pinned: null })
    expect(settings.has(ADMISSION_SETTING)).toBe(false)
  })

  it('refuses a cap that is not a whole number from 1, and ignores a bad stored value', () => {
    const settings = new Map([[ADMISSION_SETTING, 'lots']])
    const a = admission(fakeIo({ files: BOX_FILES }), settings)
    expect(a.pinned()).toBeNull()
    expect(() => a.set(0)).toThrow(/whole number/)
    expect(() => a.set(2.5)).toThrow(/whole number/)
  })
})
