import { nextUnseenFinishedSessions } from "./sessionDone";
import { sessionStore } from "./tcserver/store";

/**
 * Which sessions finished while unfocused and have not been looked at since:
 * the idle sweep keeps their children so the person's next look is instant.
 * Kept outside React; it follows the session store and the focused pane.
 */
class LiveAgentTracker {
  private busyIds = new Set<string>();
  private unseen = new Set<string>();
  private focusedId: string | undefined;

  constructor() {
    sessionStore.subscribe(() => this.refresh());
  }

  /** Sessions that finished while unfocused and have not been looked at. */
  unseenIds(): ReadonlySet<string> {
    return this.unseen;
  }

  setFocused(id: string | undefined): void {
    if (id === this.focusedId) return;
    this.focusedId = id;
    this.refresh();
  }

  private refresh(): void {
    const busy = new Set<string>();
    for (const session of sessionStore.getSnapshot()) if (session.busy) busy.add(session.id);
    this.unseen = nextUnseenFinishedSessions({
      previousBusyIds: this.busyIds,
      busyIds: busy,
      previousUnseenIds: this.unseen,
      focusedSessionId: this.focusedId,
    });
    this.busyIds = busy;
  }
}

export const liveAgentTracker = new LiveAgentTracker();
