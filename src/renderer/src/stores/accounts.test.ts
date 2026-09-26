import { afterEach, describe, expect, it } from "vitest";
import type { AccountsSnapshot } from "@server/shared/accounts";
import { emptyAccounts } from "@server/shared/accounts";
import type { Link } from "../lib/tcserver/store";
import type { ServerPush } from "../lib/tcserver/types";
import { accountsStore, foldPush, initialAccountsState } from "./accounts";

const snap = (updatedAt: number, pinned: string | null = null): AccountsSnapshot => {
  const s = emptyAccounts();
  s.updatedAt = updatedAt;
  s.providers.claude.pinned = pinned;
  return s;
};

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  listed = snap(10, "a");
  private pushes = new Set<(push: ServerPush) => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "accounts.list") return Promise.resolve(this.listed as T);
    if (method === "accounts.refresh") return Promise.resolve(snap(30, "a") as T);
    return Promise.reject(new Error(`unexpected ${method}`));
  }
  onPush(listener: (push: ServerPush) => void): () => void {
    this.pushes.add(listener);
    return () => this.pushes.delete(listener);
  }
  onOpen(): () => void {
    return () => {};
  }
  push(snapshot: AccountsSnapshot): void {
    for (const l of this.pushes) l({ push: "accounts", snapshot });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => accountsStore.reset());

describe("accounts store", () => {
  it("folds only accounts pushes, and never an older snapshot", () => {
    const s0 = initialAccountsState();
    expect(foldPush(s0, { push: "session-removed", sessionIds: [] })).toBe(s0);
    const s1 = foldPush(s0, { push: "accounts", snapshot: snap(20, "b") });
    expect(s1.loaded).toBe(true);
    expect(s1.snapshot.providers.claude.pinned).toBe("b");
    expect(foldPush(s1, { push: "accounts", snapshot: snap(5, "a") })).toBe(s1);
    expect(foldPush(s1, { push: "accounts", snapshot: snap(20, "c") }).snapshot.providers.claude.pinned).toBe("c");
  });

  it("seeds from accounts.list on connect and follows pushes", async () => {
    const link = new FakeLink();
    accountsStore.connect(link);
    await tick();
    expect(link.calls.map((c) => c.method)).toEqual(["accounts.list"]);
    expect(accountsStore.get().snapshot.providers.claude.pinned).toBe("a");
    link.push(snap(20, "b"));
    expect(accountsStore.get().snapshot.providers.claude.pinned).toBe("b");
    link.push(snap(15, "z"));
    expect(accountsStore.get().snapshot.providers.claude.pinned).toBe("b");
  });


  it("refresh takes the returned snapshot", async () => {
    const link = new FakeLink();
    accountsStore.connect(link);
    await tick();
    await accountsStore.refresh("claude");
    expect(accountsStore.get().snapshot.updatedAt).toBe(30);
    expect(accountsStore.get().busy).toBeNull();
  });
});
