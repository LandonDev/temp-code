import { describe, expect, it } from "vitest";
import type { Block } from "./session";
import {
  clockForTest,
  isTurnActive,
  passActionsOf,
  turnDurationOf,
  turnElapsed,
  turnStartOf,
  type ClockSession,
} from "./turnClock";

const user = (ts: number): Block => ({ id: `u${ts}`, role: "user", text: "hi", ts });

function session(extra: Partial<ClockSession> = {}): ClockSession {
  return { blocks: [], ...extra };
}

describe("turnStartOf", () => {
  it("prefers the server stamp and falls back to the last user turn", () => {
    expect(turnStartOf(session({ busySince: 500, blocks: [user(100)] }))).toBe(500);
    expect(turnStartOf(session({ blocks: [user(100), user(200)] }))).toBe(200);
    expect(turnStartOf(session())).toBeUndefined();
  });
});

describe("turnElapsed", () => {
  it("runs from busySince while active", () => {
    expect(turnElapsed(session({ status: "running", busySince: 1000 }), 4200)).toBe(3200);
    expect(turnElapsed(session({ status: "waiting", busySince: 1000 }), 1500)).toBe(500);
    expect(turnElapsed(session({ busy: true, busySince: 1000 }), 1500)).toBe(500);
  });

  it("holds the frozen span while paused, tree-wide first", () => {
    expect(turnElapsed(session({ status: "paused", busySince: 1000, frozenActiveElapsed: 7000 }), 99999)).toBe(7000);
    expect(
      turnElapsed(
        session({ status: "paused", frozenActiveElapsed: 7000, treeFrozenActiveElapsed: 9000 }),
        99999,
      ),
    ).toBe(9000);
    expect(turnElapsed(session({ status: "paused" }), 5)).toBe(0);
  });

  it("is null once the turn settled", () => {
    expect(turnElapsed(session({ status: "idle", busySince: 1000 }), 4200)).toBeNull();
    expect(isTurnActive(session({ status: "error" }))).toBe(false);
  });

  it("never runs backwards", () => {
    expect(turnElapsed(session({ status: "running", busySince: 5000 }), 4000)).toBe(0);
  });
});

describe("turnDurationOf", () => {
  it("uses the stamped duration, else doneTs - startedAt", () => {
    expect(turnDurationOf({ ...user(1), durationMs: 42 })).toBe(42);
    expect(turnDurationOf({ ...user(1), startedAt: 10, doneTs: 25 })).toBe(15);
    expect(turnDurationOf(user(1))).toBeUndefined();
    expect(turnDurationOf(undefined)).toBeUndefined();
  });
});

describe("passActionsOf", () => {
  it("reads the pass row's actions", () => {
    expect(passActionsOf({ id: "s", role: "system", text: "Pass: review, commit" })).toEqual(["review", "commit"]);
    expect(passActionsOf({ id: "s", role: "system", text: "Context compacted" })).toBeNull();
    expect(passActionsOf({ id: "s", role: "user", text: "Pass: x" })).toBeNull();
  });
});

describe("shared clock", () => {
  it("keeps one interval for all subscribers and stops with the last", () => {
    let ticks = 0;
    const a = clockForTest.subscribe(() => ticks++);
    const b = clockForTest.subscribe(() => ticks++);
    expect(clockForTest.listeners()).toBe(2);
    clockForTest.tick();
    expect(ticks).toBe(2);
    a();
    b();
    expect(clockForTest.listeners()).toBe(0);
  });
});
