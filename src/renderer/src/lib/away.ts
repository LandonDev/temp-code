import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { AwayDecided, AwayState } from "@server/shared/away";
import type { AwaySnapshot } from "@server/shared/contract-away";
import { loadToast } from "../components/ui/toaster";
import { registry } from "./connection/registry";
import type { EnvLink } from "./connection/link";

/**
 * Away from computer (src/shared/away.ts): the person's own state, one copy
 * per host, mirrored between hosts by the hosts themselves. Each host's copy
 * and its tally of decisions come from one `away.get` when its link opens and
 * from every `away` push after. The rail's row (chrome/AwayRow.tsx) and the
 * menu read this machine's host (at /ui, the page's host); the return toast
 * (chrome/AwayReturn.tsx) reads every host's tally, live pushes only.
 */

export type HostAway = AwaySnapshot;

type State = {
  /** Each host's copy as it last said it, by environment id. */
  hosts: Readonly<Record<string, HostAway>>;
  /** The person's flip on the primary host, shown until the host's own word lands. */
  pending: AwayState | null;
};

export const awayStore = createStore<State>(() => ({ hosts: {}, pending: null }));

/** A live push changed a host's copy: what it was and what it is now. */
export type AwayPushListener = (environmentId: string, before: HostAway | undefined, after: HostAway) => void;

const pushListeners = new Set<AwayPushListener>();

/** Hear every live `away` push (never the `away.get` at a link's open). */
export function onAwayPush(listener: AwayPushListener): () => void {
  pushListeners.add(listener);
  return () => {
    pushListeners.delete(listener);
  };
}

function setHost(environmentId: string, snapshot: HostAway): void {
  const { hosts, pending } = awayStore.getState();
  const primary = environmentId === registry.primaryEnvironmentId;
  // The host's word settles a flip once it is as new as the flip.
  const settled = primary && pending && snapshot.state.at >= pending.at;
  awayStore.setState({ hosts: { ...hosts, [environmentId]: snapshot }, ...(settled ? { pending: null } : {}) });
}

async function load(link: EnvLink): Promise<void> {
  try {
    const snapshot = await link.request<AwaySnapshot>("away.get", {});
    setHost(link.environmentId, snapshot);
  } catch {
    // A host from before Away answers nothing: it has no state to show.
  }
}

/** Follow one host: its state at open, then its pushes. */
export function attachAwayLink(link: EnvLink): () => void {
  const offOpen = link.onOpen(() => void load(link));
  const offPush = link.onPush((push) => {
    if (push.push !== "away") return;
    const before = awayStore.getState().hosts[link.environmentId];
    const after = { state: push.state, decided: push.decided };
    setHost(link.environmentId, after);
    for (const listener of pushListeners) listener(link.environmentId, before, after);
  });
  if (link.connected) void load(link);
  return () => {
    offOpen();
    offPush();
  };
}

let started = false;
const attached = new Map<string, () => void>();

/** Follow every host's Away state; idempotent. */
export function startAway(): void {
  if (started) return;
  started = true;
  registry.onLink((link, event) => {
    attached.get(link.environmentId)?.();
    attached.delete(link.environmentId);
    if (event === "added") {
      attached.set(link.environmentId, attachAwayLink(link));
      return;
    }
    const { [link.environmentId]: _gone, ...hosts } = awayStore.getState().hosts;
    awayStore.setState({ hosts });
  });
}

/** This machine's Away (the page's host at /ui): the flip in flight, else the host's word. */
export function useAway(): { enabled: boolean; at: number } {
  const enabled = useStore(awayStore, (s) => (s.pending ?? s.hosts[registry.primaryEnvironmentId]?.state)?.enabled ?? false);
  const at = useStore(awayStore, (s) => (s.pending ?? s.hosts[registry.primaryEnvironmentId]?.state)?.at ?? 0);
  return { enabled, at };
}

/** Read now, outside React (the menu, a command). */
export function awayEnabled(): boolean {
  const s = awayStore.getState();
  return (s.pending ?? s.hosts[registry.primaryEnvironmentId]?.state)?.enabled ?? false;
}

/**
 * The person's flip: shown at once, stamped by the host. A refusal (a key
 * without approve, a host from before Away) puts the row back and says so.
 */
export async function setAway(enabled: boolean): Promise<void> {
  const flip: AwayState = { enabled, at: Date.now(), by: "" };
  awayStore.setState({ pending: flip });
  try {
    const link = registry.linkOf(registry.primaryEnvironmentId);
    const { state } = await link.request<{ state: AwayState }>("away.set", { enabled });
    // The push follows with the tally; until it lands the answer is the state.
    const now = awayStore.getState();
    if (now.pending !== flip) return;
    const heard = now.hosts[registry.primaryEnvironmentId]?.state.at ?? -1;
    awayStore.setState({ pending: heard >= state.at ? null : state });
  } catch {
    if (awayStore.getState().pending !== flip) return;
    awayStore.setState({ pending: null });
    void loadToast().then((toast) => toast.error(enabled ? "Couldn't turn Away on" : "Couldn't turn Away off"));
  }
}

/** The menu's and the keyboard's toggle. */
export function toggleAway(): void {
  void setAway(!awayEnabled());
}

/** How many threads a tally holds that decided at least once. */
export function decidedThreads(decided: AwayDecided | undefined): number {
  return decided ? decided.threads.filter((t) => t.count > 0).length : 0;
}

/** Tests: forget every host, the flip and the listener. */
export function resetAwayForTest(state: Partial<State> = {}): void {
  for (const off of attached.values()) off();
  attached.clear();
  started = false;
  pushListeners.clear();
  awayStore.setState({ hosts: {}, pending: null, ...state });
}
