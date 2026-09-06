import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Link } from "./store";
import type { ServerPush, SlashCommand } from "./types";
import { COMMANDS_STALE_MS, commandKey, slashCommandStore } from "./slashCommands";

const cmd = (name: string, over: Partial<SlashCommand> = {}): SlashCommand => ({
  name,
  description: "",
  source: "skill",
  scope: "user",
  ...over,
});

class FakeLink implements Link {
  connected = true;
  calls: { method: string; params: unknown }[] = [];
  lists = new Map<string, SlashCommand[]>();
  fail = false;
  private openListeners = new Set<() => void>();
  request<T>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (this.fail) return Promise.reject(new Error("down"));
    const { provider, cwd } = params as { provider: string; cwd: string };
    return Promise.resolve((this.lists.get(commandKey(provider, cwd)) ?? []) as T);
  }
  onPush(_l: (push: ServerPush) => void) {
    return () => {};
  }
  onOpen(l: () => void) {
    this.openListeners.add(l);
    return () => this.openListeners.delete(l);
  }
  open() {
    for (const l of this.openListeners) l();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("slashCommandStore", () => {
  let link: FakeLink;
  beforeEach(() => {
    link = new FakeLink();
    link.lists.set("claude:/repo", [cmd("review")]);
    link.lists.set("codex:/repo", [cmd("ship", { source: "prompt" })]);
    slashCommandStore.connect(link);
  });
  afterEach(() => {
    slashCommandStore.reset();
    vi.useRealTimers();
  });

  it("keys entries by provider and cwd", async () => {
    await slashCommandStore.refresh("claude", "/repo");
    await slashCommandStore.refresh("codex", "/repo");
    expect(slashCommandStore.peek("claude", "/repo")?.map((c) => c.name)).toEqual(["review"]);
    expect(slashCommandStore.peek("codex", "/repo")?.map((c) => c.name)).toEqual(["ship"]);
    expect(slashCommandStore.peek("claude", "/other")).toBeUndefined();
    expect(link.calls.map((c) => c.params)).toEqual([
      { provider: "claude", cwd: "/repo" },
      { provider: "codex", cwd: "/repo" },
    ]);
  });

  it("shares one request between concurrent refreshes", async () => {
    const a = slashCommandStore.refresh("claude", "/repo");
    const b = slashCommandStore.refresh("claude", "/repo");
    expect(a).toBe(b);
    await a;
    expect(link.calls).toHaveLength(1);
  });

  it("turns a failed list into an empty one", async () => {
    link.fail = true;
    await expect(slashCommandStore.refresh("claude", "/repo")).resolves.toEqual([]);
    expect(slashCommandStore.peek("claude", "/repo")).toEqual([]);
  });

  it("is stale before the first load and again after the server's TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    expect(slashCommandStore.isStale("claude", "/repo")).toBe(true);
    await slashCommandStore.refresh("claude", "/repo");
    expect(slashCommandStore.isStale("claude", "/repo")).toBe(false);
    vi.setSystemTime(1_000_000 + COMMANDS_STALE_MS - 1);
    expect(slashCommandStore.isStale("claude", "/repo")).toBe(false);
    vi.setSystemTime(1_000_000 + COMMANDS_STALE_MS);
    expect(slashCommandStore.isStale("claude", "/repo")).toBe(true);
  });

  it("re-reads every known list when the socket reopens", async () => {
    await slashCommandStore.refresh("claude", "/repo");
    await slashCommandStore.refresh("codex", "/repo");
    link.lists.set("claude:/repo", [cmd("review"), cmd("deploy")]);
    link.open();
    await tick();
    expect(link.calls).toHaveLength(4);
    expect(slashCommandStore.peek("claude", "/repo")?.map((c) => c.name)).toEqual([
      "review",
      "deploy",
    ]);
  });

  it("notifies subscribers with a new snapshot", async () => {
    const seen: number[] = [];
    const off = slashCommandStore.subscribe(() => seen.push(slashCommandStore.getSnapshot().size));
    await slashCommandStore.refresh("claude", "/repo");
    off();
    await slashCommandStore.refresh("codex", "/repo");
    expect(seen).toEqual([1]);
  });
});
