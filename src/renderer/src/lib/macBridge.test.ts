import { describe, expect, it } from "vitest";
import type { MacBridgeRequest } from "@server/shared/contract-macbridge";
import {
  bridgeableEnvironment,
  heldLine,
  heldSuffix,
  heldTotal,
  inFlightRequests,
  queueOf,
  quoteArgv,
  shownRequests,
} from "./macBridge";

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

const held = (position: number, reason: "cap" | "load" = "cap") => ({
  reason,
  position,
  load: reason === "load" ? 12.3 : 1.2,
  limit: 8,
  cores: 4,
  maxRunning: 4,
  running: 4,
});

describe("held requests (the load guard)", () => {
  it("heldLine says why and where: the load figure, or the host's running count, and the place in line", () => {
    expect(heldLine(held(3, "load"))).toBe("Waiting for the Mac · load 12.3 of 8 · 3rd in line");
    expect(heldLine(held(1))).toBe("Waiting for the Mac · 4 of 4 running · 1st in line");
    expect(heldLine(held(2))).toBe("Waiting for the Mac · 4 of 4 running · 2nd in line");
    expect(heldLine(held(11))).toBe("Waiting for the Mac · 4 of 4 running · 11th in line");
    expect(heldLine(held(22))).toBe("Waiting for the Mac · 4 of 4 running · 22nd in line");
    expect(heldLine({ ...held(1, "load"), limit: 4.5 })).toBe("Waiting for the Mac · load 12.3 of 4.5 · 1st in line");
  });

  it("a held request is never a card: shownRequests and queueOf leave it out", () => {
    const all = [
      req("r", { createdAt: 1, status: "running" }),
      req("h", { createdAt: 2, status: "held", held: held(1) }),
      req("p", { createdAt: 3 }),
    ];
    expect(shownRequests(all).map((r) => r.id)).toEqual(["r", "p"]);
    const queue = queueOf(all);
    expect(queue.pending.map((r) => r.id)).toEqual(["p"]);
    expect(queue.running[0].requests.map((r) => r.id)).toEqual(["r"]);
  });

  it("inFlightRequests lists the running ones first, then the held ones in line order, quiet included, for a host or a thread", () => {
    const all = [
      req("h2", { createdAt: 1, status: "held", held: held(2), quiet: true }),
      req("r2", { createdAt: 5, status: "running", sessionId: "s2" }),
      req("h1", { createdAt: 4, status: "held", held: held(1) }),
      req("r1", { createdAt: 2, status: "running", quiet: true }),
      req("p", { createdAt: 0 }),
      req("o", { createdAt: 3, status: "running", sessionId: "s3", environmentId: "env_other", hostName: "other" }),
    ];
    expect(inFlightRequests(all).map((r) => r.id)).toEqual(["r1", "o", "r2", "h1", "h2"]);
    expect(inFlightRequests(all, { environmentId: "env_box" }).map((r) => r.id)).toEqual(["r1", "r2", "h1", "h2"]);
    expect(inFlightRequests(all, { sessionId: "s1" }).map((r) => r.id)).toEqual(["r1", "h1", "h2"]);
  });
});

describe("a paused thread's held calls (status paused)", () => {
  it("never get a card: shownRequests and queueOf leave them out", () => {
    const all = [
      req("p", { createdAt: 1, status: "paused" }),
      req("w", { createdAt: 2 }),
      req("r", { createdAt: 3, status: "running" }),
    ];
    expect(shownRequests(all).map((r) => r.id)).toEqual(["w", "r"]);
    const queue = queueOf(all);
    expect(queue.pending.map((r) => r.id)).toEqual(["w"]);
    expect(queue.running.flatMap((g) => g.requests.map((r) => r.id))).toEqual(["r"]);
  });

  it("are rows of the in-flight list after the running and the held ones, in age order, by host or thread", () => {
    const all = [
      req("r", { createdAt: 3, status: "running" }),
      req("p1", { createdAt: 2, status: "paused" }),
      req("p2", { createdAt: 1, status: "paused", sessionId: "s2" }),
      req("w", { createdAt: 0 }),
      req("o", { createdAt: 4, status: "paused", environmentId: "env_other", sessionId: "sx" }),
    ];
    expect(inFlightRequests(all, { environmentId: "env_box" }).map((r) => r.id)).toEqual(["r", "p2", "p1"]);
    expect(inFlightRequests(all, { sessionId: "s1" }).map((r) => r.id)).toEqual(["r", "p1"]);
    expect(inFlightRequests(all).map((r) => r.status)).toEqual(["running", "paused", "paused", "paused"]);
  });
});

describe("the paused strip's Mac jobs", () => {
  it("sums the held counts of the paused roots; the suffix reads as part of the sentence", () => {
    expect(heldTotal({ a: 2, b: 1, c: 5 }, ["a", "b", "x"])).toBe(3);
    expect(heldSuffix(0)).toBe("");
    expect(heldSuffix(1)).toBe(", and 1 Mac job with it");
    expect(heldSuffix(2)).toBe(", and 2 Mac jobs with it");
  });
});
