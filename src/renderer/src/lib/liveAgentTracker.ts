import { nextUnseenFinishedSessions } from "./sessionDone";
import { sessionStore } from "./tcserver/store";

type Source = { subscribe: (listener: () => void) => () => void; getSnapshot: () => readonly { id: string; busy?: boolean }[] };

/**
 * Which sessions finished while unfocused and have not been looked at since:
 * the idle sweep keeps their children so the person's next look is instant,
 * and the rail's Working section lists them as done. Kept outside React; it
 * follows the session store and the focused pane, and tells its listeners
 * when the set changes (`version` counts the changes).
 */
export class LiveAgentTracker {
  private busyIds = new Set<string>();
  private unseen: ReadonlySet<string> = new Set<string>();
  private focusedId: string | undefined;
  private listeners = new Set<() => void>();
  version = 0;

  constructor(private readonly source: Source = sessionStore) {
    source.subscribe(() => this.refresh());
  }

  /** Sessions that finished while unfocused and have not been looked at;
   *  the same object until the set changes. */
  unseenIds = (): ReadonlySet<string> => this.unseen;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  setFocused(id: string | undefined): void {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.refresh();
  }

  private refresh(): void {
    const busy = new Set<string>();
    for (const session of this.source.getSnapshot()) if (session.busy) busy.add(session.id);
    const next = nextUnseenFinishedSessions({
      previousBusyIds: this.busyIds,
      busyIds: busy,
      previousUnseenIds: this.unseen,
      focusedSessionId: this.focusedId,
    });
    this.busyIds = busy;
    if (next.size === this.unseen.size && [...next].every((id) => this.unseen.has(id))) return;
    this.unseen = next;
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

export const liveAgentTracker = new LiveAgentTracker();
