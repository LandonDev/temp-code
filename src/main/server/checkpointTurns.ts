import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { ServerPush } from '@shared/contract'
import type { CheckpointStatus } from '@shared/contract-checkpoint'
import type { EventRow } from '@shared/events'
import {
  checkpointCwd,
  checkpointRoot,
  relativeToRoot,
  type CheckpointStore,
  type ManifestPaths,
  type TouchedPath
} from './checkpoint'
import type { LiveEditPush } from './livediff'
import { statusBudget, withBudget } from './spawnBudget'

/**
 * Undo checkpoints, kept by the host from its own turn events.
 *
 * Every send arms the baseline (`ensure`, from sessions.ts armBaseline: the
 * store snapshots what is dirty at the first send and, at every later one,
 * what became dirty between turns by the person's hand). A settled live
 * edit (livediff.ts) costs a set lookup: a path the session's manifest does
 * not know yet joins its unsaved paths, and a baseline path is left alone,
 * since the watcher cannot tell the agent's shell write from the person's
 * own save. A write tool's call (Edit, MultiEdit, Write, NotebookEdit)
 * touches the path its input names, a baseline path too (the agent edited
 * the person's file, and Undo restores their bytes): the tool writes
 * through a temporary name and renames it onto the target, so what reaches
 * the checkpoint as a settled edit can be the temporary file and never the
 * target (measured on a Mac, 2026-10-27: fs.watch itself reports the
 * target's rename with the file present and the temporary name created then
 * gone; livediff's ownership and settle decide what is emitted), and the
 * checkpoint must not depend on how a tool writes. The watcher stays for
 * what the shell writes. When the turn settles
 * (turn-complete, or a status of idle, error or paused) the unsaved paths
 * are written in one manifest write together with one sync (the newly dirty
 * paths no other session claims), and the sockets watching the thread hear
 * `checkpoint-changed`. During a long turn (and for the edits that settle
 * after it) the unsaved paths are written at most FLUSH_MS after the first,
 * asking git nothing, so a crash loses no more than that.
 *
 * At the settle, whether HEAD has each path written since the last one comes
 * from one `git ls-files` listing per root, taken at the first settle after
 * an ensure; the paths it does not know are asked with one `ls-tree` for all
 * of them. Nothing here runs per window or per client, and a host with no
 * socket open keeps the same checkpoints.
 */

export const FLUSH_MS = 5_000
/** The statuses that end a turn, besides turn-complete. */
const SETTLES = new Set(['idle', 'error', 'paused'])
const EMPTY: ReadonlySet<string> = new Set()
/** The tools whose input names the one file they write. */
const WRITE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The path a write tool's call names (`file_path`, a notebook's
 *  `notebook_path`), absolute or relative to the thread's cwd; null for
 *  any other tool or an input without one. */
export function writtenPath(name: string, input: unknown): string | null {
  if (!WRITE_TOOLS.has(name) || !input || typeof input !== 'object') return null
  const { file_path, notebook_path } = input as { file_path?: unknown; notebook_path?: unknown }
  const path = typeof file_path === 'string' ? file_path : typeof notebook_path === 'string' ? notebook_path : ''
  return path.trim() ? path : null
}

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
  /** What the manifest knows; null when the session has no checkpoint here. */
  known: Promise<ManifestPaths | null>
  /** Paths touched since the last write. */
  unsaved: Set<string>
  /** Paths written without asking HEAD; the settle asks. */
  unasked: Set<string>
  /** Armed or edited since the last settle. */
  open: boolean
  timer: ReturnType<typeof setTimeout> | null
}

const onDisk = (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

export class CheckpointTurns {
  private readonly turns = new Map<string, Turn>()
  private readonly listings = new Map<string, Promise<Set<string>>>()
  private readonly chains = new Map<string, Promise<void>>()

  constructor(private readonly deps: CheckpointTurnsDeps) {}

  /** Snapshot what is dirty before a turn (the person's baseline, refreshed
   *  at every send); the registry's send calls it. It runs behind the
   *  session's queued writes: the prior turn's settle may still wait on its
   *  listing or the status budget, and a refresh ahead of it would snapshot
   *  that turn's own files as the person's (gone from review, kept by Undo). */
  ensure(sessionId: string, cwd: string): Promise<void> {
    const ensured = this.queue(sessionId, () => this.deps.store.ensure(sessionId, cwd))
    const turn = this.turnFor(sessionId, cwd)
    // A touch from here on waits for the refreshed manifest (a write tool's
    // call can land before the ensure is done: its path must not be dropped
    // against a manifest that is not there yet). The settle and the flush
    // queued ahead of this ensure keep the `known` they had when queued
    // (settle, flush), so neither waits on an ensure behind it.
    turn.known = ensured.then(() => this.read(sessionId, cwd))
    turn.open = true
    this.listings.delete(turn.root)
    return ensured
  }

  /** A live edit; a settled one tells each owner with a checkpoint about its path. */
  async liveEdit(push: Pick<LiveEditPush, 'cwd' | 'sessionIds' | 'edit'>): Promise<void> {
    if (!push.edit.settled) return
    const path = isAbsolute(push.edit.path) ? push.edit.path : join(push.cwd, push.edit.path)
    await Promise.all(push.sessionIds.map((sessionId) => this.touch(sessionId, path, false)))
  }

  /** A row the registry appended: a write tool's complete call touches the
   *  path it names; a settled turn writes the manifest. */
  async observe(row: EventRow): Promise<void> {
    const { event } = row
    if (event.type === 'tool-call') {
      const path = event.partial ? null : writtenPath(event.name, event.input)
      if (path) await this.touch(row.sessionId, path, true)
    } else if (event.type === 'turn-complete' || (event.type === 'status' && SETTLES.has(event.status))) {
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

  /** A path a turn wrote. `tool`: a write tool's call named it, which claims
   *  even a baseline path (the agent edited the person's file); a live edit
   *  of a baseline path may be the person's own save and claims nothing. */
  private async touch(sessionId: string, path: string, tool: boolean): Promise<void> {
    const cwd = checkpointCwd(this.deps.session(sessionId))
    if (!cwd) return
    const turn = this.turnFor(sessionId, cwd)
    const known = await turn.known
    if (!known || this.turns.get(sessionId) !== turn) return
    const relative = relativeToRoot(turn.root, path)
    if (relative === null || known.touched.has(relative)) return
    if (!tool && known.baseline.has(relative)) return
    known.touched.add(relative)
    turn.unsaved.add(relative)
    turn.open = true
    turn.timer ??= setTimeout(() => void this.flush(sessionId), FLUSH_MS)
  }

  /** Mid-turn (or after it): write the unsaved paths that are on disk,
   *  asking git nothing; the settle tells the store which of them HEAD has.
   *  A path not on disk waits for the settle, which asks HEAD: a deleted
   *  tracked file is recorded then (the settle's sync claims it anyway), a
   *  temporary write file already gone is forgotten; an edit that settles
   *  after the turn (2 s after its last write) has no settle to follow its
   *  flush, so writing it here would list the temporary file for good. */
  private flush(sessionId: string): Promise<void> {
    // The turn and the manifest it knew when the flush was queued: an ensure
    // queued after it replaces the turn's promise with one that waits behind
    // this work, and a flush queued with no turn (Undo's, Keep's) has nothing
    // to write, whatever turn a send makes meanwhile.
    const turn = this.turns.get(sessionId)
    const knownWhenQueued = turn?.known
    return this.queue(sessionId, async () => {
      if (!turn || !knownWhenQueued || this.turns.get(sessionId) !== turn) return
      this.stopTimer(turn)
      const known = await knownWhenQueued
      if (!known || turn.unsaved.size === 0) return
      const present: string[] = []
      for (const relative of turn.unsaved) if (await onDisk(join(turn.root, relative))) present.push(relative)
      if (present.length === 0) return
      const touched = present.map((relative): TouchedPath => ({ relative, inHead: null }))
      for (const relative of present) {
        turn.unasked.add(relative)
        turn.unsaved.delete(relative)
      }
      const written = await this.deps.store.record(sessionId, turn.cwd, touched).catch(() => null)
      if (this.learn(turn, known, written)) this.changed(sessionId)
    })
  }

  /** The turn ended: one write, one sync, one push. A second settle with
   *  nothing since (turn-complete, then idle) does nothing. The flag is read
   *  here, not in the queued work, so the next send's ensure can never be
   *  taken for this turn's. */
  private settle(sessionId: string): Promise<void> {
    const turn = this.turns.get(sessionId)
    if (!turn) return Promise.resolve()
    const open = turn.open
    turn.open = false
    // Captured now: the next send's ensure replaces the turn's promise with
    // one that waits behind this settle.
    const knownWhenQueued = turn.known
    return this.queue(sessionId, async () => {
      const known = open ? await knownWhenQueued : null
      if (open) this.stopTimer(turn)
      if (known) {
        const pending = [...turn.unasked, ...turn.unsaved]
        turn.unasked.clear()
        turn.unsaved.clear()
        const listed = pending.length > 0 ? await this.listing(turn.root) : EMPTY
        const ask = pending.filter((relative) => !listed.has(relative))
        const head = ask.length > 0 ? await this.deps.inHeadMany(turn.root, ask).catch(() => EMPTY) : EMPTY
        const touched: TouchedPath[] = []
        const forget: string[] = []
        for (const relative of pending) {
          const inHead = listed.has(relative) || head.has(relative)
          // A path neither HEAD nor the disk has was made and removed inside
          // the turn (a tool's temporary write file): nothing to show or
          // undo, and a mid-turn flush that listed it is undone.
          if (inHead || (await onDisk(join(turn.root, relative)))) touched.push({ relative, inHead })
          else forget.push(relative)
        }
        // The settle's diff is a review diff: the panels' lane, never the sends'.
        const written = await withBudget(statusBudget, () =>
          this.deps.store.record(sessionId, turn.cwd, touched, { sync: true, forget })
        ).catch(() => null)
        for (const relative of forget) known.touched.delete(relative)
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

  /** Fold a write's answer into the turn; true when the checkpoint is there.
   *  (A touch made while the write ran stays known; a baseline entry a
   *  tool's touch outgrew is harmless behind the touched check.) */
  private learn(turn: Turn, known: ManifestPaths, written: ManifestPaths | null): boolean {
    if (!written) {
      turn.known = Promise.resolve(null)
      return false
    }
    for (const relative of written.touched) known.touched.add(relative)
    for (const relative of written.baseline) known.baseline.add(relative)
    return true
  }

  private changed(sessionId: string): void {
    this.deps.push(sessionId, { push: 'checkpoint-changed', sessionId })
  }

  /** The tracked paths of a root, listed once and kept until the next ensure
   *  there, or until no turn there is open (release). */
  private listing(root: string): Promise<Set<string>> {
    let listed = this.listings.get(root)
    if (!listed) {
      listed = this.deps.listTracked(root).catch(() => new Set<string>())
      this.listings.set(root, listed)
    }
    return listed
  }

  private read(sessionId: string, cwd: string): Promise<ManifestPaths | null> {
    return this.deps.store.record(sessionId, cwd, []).catch(() => null)
  }

  /** The session's turn in `cwd`; a new one (reading the manifest) when it
   *  has none, or had one in another cwd. */
  private turnFor(sessionId: string, cwd: string): Turn {
    const prior = this.turns.get(sessionId)
    if (prior?.cwd === cwd) return prior
    if (prior) this.stopTimer(prior)
    const turn: Turn = {
      cwd,
      root: checkpointRoot(cwd),
      known: this.read(sessionId, cwd),
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
    if (turn.open || turn.unsaved.size > 0 || turn.unasked.size > 0 || turn.timer) return
    if (this.turns.get(sessionId) !== turn) return
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
