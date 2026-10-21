import type { Store } from './db'
import type { SessionRegistry } from './sessions'

/**
 * Threads cut mid-turn by a shutdown come back at the next boot.
 *
 * The record is the `resume_after_boot` ledger: `SessionRegistry.append`
 * writes a thread's row on every running status and clears it when the turn
 * settles, and `recordForResume` (before-quit, the signal handlers) stamps
 * the shutdown's time on the rows when it gets to run; a death that skips it
 * (Chromium aborts on the D-Bus disconnect when systemd signals the whole
 * group, a SIGKILL, a power cut) leaves the right set behind all the same.
 * This side runs once the servers and the gateway are up: every recorded
 * thread gets a fresh harness on its transcript and one nudge saying the
 * host restarted (at the shutdown's time when known, else when this boot
 * ran), through the same `resumeStopped` the strip's Resume button uses. Four boot at a time, each
 * worker pausing a little between its threads, so fifty threads do not
 * start in one instant; subagents go before their parents, so an
 * orchestrator wakes to a fleet already moving. A thread the user paused
 * stays paused, and a thread that is gone is just forgotten.
 *
 * The result feeds one toast per boot in the rail ("7 threads resumed
 * after restart"): `notice` is what a socket connecting later is told, and
 * `onDone` what the sockets already open hear.
 */
export interface BootResumeResult {
  resumed: string[]
  /** Paused, archived, or no longer there. */
  skipped: string[]
  /** The harness did not boot or refused the nudge; the row reads error. */
  failed: string[]
  /** When this boot ran the resume; the key the renderer dedupes the toast by. */
  at: number
}

export interface BootResumeNotice {
  count: number
  at: number
}

export interface BootResumerDeps {
  store: Pick<Store, 'listResumeAfterBoot' | 'clearResumeAfterBoot' | 'getSession'>
  registry: Pick<SessionRegistry, 'resumeStopped' | 'resumePending'>
  /** How many harnesses boot at once. */
  width?: number
  /** The pause a worker takes between two of its threads. */
  gapMs?: number
  now?: () => number
  log?: (line: string) => void
}

export const BOOT_RESUME_WIDTH = 4
export const BOOT_RESUME_GAP_MS = 750

export class BootResumer {
  private readonly listeners = new Set<(notice: BootResumeNotice) => void>()
  private done: BootResumeNotice | null = null
  private running: Promise<BootResumeResult> | null = null

  constructor(private readonly deps: BootResumerDeps) {}

  /** The finished boot's notice, null before it ran and when nothing was resumed. */
  get notice(): BootResumeNotice | null {
    return this.done
  }

  onDone(listener: (notice: BootResumeNotice) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Resume everything recorded. Runs once; a second call returns the first run. */
  run(): Promise<BootResumeResult> {
    if (!this.running) this.running = this.resumeAll()
    return this.running
  }

  private async resumeAll(): Promise<BootResumeResult> {
    const { store, registry } = this.deps
    const now = this.deps.now ?? Date.now
    const log = this.deps.log ?? ((line: string) => console.log(line))
    const at = now()
    const result: BootResumeResult = { resumed: [], skipped: [], failed: [], at }
    const rows = store.listResumeAfterBoot()
    if (rows.length === 0) return result

    // Decide what still qualifies before any harness boots; the rest is
    // cleared at once so a restart mid-resume never replays it.
    const queue: { id: string; recordedAt: number; restartedAt: number; depth: number }[] = []
    for (const row of rows) {
      const meta = store.getSession(row.sessionId)
      if (!meta || meta.archived || meta.status === 'paused') {
        result.skipped.push(row.sessionId)
        continue
      }
      let depth = 0
      for (let cursor = meta; cursor.parentId; depth++) {
        const parent = store.getSession(cursor.parentId)
        if (!parent) break
        cursor = parent
      }
      queue.push({ id: row.sessionId, recordedAt: row.recordedAt, restartedAt: row.shutdownAt ?? at, depth })
    }
    store.clearResumeAfterBoot(result.skipped)
    // Deepest first (a subagent before its orchestrator), oldest record first within a depth.
    queue.sort((a, b) => b.depth - a.depth || a.recordedAt - b.recordedAt)
    for (const item of queue) registry.resumePending.add(item.id)
    log(`[resume] ${queue.length} thread(s) were mid-turn at the last shutdown; resuming ${Math.min(this.deps.width ?? BOOT_RESUME_WIDTH, queue.length)} at a time`)

    const width = Math.max(1, this.deps.width ?? BOOT_RESUME_WIDTH)
    const gapMs = this.deps.gapMs ?? BOOT_RESUME_GAP_MS
    let next = 0
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const item = queue[next++]!
        try {
          // A resumed thread writes its own fresh row (it is mid-turn again);
          // a skipped or failed one settled its row through its status.
          const resumed = await registry.resumeStopped(item.id, { restartedAt: item.restartedAt })
          ;(resumed ? result.resumed : result.skipped).push(item.id)
          if (!resumed) store.clearResumeAfterBoot([item.id])
        } catch (error) {
          result.failed.push(item.id)
          store.clearResumeAfterBoot([item.id])
          log(`[resume] ${item.id} did not come back: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          registry.resumePending.delete(item.id)
        }
        if (next < queue.length && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
      }
    }
    await Promise.all(Array.from({ length: Math.min(width, queue.length) }, worker))

    log(`[resume] ${result.resumed.length} resumed, ${result.skipped.length} skipped, ${result.failed.length} failed`)
    if (result.resumed.length > 0) {
      this.done = { count: result.resumed.length, at }
      for (const listener of this.listeners) listener(this.done)
    }
    return result
  }
}
