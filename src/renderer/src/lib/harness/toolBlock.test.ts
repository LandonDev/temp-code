import { describe, expect, it } from "vitest";
import type { Block } from "../session";
import { resumeTurnClock } from "./toolBlock";

const user = (over: Partial<Block> = {}): Block => ({ id: "u", role: "user", text: "go", startedAt: 10_000, ...over });
const reply: Block = { id: "a", role: "assistant", text: "ok" };
const stop: Block = { id: "err:3", role: "system", text: "Stopped", stopped: true };
const note: Block = { id: "s:4", role: "system", text: "Context compacted" };

describe("resumeTurnClock", () => {
  it("a paused turn counts on from its frozen span", () => {
    const [u] = resumeTurnClock([user({ durationMs: 3_000 }), reply], 20_000);
    expect(u).toMatchObject({ startedAt: 17_000 });
    expect(u.durationMs).toBeUndefined();
  });

  it("a turn closed on a stop or a failure restarts at the reopen", () => {
    for (const blocks of [
      [user({ durationMs: 1_000, doneTs: 11_000 }), reply, stop],
      [user({ durationMs: 1_000, doneTs: 11_000 }), reply, stop, note],
      [user({ durationMs: 1_000 }), { ...stop, stopped: undefined, text: "boom" }],
    ]) {
      const [u] = resumeTurnClock(blocks, 20_000);
      expect(u).toMatchObject({ startedAt: 20_000 });
      expect(u.durationMs).toBeUndefined();
      expect(u.doneTs).toBeUndefined();
    }
  });

  it("leaves a completed turn, a running turn and a turn with no user row alone", () => {
    const done = [user({ durationMs: 3_000, doneTs: 13_000 }), reply];
    expect(resumeTurnClock(done, 20_000)).toBe(done);
    const running = [user(), reply];
    expect(resumeTurnClock(running, 20_000)).toBe(running);
    const ranOn = [user({ durationMs: 1_000, doneTs: 11_000 }), stop, reply];
    expect(resumeTurnClock(ranOn, 20_000)).toBe(ranOn);
    const none = [reply];
    expect(resumeTurnClock(none, 20_000)).toBe(none);
  });
});
