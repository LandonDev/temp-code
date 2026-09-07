import { useSyncExternalStore } from "react";
import { setRightRailOpen } from "./rightRail";

/** Which tab the project rail shows. Persisted; a fresh launch reopens the last one. */
export type RailPanel = "changes" | "files" | "branch" | "build" | "debug";

const KEY = "monocode.railPanel";
const PANELS: RailPanel[] = ["changes", "files", "branch", "build", "debug"];

function load(): RailPanel {
  try {
    const raw = localStorage.getItem(KEY);
    return PANELS.includes(raw as RailPanel) ? (raw as RailPanel) : "changes";
  } catch {
    return "changes";
  }
}

let panel: RailPanel = load();
const listeners = new Set<() => void>();

export function setRailPanel(next: RailPanel): void {
  if (next === panel) return;
  panel = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

/** ⌃D / "Debug this file": the session shows in the rail's Debug tab. */
export function showDebugRail(): void {
  setRailPanel("debug");
  setRightRailOpen(true);
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useRailPanel(): RailPanel {
  return useSyncExternalStore(subscribe, () => panel, () => panel);
}
