import { useSyncExternalStore } from "react";
import {
  emptyAccounts,
  type AccountProvider,
  type AccountsSnapshot,
} from "@server/shared/accounts";
import { client } from "../lib/tcserver/client";
import type { Link } from "../lib/tcserver/store";
import type { ServerPush } from "../lib/tcserver/types";

/**
 * Aliax's accounts as the server sees them: seeded by `accounts.list`,
 * then every rebuild arrives as a push. The server owns the model; this
 * store only holds the latest snapshot and the in-flight switch.
 */
export type AccountsState = {
  snapshot: AccountsSnapshot;
  loaded: boolean;
  /** The provider whose refresh or switch is running, if any. */
  busy: AccountProvider | null;
};

export const initialAccountsState = (): AccountsState => ({
  snapshot: emptyAccounts(),
  loaded: false,
  busy: null,
});

/** A push replaces the snapshot; an older one than what we hold is dropped. */
export function foldPush(state: AccountsState, push: ServerPush): AccountsState {
  if (push.push !== "accounts") return state;
  if (push.snapshot.updatedAt < state.snapshot.updatedAt) return state;
  return { ...state, snapshot: push.snapshot, loaded: true };
}

class AccountsStore {
  private state = initialAccountsState();
  private listeners = new Set<() => void>();
  private detach: (() => void)[] = [];
  private link: Link = client;

  connect(link: Link = client): void {
    for (const off of this.detach) off();
    this.link = link;
    this.detach = [
      link.onPush((push) => this.set(foldPush(this.state, push))),
      link.onOpen(() => void this.load(link)),
    ];
    if (link.connected) void this.load(link);
  }

  /** Test seam. */
  reset(): void {
    for (const off of this.detach) off();
    this.detach = [];
    this.link = client;
    this.state = initialAccountsState();
    this.emit();
  }

  get = (): AccountsState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async refresh(provider: AccountProvider): Promise<void> {
    if (this.state.busy) return;
    this.set({ ...this.state, busy: provider });
    try {
      const snapshot = await this.link.request<AccountsSnapshot>("accounts.refresh", { provider });
      this.set(foldPush(this.state, { push: "accounts", snapshot }));
    } finally {
      this.set({ ...this.state, busy: null });
    }
  }

  /** Make `name` the pinned account; the result's notes are Aliax's own wording. */
  async switch(
    provider: AccountProvider,
    name: string,
  ): Promise<{ ok: true; notes?: string[] } | { ok: false; error: string }> {
    if (this.state.busy) return { ok: false, error: "busy" };
    this.set({ ...this.state, busy: provider });
    try {
      return await this.link.request("accounts.switch", { provider, name });
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      this.set({ ...this.state, busy: null });
    }
  }

  private async load(link: Link): Promise<void> {
    try {
      const snapshot = await link.request<AccountsSnapshot>("accounts.list");
      this.set(foldPush(this.state, { push: "accounts", snapshot }));
    } catch (e) {
      console.warn("[accounts] list failed:", e);
    }
  }

  private set(next: AccountsState): void {
    if (next === this.state) return;
    this.state = next;
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

export const accountsStore = new AccountsStore();

export function useAccounts(): AccountsState {
  return useSyncExternalStore(accountsStore.subscribe, accountsStore.get, accountsStore.get);
}
