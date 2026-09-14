import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { ChipThread } from "../chrome/ThreadHeaderStrip";
import type { HeaderModel } from "../lib/threadHeaderModel";

/**
 * The title bar's projection of the tabs, published by `ShellTitleBar` after
 * each commit for App's callbacks to read: the project each tab shows, the
 * strip's tab order for cycling, the header model for picking a neighbour,
 * and the chip threads (the server's, plus local drafts).
 */
export type HeaderState = {
  tabProjects: ReadonlyMap<string, string>;
  stripTabs: readonly string[];
  model: HeaderModel<ChipThread>;
  chipThreads: readonly ChipThread[];
};

export function initialHeaderState(): HeaderState {
  return {
    tabProjects: new Map(),
    stripTabs: [],
    model: { live: [], dormant: [], activeId: null },
    chipThreads: [],
  };
}

/** Take the fields that changed; a publish that changes nothing keeps the state. */
export function publish(state: HeaderState, next: HeaderState): HeaderState {
  let out = state;
  for (const key of Object.keys(next) as (keyof HeaderState)[]) {
    if (out[key] === next[key]) continue;
    out = out === state ? { ...state } : out;
    (out as Record<keyof HeaderState, unknown>)[key] = next[key];
  }
  return out;
}

export const headerStore = createStore<HeaderState>()(
  subscribeWithSelector(() => initialHeaderState()),
);

/** The project name a tab shows, as of the last commit. */
export function tabProjectOf(tabId: string): string | undefined {
  return headerStore.getState().tabProjects.get(tabId);
}

export const header = {
  publish: (next: HeaderState) => headerStore.setState((s) => publish(s, next)),
};
