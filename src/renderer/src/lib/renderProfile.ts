/**
 * Render-time counters behind `__app.profile` (lib/appFacade.ts).
 *
 * main.tsx wraps the tree in `<Profiler id="app" onRender={recordCommit}>`
 * in dev and in measurement builds (TEMP_CODE_PROFILE=1, where
 * react-dom/client is the profiling reconciler); each commit adds its
 * actualDuration here. Between start() and stop() a PerformanceObserver
 * also counts long tasks (over 50 ms). A release build never imports the
 * Profiler branch and never starts the observer.
 */
import type { ProfilerOnRenderCallback } from "react";

export type RenderProfile = {
  /** root commits since start() */
  commits: number;
  /** sum of the root Profiler's actualDuration over those commits */
  renderMs: number;
  maxCommitMs: number;
  longTasks: number;
  longTaskMs: number;
};

const counts: RenderProfile = { commits: 0, renderMs: 0, maxCommitMs: 0, longTasks: 0, longTaskMs: 0 };
let observer: PerformanceObserver | null = null;

export const recordCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  counts.commits += 1;
  counts.renderMs += actualDuration;
  if (actualDuration > counts.maxCommitMs) counts.maxCommitMs = actualDuration;
};

function reset(): void {
  counts.commits = 0;
  counts.renderMs = 0;
  counts.maxCommitMs = 0;
  counts.longTasks = 0;
  counts.longTaskMs = 0;
}

export function startProfile(): void {
  stopObserver();
  reset();
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        counts.longTasks += 1;
        counts.longTaskMs += e.duration;
      }
    });
    observer.observe({ type: "longtask" });
  } catch {
    observer = null;
  }
}

/** The counters so far, without resetting them. */
export function readProfile(): RenderProfile {
  return { ...counts };
}

export function stopProfile(): RenderProfile {
  stopObserver();
  return readProfile();
}

function stopObserver(): void {
  observer?.disconnect();
  observer = null;
}
