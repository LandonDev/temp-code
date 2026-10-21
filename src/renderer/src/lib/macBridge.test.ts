import { describe, expect, it } from "vitest";
import type { MacBridgeRequest } from "@server/shared/contract-macbridge";
import { bridgeableEnvironment, queueOf, quoteArgv, shownRequests } from "./macBridge";

describe("quoteArgv", () => {
  it("shows argv exactly as a shell would need it typed", () => {
    expect(quoteArgv(["xcrun", "simctl", "list"])).toBe("xcrun simctl list");
    expect(quoteArgv(["/bin/sh", "-c", "echo $HOME; rm -rf x"])).toBe("/bin/sh -c 'echo $HOME; rm -rf x'");
    expect(quoteArgv(["echo", "it's"])).toBe("echo 'it'\\''s'");
    expect(quoteArgv(["a b"])).toBe("'a b'");
  });
});

describe("bridgeableEnvironment", () => {
  it("only another host's threads", () => {
    expect(bridgeableEnvironment("local")).toBe(false);
    expect(bridgeableEnvironment("web")).toBe(false);
    expect(bridgeableEnvironment(undefined)).toBe(false);
    expect(bridgeableEnvironment("env_box")).toBe(true);
  });
});

const req = (
  id: string,
  over: Partial<MacBridgeRequest> & { createdAt: number }
): MacBridgeRequest => ({
  id,
  environmentId: "env_box",
  hostName: "box",
  sessionId: "s1",
  threadTitle: "thread",
  kind: "run",
  method: "mac.run",
  argv: ["echo", id],
  cwd: "/Users/me",
  expiresAt: over.createdAt + 600_000,
  status: "pending",
  ...over,
});

describe("shownRequests", () => {
  it("leaves quiet requests out and orders by age", () => {
    const list = shownRequests([
      req("b", { createdAt: 2 }),
      req("q", { createdAt: 1, status: "running", quiet: true }),
      req("a", { createdAt: 1 }),
    ]);
    expect(list.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("queueOf", () => {
  it("one waiting card per host, the oldest, with a count of the rest", () => {
    const queue = queueOf([
      req("c", { createdAt: 3 }),
      req("a", { createdAt: 1 }),
      req("b", { createdAt: 2 }),
      req("x", { createdAt: 2, environmentId: "env_other", hostName: "other" }),
    ]);
    expect(queue.pending.map((r) => r.id)).toEqual(["a", "x"]);
    expect(queue.more).toEqual({ env_box: 2 });
    expect(queue.running).toEqual([]);
  });

  it("the next card shows once the first is decided", () => {
    const all = [req("a", { createdAt: 1 }), req("b", { createdAt: 2 })];
    expect(queueOf(all).pending[0].id).toBe("a");
    const after = queueOf(all.filter((r) => r.id !== "a"));
    expect(after.pending[0].id).toBe("b");
    expect(after.more).toEqual({});
  });

  it("running commands fold into one line per host; quiet ones never appear", () => {
    const queue = queueOf([
      req("r1", { createdAt: 1, status: "running" }),
      req("r2", { createdAt: 2, status: "running", sessionId: "s2" }),
      req("quiet", { createdAt: 3, status: "running", quiet: true }),
      req("o", { createdAt: 4, status: "running", environmentId: "env_other", hostName: "other" }),
      req("p", { createdAt: 5 }),
    ]);
    expect(queue.running.map((g) => [g.hostName, g.requests.map((r) => r.id)])).toEqual([
      ["box", ["r1", "r2"]],
      ["other", ["o"]],
    ]);
    expect(queue.pending.map((r) => r.id)).toEqual(["p"]);
    expect(queue.more).toEqual({});
  });

  it("a screenful of requests still draws a bounded set", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      req(`r${i}`, { createdAt: i, status: i % 2 ? "running" : "pending" })
    );
    const queue = queueOf(many);
    expect(queue.pending).toHaveLength(1);
    expect(queue.more).toEqual({ env_box: 19 });
    expect(queue.running).toHaveLength(1);
    expect(queue.running[0].requests).toHaveLength(20);
  });
});
