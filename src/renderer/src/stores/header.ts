import { useEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";
import { createStore } from "zustand/vanilla";
import type { ChipThread } from "../chrome/ThreadHeaderStrip";
import { holdModel, type HeaderModel } from "../lib/threadHeaderModel";

/**
 * The title bar's projection of the tabs, published by `ShellTitleBar` after
 * each commit for App's callbacks to read: the project each tab shows, the
 * strip's tab order for cycling, the header model for picking a neighbour,
 * and the chip threads (the server's, plus local drafts). The model is the
 * row as the strip draws it, a held departure in its place (`stripHold`), so
 * ⌘1–9 and ⌃Tab walk the chips the person sees.
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

/** Whether the pointer is over the strip. The strip sets it; the title bar
 *  holds a departed chip in its place while it is (`holdModel`) before it
 *  publishes, so the drawn row and the published one are one list. */
export const stripHoldStore = createStore<{ holding: boolean }>()(() => ({ holding: false }));

export const stripHold = {
  set: (holding: boolean) => {
    if (stripHoldStore.getState().holding !== holding) stripHoldStore.setState({ holding });
  },
};

/**
 * The row as drawn and published: while the pointer is over the strip a
 * departed chip holds its place (`holdModel`), so ⌘1–9 and ⌃Tab walk what
 * the person sees.
 */
export function useHeldStripModel(headerModel: HeaderModel<ChipThread>): HeaderModel<ChipThread> {
  const holding = useStore(stripHoldStore, (s) => s.holding);
  const shownRef = useRef<readonly string[]>([]);
  const stripModel = useMemo(
    () => holdModel(headerModel, shownRef.current, holding),
    [headerModel, holding],
  );
  useEffect(() => {
    shownRef.current = stripModel.live.map((chip) => chip.id);
  }, [stripModel]);
  return stripModel;
}

// ── the strip's order ──────────────────────────────────────────────────

/** One project's chip order, and when the strip last showed it. */
export type StripOrderEntry = { ids: readonly string[]; seenAt: number };
export type StripOrder = Readonly<Record<string, StripOrderEntry>>;

const STRIP_ORDER_KEY = "monocode.stripOrder";
/** Ids kept per project: the newest arrivals win past it. */
export const STRIP_ORDER_CAP = 64;
/** A project the strip has not shown for this long drops out on load. */
export const STRIP_ORDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The saved order, with stale projects dropped; a corrupt value reads as empty. */
export function loadStripOrder(now = Date.now()): StripOrder {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STRIP_ORDER_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, StripOrderEntry> = {};
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      const { ids, seenAt } = (entry ?? {}) as Partial<StripOrderEntry>;
      if (!Array.isArray(ids) || typeof seenAt !== "number") continue;
      if (now - seenAt > STRIP_ORDER_TTL_MS) continue;
      out[key] = { ids: ids.filter((id): id is string => typeof id === "string").slice(-STRIP_ORDER_CAP), seenAt };
    }
    return out;
  } catch {
    return {};
  }
}

function saveStripOrder(order: StripOrder): void {
  try {
    localStorage.setItem(STRIP_ORDER_KEY, JSON.stringify(order));
  } catch {
    // private mode / quota
  }
}

/** Set one project's order; the same ids keep the state (and write nothing). */
export function withStripOrder(
  order: StripOrder,
  scopeKey: string,
  ids: readonly string[],
  now: number,
): StripOrder {
  const prev = order[scopeKey];
  const capped = ids.length > STRIP_ORDER_CAP ? ids.slice(-STRIP_ORDER_CAP) : ids;
  if (prev && prev.ids.length === capped.length && prev.ids.every((id, i) => id === capped[i])) {
    return order;
  }
  return { ...order, [scopeKey]: { ids: [...capped], seenAt: now } };
}

/**
 * The strip's chip order per project, keyed by the linked project's leader
 * id so the copies on every host share one order. Read by the title bar to
 * order the model before it publishes, so ⌘1–9 walk the chips as they sit.
 */
export const stripOrderStore = createStore<{ order: StripOrder }>()(() => ({
  order: loadStripOrder(),
}));

export const stripOrder = {
  of: (scopeKey: string): readonly string[] => stripOrderStore.getState().order[scopeKey]?.ids ?? [],
  set: (scopeKey: string, ids: readonly string[], now = Date.now()) => {
    const { order } = stripOrderStore.getState();
    const next = withStripOrder(order, scopeKey, ids, now);
    if (next === order) return;
    stripOrderStore.setState({ order: next });
    saveStripOrder(next);
  },
  /** Tests: read localStorage again. */
  reload: () => stripOrderStore.setState({ order: loadStripOrder() }),
};
