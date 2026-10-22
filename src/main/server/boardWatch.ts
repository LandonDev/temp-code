import { BOARD_WATCH_MS } from '@shared/contract-batch'

/** What the watch reads of the sockets' focus (focus.ts FocusSet, `session.focus`). */
export interface BoardFocus {
  /** The thread the socket has on screen, or null. */
  focusOf(connection: number): string | null
  /** The threads sockets have on screen, before any widening. */
  focused(): Iterable<string>
}

const NO_FOCUS: BoardFocus = { focusOf: () => null, focused: () => [] }

/**
 * Which sockets watch which master's board: the `board` and `batch` pushes
 * go only to them (server/index.ts). A socket watches a master while the
 * thread it has on screen is the master (`session.focus`), and for
 * BOARD_WATCH_MS after it asked `batch.board` for it (a board shown beside
 * the focused pane asks again inside the minute).
 */
export class BoardWatch {
  /** connection → master → when it last asked `batch.board` */
  private readonly asked = new Map<number, Map<string, number>>()

  constructor(
    private readonly focus: BoardFocus = NO_FOCUS,
    private readonly now: () => number = Date.now,
    private readonly ms: number = BOARD_WATCH_MS
  ) {}

  /** The socket asked `batch.board` for this master. */
  ask(connection: number, masterId: string): void {
    let masters = this.asked.get(connection)
    if (!masters) this.asked.set(connection, (masters = new Map()))
    masters.set(masterId, this.now())
  }

  /** Does this socket hear the master's pushes now. */
  isWatching(connection: number, masterId: string): boolean {
    if (this.focus.focusOf(connection) === masterId) return true
    const at = this.asked.get(connection)?.get(masterId)
    return at !== undefined && this.now() - at < this.ms
  }

  /** Does any socket hear the master's pushes now (nothing is computed for a master nobody watches). */
  watched(masterId: string): boolean {
    for (const id of this.focus.focused()) if (id === masterId) return true
    for (const connection of this.asked.keys()) if (this.isWatching(connection, masterId)) return true
    return false
  }

  /** The socket closed (its focus goes with focus.ts's own drop). */
  drop(connection: number): void {
    this.asked.delete(connection)
  }
}
