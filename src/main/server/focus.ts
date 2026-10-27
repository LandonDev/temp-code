/**
 * The interactive set: the threads a person is looking at right now. Each
 * socket names at most one (`session.focus`, the focused pane of its
 * window, null on blur); the set is the union across sockets, widened to
 * what that thread shows: its subagents (the parent chain up to the
 * focused one) and, for a focused master, every root carrying its id and
 * their subagents. A closed socket drops its focus.
 *
 * The lane gate (lane.ts) runs this set's requests first, the push
 * coalescer (wire.ts) sends a socket's own focused rows at once, and the
 * scheduler's admission reads `isInteractive`.
 */

/** What the set needs from the session rows: a thread's parent, and a root's master. */
export interface SessionLinks {
  parentOf(sessionId: string): string | null
  masterOf(rootId: string): string | null
}

const MAX_HOPS = 20

export class FocusSet {
  private byConnection = new Map<number, string>()
  /** focused id → how many sockets name it */
  private counts = new Map<string, number>()

  constructor(private readonly links: SessionLinks) {}

  /** A socket's focus, replacing what it named before; null clears it. */
  set(connection: number, sessionId: string | null): void {
    const prev = this.byConnection.get(connection)
    if (prev === sessionId) return
    if (prev !== undefined) this.release(prev)
    if (sessionId === null) {
      this.byConnection.delete(connection)
      return
    }
    this.byConnection.set(connection, sessionId)
    this.counts.set(sessionId, (this.counts.get(sessionId) ?? 0) + 1)
  }

  /** The socket closed. */
  drop(connection: number): void {
    this.set(connection, null)
  }

  focusOf(connection: number): string | null {
    return this.byConnection.get(connection) ?? null
  }

  /** The ids sockets name, before widening. */
  focused(): string[] {
    return [...this.counts.keys()]
  }

  /** A socket names this exact thread: on screen now (a focused subagent or master does not count for its root or batch). */
  isNamed(sessionId: string): boolean {
    return this.counts.has(sessionId)
  }

  /** In the union across sockets: focused, under a focused thread, or in a focused master's batch. */
  isInteractive(sessionId: string): boolean {
    if (this.counts.size === 0) return false
    return this.reaches(sessionId, (id) => this.counts.has(id))
  }

  /** What this one socket shows: its focused thread and everything that widens to. */
  isFocusedBy(connection: number, sessionId: string): boolean {
    const focus = this.byConnection.get(connection)
    if (focus === undefined) return false
    return this.reaches(sessionId, (id) => id === focus)
  }

  private release(sessionId: string): void {
    const n = (this.counts.get(sessionId) ?? 0) - 1
    if (n > 0) this.counts.set(sessionId, n)
    else this.counts.delete(sessionId)
  }

  /** The thread, each ancestor, then the root's master, until one is focused. */
  private reaches(sessionId: string, focused: (id: string) => boolean): boolean {
    let cur = sessionId
    for (let hops = 0; hops < MAX_HOPS; hops++) {
      if (focused(cur)) return true
      const parent = this.links.parentOf(cur)
      if (!parent) break
      cur = parent
    }
    const master = this.links.masterOf(cur)
    return master !== null && focused(master)
  }
}
