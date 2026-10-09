import { useSyncExternalStore } from "react";
import {
  installPendingUpdate,
  runUpdateFlow,
  watchUpdateStatus,
  type UpdaterSnapshot,
} from "./updater";

/**
 * One update status for every surface: the sidebar footer, the Settings
 * Version row and the menu item all read and drive the same snapshot.
 * Probes once at launch, every half hour after that, and again when the
 * window regains focus if the last probe is older than five minutes. Main
 * checks on its own too and streams every change (including a build it is
 * running) through the status watch. The "update available" cue fires
 * once per version (see sounds.ts).
 */

export const CHECK_INTERVAL_MS = 30 * 60_000;
export const FOCUS_RECHECK_MS = 5 * 60_000;

const INITIAL: UpdaterSnapshot = { phase: "idle", currentVersion: "…" };

class UpdateStore {
  private state: UpdaterSnapshot = INITIAL;
  private listeners = new Set<() => void>();
  private lastCheckAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private onFocus: (() => void) | null = null;
  private unwatch: (() => void) | null = null;
  private inflight: Promise<UpdaterSnapshot> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): UpdaterSnapshot => this.state;

  start(): void {
    if (this.timer) return;
    this.unwatch = watchUpdateStatus((snapshot) => {
      if (!this.inflight) this.set(snapshot);
    });
    void this.check(false);
    this.timer = setInterval(() => void this.check(false), CHECK_INTERVAL_MS);
    if (typeof window !== "undefined") {
      this.onFocus = () => {
        if (Date.now() - this.lastCheckAt >= FOCUS_RECHECK_MS) {
          void this.check(false);
        }
      };
      window.addEventListener("focus", this.onFocus);
    }
  }

  /** Test seam. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.onFocus && typeof window !== "undefined") {
      window.removeEventListener("focus", this.onFocus);
    }
    this.onFocus = null;
    this.unwatch?.();
    this.unwatch = null;
    this.lastCheckAt = 0;
    this.inflight = null;
    this.state = INITIAL;
  }

  /**
   * Probe the feed. Manual checks show the native dialogs; automatic ones
   * stay quiet and leave a failed probe as idle. A busy store (checking or
   * installing) ignores the request.
   */
  check(manual: boolean): Promise<UpdaterSnapshot> {
    if (this.inflight) return this.inflight;
    if (installing(this.state)) return Promise.resolve(this.state);
    this.lastCheckAt = Date.now();
    const run = runUpdateFlow(manual, this.set).then((result) => {
      if (!manual && result.phase === "error") {
        this.set({ phase: "idle", currentVersion: result.currentVersion });
      }
      return this.state;
    });
    this.inflight = run.finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Download a waiting release, or restart into a downloaded one. */
  install(): Promise<UpdaterSnapshot> {
    if (this.state.phase !== "available" && this.state.phase !== "ready") {
      return Promise.resolve(this.state);
    }
    return installPendingUpdate(this.set);
  }

  private set = (next: UpdaterSnapshot): void => {
    this.state = next;
    for (const listener of this.listeners) listener();
  };
}

export const updateStore = new UpdateStore();

/** A download is running or waiting for its restart: no new checks. */
export function installing(snapshot: UpdaterSnapshot): boolean {
  return snapshot.phase === "downloading" || snapshot.phase === "ready";
}

export function useUpdateSnapshot(): UpdaterSnapshot {
  return useSyncExternalStore(updateStore.subscribe, updateStore.getSnapshot);
}
