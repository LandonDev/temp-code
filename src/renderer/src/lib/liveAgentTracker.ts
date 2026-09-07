import { useSyncExternalStore } from "react";
import { liveAgentsFromSessions, type LiveAgent } from "./liveAgents";
import { nextUnseenFinishedSessions } from "./sessionDone";
import { loadLiveAgentsEnabled, subscribeLiveAgentsEnabled } from "./settings";
import { sessionStore } from "./tcserver/store";

/**
 * The rail's live-agent cards, kept outside React so a busy flip re-renders
 * the rail alone. Tracks which sessions finished while unfocused (they stay
 * on the rail as "Done" until looked at) the way App used to across renders.
 */
class LiveAgentTracker {
  private listeners = new Set<() => void>();
  private busyIds = new Set<string>();
  private unseen = new Set<string>();
  private focusedId: string | undefined;
  private enabled = loadLiveAgentsEnabled();
  private agents: LiveAgent[] = [];

  constructor() {
    sessionStore.subscribe(() => this.refresh());
    subscribeLiveAgentsEnabled(() => {
      this.enabled = loadLiveAgentsEnabled();
      this.refresh();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getAgents = (): LiveAgent[] => this.agents;

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
    const sessions = sessionStore.getSnapshot();
    const busy = new Set<string>();
    for (const session of sessions) if (session.busy) busy.add(session.id);
    this.unseen = nextUnseenFinishedSessions({
      previousBusyIds: this.busyIds,
      busyIds: busy,
      previousUnseenIds: this.unseen,
      focusedSessionId: this.focusedId,
    });
    this.busyIds = busy;
    const next = this.enabled ? liveAgentsFromSessions(sessions, this.unseen) : [];
    if (sameAgents(this.agents, next)) return;
    this.agents = next;
    for (const listener of this.listeners) listener();
  }
}

function sameAgents(a: LiveAgent[], b: LiveAgent[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i];
    return (
      x.id === y.id &&
      x.cwd === y.cwd &&
      x.title === y.title &&
      x.harness === y.harness &&
      x.activity === y.activity &&
      x.startedAt === y.startedAt &&
      x.durationMs === y.durationMs &&
      x.needsApproval === y.needsApproval &&
      x.done === y.done
    );
  });
}

export const liveAgentTracker = new LiveAgentTracker();

/** The rail's live agents as React state; the same array until a card changes. */
export function useLiveAgents(): LiveAgent[] {
  return useSyncExternalStore(liveAgentTracker.subscribe, liveAgentTracker.getAgents);
}
