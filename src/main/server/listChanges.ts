import { randomBytes } from 'node:crypto'

/**
 * The per-host change log a client resumes the session list from
 * (`session.changes`, CLAUDE.md "Launch: the rail paints from the launch
 * mirror"). Every meta the registry announces and every removal takes the
 * next seq; a client that mirrored the list at seq N asks for what
 * followed, and gets the metas that changed and the ids that left instead
 * of the whole list. The log is memory only and bounded: a seq older than
 * the window, or one minted by another run of this process (the
 * `generation` differs), answers `reset`, and the client lists whole.
 */

export const LIST_CHANGES_WINDOW = 5_000

export type ListChanges =
  | { reset: true; seq: number; generation: string }
  | { reset: false; seq: number; generation: string; changed: string[]; removed: string[] }

type Entry = { id: string; removed: boolean }

export class ListChangeLog {
  readonly generation: string
  private seq = 0
  /** seq → the entry at that seq, oldest first; trimmed to the window. */
  private entries = new Map<number, Entry>()
  /** The newest seq each id has; a removal supersedes its changes. */
  private latest = new Map<string, number>()
  /** The highest seq the window trimmed away: a resume from below it has
   *  lost entries. Compaction never raises it (the id's newer slot still
   *  says everything the old one did). */
  private evictedThrough = 0

  constructor(generation = randomBytes(6).toString('base64url'), private readonly window = LIST_CHANGES_WINDOW) {
    this.generation = generation
  }

  /** The newest seq minted. */
  get current(): number {
    return this.seq
  }

  /** The lowest afterSeq a resume can still be answered from. */
  get floor(): number {
    return this.evictedThrough
  }

  /** A meta changed (or appeared). */
  changed(id: string): number {
    return this.note({ id, removed: false })
  }

  /** The sessions left the host. */
  removed(ids: Iterable<string>): void {
    for (const id of ids) this.note({ id, removed: true })
  }

  /**
   * What followed `afterSeq`. `reset` when the generation is not this
   * run's, when afterSeq is ahead of the log (a client from a future that
   * never happened), or when the window no longer reaches back that far.
   * Otherwise each id once, in its newest state: removed if its last entry
   * was a removal, changed otherwise.
   */
  since(afterSeq: number, generation: string | undefined): ListChanges {
    const head = { seq: this.seq, generation: this.generation }
    if (generation !== this.generation || afterSeq > this.seq || !Number.isInteger(afterSeq) || afterSeq < 0) {
      return { reset: true, ...head }
    }
    if (afterSeq < this.evictedThrough) return { reset: true, ...head }
    const changed: string[] = []
    const removed: string[] = []
    const seen = new Set<string>()
    // Newest first so each id reports its final state once.
    const seqs = [...this.entries.keys()].filter((s) => s > afterSeq).sort((a, b) => b - a)
    for (const s of seqs) {
      const entry = this.entries.get(s)!
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      ;(entry.removed ? removed : changed).push(entry.id)
    }
    return { reset: false, ...head, changed: changed.reverse(), removed: removed.reverse() }
  }

  private note(entry: Entry): number {
    const seq = ++this.seq
    const previous = this.latest.get(entry.id)
    // One entry per id: the newest state is all a resume needs, and a
    // thread that streams a hundred metas a minute then holds one slot.
    if (previous !== undefined) this.entries.delete(previous)
    this.entries.set(seq, entry)
    this.latest.set(entry.id, seq)
    while (this.entries.size > this.window) {
      const first = this.entries.keys().next()
      if (first.done) break
      const old = this.entries.get(first.value)!
      this.entries.delete(first.value)
      this.evictedThrough = first.value
      if (this.latest.get(old.id) === first.value) this.latest.delete(old.id)
    }
    return seq
  }
}
