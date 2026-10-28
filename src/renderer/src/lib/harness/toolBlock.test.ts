import { describe, expect, it } from "vitest";
import type { Block } from "../session";
import { resumeTurnClock } from "./toolBlock";

const user = (over: Partial<Block> = {}): Block => ({ id: "u", role: "user", text: "go", startedAt: 10_000, ...over });
const reply: Block = { id: "a", role: "assistant", text: "ok" };
const stop: Block = { id: "err:3", role: "system", text: "Stopped", stopped: true, ts: 11_000 };
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

  it("a turn the host put down with its harness gone carries its span on at the reopen", () => {
    const [u] = resumeTurnClock([user({ durationMs: 30_000, doneTs: 40_000, stoppedTs: 40_000 }), reply, note], 300_000);
    expect(u).toMatchObject({ startedAt: 270_000 });
    expect(u.durationMs).toBeUndefined();
    expect(u.doneTs).toBeUndefined();
    expect(u.stoppedTs).toBeUndefined();
  });

  it("a pause after a Resume counts on from its span: the error was already resumed from", () => {
    const [u] = resumeTurnClock([user({ startedAt: 20_000, durationMs: 3_000 }), stop], 30_000);
    expect(u).toMatchObject({ startedAt: 27_000 });
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
