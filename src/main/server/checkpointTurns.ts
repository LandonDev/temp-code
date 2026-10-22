import { isAbsolute, join } from 'node:path'
import type { ServerPush } from '@shared/contract'
import type { CheckpointStatus } from '@shared/contract-checkpoint'
import type { EventRow } from '@shared/events'
import { checkpointCwd, checkpointRoot, relativeToRoot, type CheckpointStore, type TouchedPath } from './checkpoint'
import type { LiveEditPush } from './livediff'
import { statusBudget, withBudget } from './spawnBudget'

/**
 * Undo checkpoints, kept by the host from its own turn events.
 *
 * A send arms the baseline (`ensure`, from sessions.ts armBaseline). A
 * settled live edit (livediff.ts) costs a set lookup: a path the session's
 * manifest does not know yet joins its unsaved paths. When the turn settles
 * (turn-complete, or a status of idle, error or paused) the unsaved paths
 * are written in one manifest write together with one sync (the newly dirty
 * paths no other session claims), and the sockets watching the thread hear
 * `checkpoint-changed`. During a long turn the unsaved paths are written at
 * most FLUSH_MS after the first, so a crash loses no more than that.
 *
 * Whether HEAD has a path comes from one `git ls-files` listing per root,
 * taken at the first write after an ensure; a path it does not know is
 * asked with one `ls-tree` for all of them at the settle. Nothing here runs
 * per window or per client, and a host with no socket open keeps the same
 * checkpoints.
 */

export const FLUSH_MS = 5_000
/** The statuses that end a turn, besides turn-complete. */
const SETTLES = new Set(['idle', 'error', 'paused'])
const EMPTY: ReadonlySet<string> = new Set()

export type CheckpointChangedPush = Extract<ServerPush, { push: 'checkpoint-changed' }>

export interface CheckpointTurnsDeps {
  store: Pick<CheckpointStore, 'ensure' | 'record' | 'status' | 'undo' | 'keep'>
  /** The session row; its cwd is the checkpoint's. */
  session: (sessionId: string) => { cwd?: string } | null | undefined
  /** Every path the index tracks under a root (`git ls-files -z`). */
  listTracked: (root: string) => Promise<Set<string>>
  /** Which of the paths HEAD has (one `git ls-tree`). */
  inHeadMany: (root: string, relatives: string[]) => Promise<Set<string>>
  /** To the sockets subscribed to the session. */
  push: (sessionId: string, frame: CheckpointChangedPush) => void
}

interface Turn {
  cwd: string
  root: string
  /** Every path the manifest knows; null when the session has no checkpoint here. */
  known: Promise<Set<string> | null>
  /** Paths touched since the last write. */
  unsaved: Set<string>
  /** Written paths the listing did not know; the settle asks HEAD. */
  unasked: Set<string>
  /** Armed or edited since the last settle. */
  open: boolean
  timer: ReturnType<typeof setTimeout> | null
}

export class CheckpointTurns {
  private readonly turns = new Map<string, Turn>()
  private readonly listings = new Map<string, Promise<Set<string>>>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: CheckpointTurnsDeps) {}

  /** Snapshot what is dirty before a turn; the registry's send calls it. */
  ensure(sessionId: string, cwd: string): Promise<void> {
    const ensured = this.deps.store.ensure(sessionId, cwd)
    const known = ensured.catch(() => {}).then(() => this.read(sessionId, cwd))
    const turn = this.turnFor(sessionId, cwd, known)
    turn.known = known
    turn.open = true
    this.listings.delete(turn.root)
    return ensured
  }

  /** A live edit; a settled one tells each owner with a checkpoint about its path. */
  async liveEdit(push: Pick<LiveEditPush, 'cwd' | 'sessionIds' | 'edit'>): Promise<void> {
    if (!push.edit.settled) return
    const path = isAbsolute(push.edit.path) ? push.edit.path : join(push.cwd, push.edit.path)
    await Promise.all(push.sessionIds.map((sessionId) => this.touch(sessionId, path)))
  }

  /** A row the registry appended; a settled turn writes the manifest. */
  async observe(row: EventRow): Promise<void> {
    const { event } = row
    if (event.type === 'turn-complete' || (event.type === 'status' && SETTLES.has(event.status))) {
      await this.settle(row.sessionId)
    }
  }

  status(sessionId: string): Promise<CheckpointStatus> {
    const cwd = checkpointCwd(this.deps.session(sessionId))
    return cwd ? this.deps.store.status(sessionId, cwd) : Promise.resolve({ files: [] })
  }

  undo(sessionId: string, relative?: string | null): Promise<CheckpointStatus> {
    return this.act(sessionId, relative, (cwd) => this.deps.store.undo(sessionId, cwd, relative))
  }

  keep(sessionId: string, relative?: string | null): Promise<CheckpointStatus> {
    return this.act(sessionId, relative, (cwd) => this.deps.store.keep(sessionId, cwd, relative))
  }

  /** Resolves once the session's queued writes are done. */
  written(sessionId: string): Promise<void> {
    return this.chains.get(sessionId) ?? Promise.resolve()
  }

  private async touch(sessionId: string, path: string): Promise<void> {
    const cwd = checkpointCwd(this.deps.session(sessionId))
    if (!cwd) return
    const turn = this.turnFor(sessionId, cwd)
    const known = await turn.known
    if (!known || this.turns.get(sessionId) !== turn) return
    const relative = relativeToRoot(turn.root, path)
    if (relative === null || known.has(relative)) return
    known.add(relative)
    turn.unsaved.add(relative)
    turn.open = true
    turn.timer ??= setTimeout(() => void this.flush(sessionId), FLUSH_MS)
  }

  /** Mid-turn: write the unsaved paths, HEAD answered by the listing alone. */
  private flush(sessionId: string): Promise<void> {
    return this.queue(sessionId, async () => {
      const turn = this.turns.get(sessionId)
      if (!turn) return
      this.stopTimer(turn)
      const known = await turn.known
      if (!known || turn.unsaved.size === 0) return
      const touched = this.take(turn, await this.listing(turn.root), null)
      const written = await this.deps.store.record(sessionId, turn.cwd, touched).catch(() => null)
      if (this.learn(turn, known, written)) this.changed(sessionId)
    })
  }

  /** The turn ended: one write, one sync, one push. A second settle with
   *  nothing since (turn-complete, then idle) does nothing. */
  private settle(sessionId: string): Promise<void> {
    return this.queue(sessionId, async () => {
      const turn = this.turns.get(sessionId)
      if (!turn) return
      const known = turn.open ? await turn.known : null
      turn.open = false
      this.stopTimer(turn)
      if (known) {
        const listed = turn.unsaved.size > 0 ? await this.listing(turn.root) : EMPTY
        const ask = [...turn.unasked, ...[...turn.unsaved].filter((relative) => !listed.has(relative))]
        const head = ask.length > 0 ? await this.deps.inHeadMany(turn.root, ask).catch(() => EMPTY) : EMPTY
        const touched = [
          ...[...turn.unasked].map((relative) => ({ relative, inHead: head.has(relative) })),
          ...this.take(turn, listed, head)
        ]
        turn.unasked.clear()
        // The settle's diff is a review diff: the panels' lane, never the sends'.
        const written = await withBudget(statusBudget, () =>
          this.deps.store.record(sessionId, turn.cwd, touched, { sync: true })
        ).catch(() => null)
        if (this.learn(turn, known, written)) this.changed(sessionId)
      }
      this.release(sessionId, turn)
    })
  }

  private async act(
    sessionId: string,
    relative: string | null | undefined,
    run: (cwd: string) => Promise<CheckpointStatus>
  ): Promise<CheckpointStatus> {
    const cwd = checkpointCwd(this.deps.session(sessionId))
    if (!cwd) return { files: [] }
    await this.flush(sessionId)
    const status = await run(cwd)
    // Undo all and Keep all drop the checkpoint; the next send arms a new one.
    if (relative == null) this.forget(sessionId)
    return status
  }

  /** The unsaved paths as marks, emptied. A path the listing does not know
   *  takes `head`'s answer, or waits unasked for the settle without one. */
  private take(turn: Turn, listed: ReadonlySet<string>, head: ReadonlySet<string> | null): TouchedPath[] {
    const touched = [...turn.unsaved].map((relative): TouchedPath => {
      const inHead = listed.has(relative) ? true : head ? head.has(relative) : null
      if (inHead === null) turn.unasked.add(relative)
      return { relative, inHead }
    })
    turn.unsaved.clear()
    return touched
  }

  /** Fold a write's answer into the turn; true when the checkpoint is there. */
  private learn(turn: Turn, known: Set<string>, written: Set<string> | null): boolean {
    if (!written) {
      turn.known = Promise.resolve(null)
      return false
    }
    for (const relative of written) known.add(relative)
    return true
  }

  private changed(sessionId: string): void {
    this.deps.push(sessionId, { push: 'checkpoint-changed', sessionId })
  }

  /** The tracked paths of a root, listed once until the next ensure there. */
  private listing(root: string): Promise<Set<string>> {
    let listed = this.listings.get(root)
    if (!listed) {
      listed = this.deps.listTracked(root).catch(() => new Set<string>())
      this.listings.set(root, listed)
    }
    return listed
  }

  private read(sessionId: string, cwd: string): Promise<Set<string> | null> {
    return this.deps.store.record(sessionId, cwd, []).catch(() => null)
  }

  /** The session's turn in `cwd`; a new one (reading the manifest unless
   *  `known` is given) when it has none, or had one in another cwd. */
  private turnFor(sessionId: string, cwd: string, known?: Promise<Set<string> | null>): Turn {
    const prior = this.turns.get(sessionId)
    if (prior?.cwd === cwd) return prior
    if (prior) this.stopTimer(prior)
    const turn: Turn = {
      cwd,
      root: checkpointRoot(cwd),
      known: known ?? this.read(sessionId, cwd),
      unsaved: new Set(),
      unasked: new Set(),
      open: false,
      timer: null
    }
    this.turns.set(sessionId, turn)
    return turn
  }

  /** A settled turn with nothing pending is forgotten (its listing too when
   *  no other turn there is open); a later edit reads the manifest again. */
  private release(sessionId: string, turn: Turn): void {
    if (turn.open || turn.unsaved.size > 0 || this.turns.get(sessionId) !== turn) return
    this.turns.delete(sessionId)
    if (![...this.turns.values()].some((other) => other.open && other.root === turn.root)) this.listings.delete(turn.root)
  }

  private forget(sessionId: string): void {
    const turn = this.turns.get(sessionId)
    if (turn) this.stopTimer(turn)
    this.turns.delete(sessionId)
  }

  private stopTimer(turn: Turn): void {
    if (turn.timer) clearTimeout(turn.timer)
    turn.timer = null
  }

  /** One session's writes run in order. */
  private queue(sessionId: string, work: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(sessionId) ?? Promise.resolve()).then(work).catch(() => {})
    this.chains.set(sessionId, next)
    void next.then(() => {
      if (this.chains.get(sessionId) === next) this.chains.delete(sessionId)
    })
    return next
  }
}
