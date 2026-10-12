import type { SessionMeta } from '@shared/events'
import type { Store } from './db'

/**
 * The cold file (db.ts): archived threads' logs leave `events` so every
 * scan of the hot table covers only live work. Two pieces live here:
 *
 * - ColdMover drains `store.coldBacklog()` in the background — archived
 *   sessions whose rows are still hot — in bounded transactions with a
 *   yield between them, so neither boot nor the loop waits on a 2M-row
 *   move. Resumable: a session half-moved when the app quit is in the
 *   backlog again next boot, and the copy is idempotent.
 * - sweepArchive archives whole idle thread trees (root and descendants)
 *   after `idleDays` without a touch, sparing anything a person or a
 *   harness still holds, and drops their checkpoint dirs.
 */

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

export interface MoverOptions {
  /** rows per transaction */
  batch?: number
  yieldNow?: () => Promise<void>
  onProgress?: (info: { sessionId: string; moved: number; done: boolean }) => void
}

export class ColdMover {
  private running: Promise<void> | null = null
  private again = false
  constructor(
    private readonly store: Store,
    private readonly opts: MoverOptions = {}
  ) {}

  /** Start a drain, or ask the running one to look again when it ends.
   *  Resolves when the backlog it saw is empty. */
  kick(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.drain().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.kick()
      }
    })
    return this.running
  }

  private async drain(): Promise<void> {
    // 5k rows (about 2.5 MB of payload) keeps one transaction under ~50 ms
    // on the loop; 20k batches blocked it for 200 ms each on a 4 GB file.
    const batch = this.opts.batch ?? 5_000
    const yieldNow = this.opts.yieldNow ?? yieldToLoop
    const { toCold, toHot } = this.store.coldBacklog()
    for (const id of toHot) {
      const moved = this.store.moveToHot(id)
      this.opts.onProgress?.({ sessionId: id, moved, done: true })
      await yieldNow()
    }
    for (const id of toCold) {
      for (;;) {
        // Unarchived while we worked: its rows came back with the flip.
        if (!this.store.getSession(id)?.archived) break
        const { moved, done } = this.store.moveToCold(id, batch)
        this.opts.onProgress?.({ sessionId: id, moved, done })
        if (done) break
        await yieldNow()
      }
      await yieldNow()
    }
  }
}

// ── archive sweep ────────────────────────────────────────────────────

export const ARCHIVE_IDLE_DAYS_KEY = 'archive.idleDays'
export const DEFAULT_ARCHIVE_IDLE_DAYS = 7

/** Statuses that mean a harness (or a person) still holds the thread. */
const LIVE = new Set<SessionMeta['status']>(['running', 'starting', 'waiting', 'paused', 'watching'])

export interface SweepInput {
  sessions: readonly SessionMeta[]
  now: number
  idleDays: number
  /** sessions with queued messages */
  queued: ReadonlySet<string>
  /** sessions in a saved workspace snapshot's open tabs */
  open: ReadonlySet<string>
}

/**
 * The sessions to archive: every unarchived member of a tree whose root
 * is idle past the window, where no member is pinned, live, queued or on
 * screen. A tree is judged whole — a subagent touched yesterday keeps its
 * week-old root, and a live root keeps all its descendants.
 */
export function archivable(input: SweepInput): string[] {
  const cutoff = input.now - input.idleDays * 86_400_000
  const kids = new Map<string | null, SessionMeta[]>()
  for (const s of input.sessions) {
    const list = kids.get(s.parentId) ?? []
    list.push(s)
    kids.set(s.parentId, list)
  }
  const out: string[] = []
  for (const root of kids.get(null) ?? []) {
    const tree: SessionMeta[] = []
    const stack = [root]
    while (stack.length) {
      const s = stack.pop()!
      tree.push(s)
      for (const k of kids.get(s.id) ?? []) stack.push(k)
    }
    if (tree.every((s) => s.archived)) continue
    const held = tree.some(
      (s) => s.pinned || LIVE.has(s.status) || input.queued.has(s.id) || input.open.has(s.id)
    )
    if (held) continue
    const touched = Math.max(...tree.map((s) => s.updatedAt))
    if (touched > cutoff) continue
    for (const s of tree) if (!s.archived) out.push(s.id)
  }
  return out
}

/** Session ids in every window's saved workspace snapshot: the leaves of
 *  each tab's layout plus the session stubs. Tolerant of shape drift —
 *  the snapshot is the renderer's and this only needs the ids. */
export function openSessionIds(snapshots: Iterable<string>): Set<string> {
  const ids = new Set<string>()
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as { type?: unknown; id?: unknown; children?: unknown }
    if (n.type === 'leaf' && typeof n.id === 'string') ids.add(n.id)
    if (Array.isArray(n.children)) for (const c of n.children) walk(c)
  }
  for (const raw of snapshots) {
    let snap: { tabs?: unknown; sessions?: unknown }
    try {
      snap = JSON.parse(raw) as typeof snap
    } catch {
      continue
    }
    if (Array.isArray(snap.tabs))
      for (const tab of snap.tabs) walk((tab as { layout?: unknown })?.layout)
    if (Array.isArray(snap.sessions))
      for (const s of snap.sessions) {
        const id = (s as { id?: unknown })?.id
        if (typeof id === 'string') ids.add(id)
      }
  }
  return ids
}

export interface SweepHost {
  store: Store
  list(): SessionMeta[]
  queueList(id: string): { length: number }
  setArchived(id: string, archived: boolean): Promise<void>
  checkpoints: { discard(id: string): Promise<void> } | null
}

export function archiveIdleDays(store: Store): number {
  const raw = Number(store.getSetting(ARCHIVE_IDLE_DAYS_KEY))
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ARCHIVE_IDLE_DAYS
}

/** One pass: archive what `archivable` names, one thread per loop turn,
 *  and drop each one's checkpoint dir. Returns the ids archived. */
export async function sweepArchive(
  host: SweepHost,
  opts: { now?: number; yieldNow?: () => Promise<void> } = {}
): Promise<string[]> {
  const yieldNow = opts.yieldNow ?? yieldToLoop
  const sessions = host.list()
  const ids = archivable({
    sessions,
    now: opts.now ?? Date.now(),
    idleDays: archiveIdleDays(host.store),
    queued: new Set(sessions.filter((s) => host.queueList(s.id).length > 0).map((s) => s.id)),
    open: openSessionIds(host.store.settingsWithPrefix('renderer.workspaceSnapshot.v1').values())
  })
  for (const id of ids) {
    try {
      await host.setArchived(id, true)
      await host.checkpoints?.discard(id)
    } catch (error) {
      console.error('[archive] sweep failed for', id, error)
    }
    await yieldNow()
  }
  return ids
}
