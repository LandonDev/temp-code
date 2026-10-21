import { releaseVersion, type MasterRelease } from '../shared/deployDrift'

export type { MasterRelease }

/**
 * Master's release number, read from the public repo so a host can say how
 * far behind master it runs (src/shared/deployDrift.ts behindCount). The
 * Mac's main process fetches release.json raw from GitHub every ten
 * minutes, and again when a window comes forward after fifteen idle
 * minutes, the updater's own cadence (update.ts). No git, nothing faster,
 * and a failed fetch is silent: the last good value stands until the next
 * one lands. Headless hosts never fetch; the Mac compares for everyone.
 */
export const MASTER_RELEASE_URL = 'https://raw.githubusercontent.com/LandonDev/temp-code/master/release.json'
export const MASTER_FETCH_EVERY_MS = 10 * 60 * 1000
export const MASTER_FOCUS_RECHECK_MS = 15 * 60 * 1000
const FETCH_TIMEOUT_MS = 15_000

/** release.json's `n`, or null for anything that is not a positive integer. */
export function parseMasterRelease(text: string): number | null {
  try {
    const n = (JSON.parse(text) as { n?: unknown }).n
    return typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export interface MasterReleaseDeps {
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>
  now?: () => number
  url?: string
  /** Fires with every value that differs from the last one. */
  onChange?: (master: MasterRelease) => void
  log?: (line: string) => void
}

export class MasterReleaseWatcher {
  private last: MasterRelease | null = null
  private lastFetchAt = 0
  private inflight: Promise<MasterRelease | null> | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly deps: Required<Pick<MasterReleaseDeps, 'fetch' | 'now' | 'url'>> & MasterReleaseDeps

  constructor(deps: MasterReleaseDeps = {}) {
    this.deps = {
      ...deps,
      fetch: deps.fetch ?? ((url, init) => fetch(url, { ...init, cache: 'no-store' })),
      now: deps.now ?? Date.now,
      url: deps.url ?? MASTER_RELEASE_URL
    }
  }

  /** The last value that landed, or null before the first one. */
  current(): MasterRelease | null {
    return this.last
  }

  /** The first fetch now, then one every ten minutes. */
  start(): void {
    if (this.timer) return
    void this.refresh()
    this.timer = setInterval(() => void this.refresh(), MASTER_FETCH_EVERY_MS)
    this.timer.unref?.()
  }

  /** A window came forward: fetch again only when the last attempt is older than the focus recheck. */
  focus(): void {
    if (this.deps.now() - this.lastFetchAt > MASTER_FOCUS_RECHECK_MS) void this.refresh()
  }

  /** One fetch; never throws, and a failure leaves `current()` as it was. */
  refresh(): Promise<MasterRelease | null> {
    if (this.inflight) return this.inflight
    this.lastFetchAt = this.deps.now()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
    timeout.unref?.()
    this.inflight = (async () => {
      try {
        const res = await this.deps.fetch(this.deps.url, { signal: controller.signal })
        if (!res.ok) return this.last
        const n = parseMasterRelease(await res.text())
        if (n === null) return this.last
        const next: MasterRelease = { release: n, version: releaseVersion(n), fetchedAt: this.deps.now() }
        const changed = this.last?.release !== n
        this.last = next
        if (changed) this.deps.onChange?.(next)
        return next
      } catch (err) {
        this.deps.log?.(`[deploy] master release fetch failed: ${err instanceof Error ? err.message : String(err)}`)
        return this.last
      } finally {
        clearTimeout(timeout)
        this.inflight = null
      }
    })()
    return this.inflight
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
