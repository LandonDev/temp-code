import { useSyncExternalStore } from "react";
import {
  emptyAccounts,
  type AccountProvider,
  type AccountsSnapshot,
} from "@server/shared/accounts";
import type { Link } from "../lib/connection";
import type { ServerPush } from "../lib/tcserver/types";

/**
 * Aliax's accounts as the server sees them: seeded by `accounts.list`,
 * then every rebuild arrives as a push. The server owns the model; this
 * store only holds the latest snapshot and the in-flight switch.
 */
export type AccountsState = {
  snapshot: AccountsSnapshot;
  loaded: boolean;
  /** The provider whose refresh is running, if any. */
  busy: AccountProvider | null;
};


export const initialAccountsState = (): AccountsState => ({
  snapshot: emptyAccounts(),
  loaded: false,
  busy: null,
});

const EMPTY_STATE = initialAccountsState();

/** A push replaces the snapshot; an older one than what we hold is dropped. */
export function foldPush(state: AccountsState, push: ServerPush): AccountsState {
  if (push.push !== "accounts") return state;
  if (push.snapshot.updatedAt < state.snapshot.updatedAt) return state;
  return { ...state, snapshot: push.snapshot, loaded: true };
}

/** Aliax accounts live on each host: one snapshot per environment. */
class AccountsStore {
  private states: ReadonlyMap<string, AccountsState> = new Map();
  private listeners = new Set<() => void>();
  private links = new Map<string, { link: Link; detach: (() => void)[] }>();
  private offRegistry: (() => void) | null = null;

  connect(registry: { onLink(listener: (link: Link, event: "added" | "removed") => void): () => void }): void {
    this.offRegistry?.();
    this.offRegistry = registry.onLink((link, event) => {
      if (event === "added") this.attach(link);
      else this.detach(link.environmentId);
    });
  }

  attach(link: Link): void {
    const id = link.environmentId;
    const current = this.links.get(id);
    if (current?.link === link) return;
    if (current) this.detach(id);
    const detach = [
      link.onPush((push) => this.set(id, foldPush(this.get(id), push))),
      link.onOpen(() => void this.load(link)),
    ];
    this.links.set(id, { link, detach });
    if (link.connected) void this.load(link);
  }

  detach(environmentId: string): void {
    const current = this.links.get(environmentId);
    if (!current) return;
    for (const off of current.detach) off();
    this.links.delete(environmentId);
    const next = new Map(this.states);
    next.delete(environmentId);
    this.states = next;
    this.emit();
  }

  /** Test seam. */
  reset(): void {
    this.offRegistry?.();
    this.offRegistry = null;
    for (const { detach } of this.links.values()) for (const off of detach) off();
    this.links.clear();
    this.states = new Map();
    this.emit();
  }

  get = (environmentId: string): AccountsState => this.states.get(environmentId) ?? EMPTY_STATE;

  /** Every environment's state, one map per change. */
  all = (): ReadonlyMap<string, AccountsState> => this.states;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(environmentId: string, provider: AccountProvider): Promise<void> {
    const link = this.links.get(environmentId)?.link;
    if (!link || this.get(environmentId).busy) return;
    this.set(environmentId, { ...this.get(environmentId), busy: provider });
    try {
      const snapshot = await link.request<AccountsSnapshot>("accounts.refresh", { provider });
      this.set(environmentId, foldPush(this.get(environmentId), { push: "accounts", snapshot }));
    } finally {
      this.set(environmentId, { ...this.get(environmentId), busy: null });
    }
  }

  private async load(link: Link): Promise<void> {
    try {
      const snapshot = await link.request<AccountsSnapshot>("accounts.list");
      this.set(link.environmentId, foldPush(this.get(link.environmentId), { push: "accounts", snapshot }));
    } catch (e) {
      console.warn(`[accounts] ${link.environmentId} list failed:`, e);
    }
  }

  private set(environmentId: string, next: AccountsState): void {
    if (next === this.states.get(environmentId)) return;
    const states = new Map(this.states);
    states.set(environmentId, next);
    this.states = states;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const accountsStore = new AccountsStore();

export function useAccounts(environmentId: string): AccountsState {
  return useSyncExternalStore(
    accountsStore.subscribe,
    () => accountsStore.get(environmentId),
    () => accountsStore.get(environmentId),
  );
}
