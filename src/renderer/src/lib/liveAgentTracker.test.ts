import { describe, expect, it, vi } from "vitest";

vi.mock("./tcserver/store", () => ({ sessionStore: { subscribe: () => () => {}, getSnapshot: () => [] } }));

import { LiveAgentTracker } from "./liveAgentTracker";

/** A session store stand-in whose snapshot the test sets. */
function source() {
  let sessions: { id: string; busy?: boolean }[] = [];
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => sessions,
    set(next: { id: string; busy?: boolean }[]) {
      sessions = next;
      for (const listener of listeners) listener();
    },
  };
}

describe("LiveAgentTracker", () => {
  it("tells its listeners when a thread finishes unseen, and only when the set changes", () => {
    const store = source();
    const tracker = new LiveAgentTracker(store);
    const heard = vi.fn();
    tracker.subscribe(heard);
    store.set([{ id: "a", busy: true }]);
    expect(heard).not.toHaveBeenCalled();
    const before = tracker.version;
    store.set([{ id: "a", busy: false }]);
    expect(heard).toHaveBeenCalledOnce();
    expect(tracker.version).toBe(before + 1);
    expect([...tracker.unseenIds()]).toEqual(["a"]);
    const same = tracker.unseenIds();
    store.set([{ id: "a", busy: false }]);
    expect(heard).toHaveBeenCalledOnce();
    expect(tracker.unseenIds()).toBe(same);
  });

  it("forgets a thread once it is looked at", () => {
    const store = source();
    const tracker = new LiveAgentTracker(store);
    store.set([{ id: "a", busy: true }]);
    store.set([{ id: "a", busy: false }]);
    const heard = vi.fn();
    tracker.subscribe(heard);
    tracker.setFocused("a");
    expect(tracker.unseenIds().size).toBe(0);
    expect(heard).toHaveBeenCalledOnce();
  });
});
