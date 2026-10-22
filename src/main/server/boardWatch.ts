import { BOARD_WATCH_MS } from '@shared/contract-batch'

/**
 * Which sockets watch which master's board: the `board` and `batch` pushes
 * go only to them (server/index.ts). A socket watches a master for
 * BOARD_WATCH_MS after it asked `batch.board` for it (the board asks again
 * inside the minute while it is on screen), and for as long as the thread
 * it has on screen is the master (`focus`).
 */
export class BoardWatch {
  /** connection → master → when it last asked `batch.board` */
  private readonly asked = new Map<number, Map<string, number>>()
  /** connection → the thread it has on screen */
  private readonly focused = new Map<number, string>()

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ms: number = BOARD_WATCH_MS
  ) {}

  /** The socket asked `batch.board` for this master. */
  ask(connection: number, masterId: string): void {
    let masters = this.asked.get(connection)
    if (!masters) this.asked.set(connection, (masters = new Map()))
    masters.set(masterId, this.now())
  }

  /**
   * The hook for `session.focus` (added on another branch): the handler
   * calls this with the thread the socket now has on screen, or null. A
   * socket focused on a master watches its board without asking again.
   */
  focus(connection: number, sessionId: string | null): void {
    if (sessionId) this.focused.set(connection, sessionId)
    else this.focused.delete(connection)
  }

  /** Does this socket hear the master's pushes now. */
  isWatching(connection: number, masterId: string): boolean {
    if (this.focused.get(connection) === masterId) return true
    const at = this.asked.get(connection)?.get(masterId)
    return at !== undefined && this.now() - at < this.ms
  }

  /** Does any socket hear the master's pushes now (nothing is computed for a master nobody watches). */
  watched(masterId: string): boolean {
    for (const connection of new Set([...this.asked.keys(), ...this.focused.keys()])) {
      if (this.isWatching(connection, masterId)) return true
    }
    return false
  }

  /** The socket closed. */
  drop(connection: number): void {
    this.asked.delete(connection)
    this.focused.delete(connection)
  }
}
