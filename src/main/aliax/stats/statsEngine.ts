import type { DatabaseSync } from 'node:sqlite'
import type { StatsBundle } from '@shared/aliaxStats'
import { indexAll, type IndexProgress, type IndexRoots } from './indexer'
import { computeBundle } from './queries'
import { openStatsDb, recordAppEvent, recordUsage } from './store'

/**
 * The stats index and bundle over one connection (CLAUDE.md "Stats off the
 * loop"): the CLIs' logs read into the store (indexer.ts), the page's bundle
 * computed from it (queries.ts) and cached until the store is written (an
 * index pass, a usage sample, an app event), the live samples and events
 * appended. Pure of plumbing: the stats worker (statsWorker.ts) runs one over
 * the app's stats.db and main asks it through statsHost.ts; a test or a
 * proof runs one in-process over a temp database.
 */
export interface StatsEngineOptions {
  dbPath: string
  /** Aliax's data dir, whose stats.db seeds a new database once. */
  seedDir?: string | null
  roots: IndexRoots
  onProgress?: (p: IndexProgress) => void
  now?: () => number
}

export class StatsEngine {
  readonly db: DatabaseSync
  private cached: StatsBundle | null = null
  private running: Promise<IndexProgress> | null = null
  private last: IndexProgress = { running: false, filesDone: 0, filesTotal: 0, rows: 0 }
  private readonly now: () => number

  constructor(private readonly opts: StatsEngineOptions) {
    this.db = openStatsDb(opts.dbPath, opts.seedDir)
    this.now = opts.now ?? Date.now
  }

  /** Index everything new; a pass already running is joined. */
  index(): Promise<IndexProgress> {
    if (this.running) return this.running
    this.running = indexAll(this.db, this.opts.roots, (p) => {
      this.last = p
      this.opts.onProgress?.(p)
    })
      .then((p) => {
        this.last = p
        this.cached = null
        return p
      })
      .finally(() => {
        this.running = null
      })
    return this.running
  }

  progress(): IndexProgress {
    return { ...this.last }
  }

  /** The page's bundle, computed once per write. */
  bundle(): StatsBundle {
    return (this.cached ??= computeBundle(this.db))
  }

  /** A live usage reading; a duplicate of the minute's changes nothing. */
  sample(service: string, account: string, label: string, usedPercent: number, resetsAt?: number, periodMs?: number): void {
    if (recordUsage(this.db, service, account, label, usedPercent, resetsAt, periodMs, this.now())) this.cached = null
  }

  appEvent(kind: string, service?: string, account?: string, detail?: string): void {
    recordAppEvent(this.db, kind, service, account, detail)
    this.cached = null
  }

  close(): void {
    this.db.close()
  }
}
