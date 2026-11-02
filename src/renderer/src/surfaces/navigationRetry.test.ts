import { describe, expect, it, vi } from "vitest";
import { NAVIGATION_RETRY_FRAMES, revealWhenLoaded } from "./navigationRetry";

function fakeFrames() {
  let queue: (() => void)[] = [];
  return {
    frames: {
      request: (callback: () => void) => queue.push(callback),
      cancel: () => {
        queue = [];
      },
    },
    step() {
      const due = queue;
      queue = [];
      for (const callback of due) callback();
    },
    pending: () => queue.length,
  };
}

describe("revealWhenLoaded", () => {
  it("reveals two frames on when the line is already there", () => {
    const clock = fakeFrames();
    const reveal = vi.fn();
    revealWhenLoaded(() => 100, 40, reveal, clock.frames);
    clock.step();
    expect(reveal).not.toHaveBeenCalled();
    clock.step();
    expect(reveal).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
  });

  it("waits for a document still loading, then reveals once", () => {
    const clock = fakeFrames();
    const reveal = vi.fn();
    let lines = 1;
    revealWhenLoaded(() => lines, 40, reveal, clock.frames);
    for (let i = 0; i < 5; i++) clock.step();
    expect(reveal).not.toHaveBeenCalled();
    lines = 80;
    clock.step();
    expect(reveal).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
  });

  it("gives up on a line past the end: lands where it can and asks for no more frames", () => {
    const clock = fakeFrames();
    const reveal = vi.fn();
    revealWhenLoaded(() => 10, 5_000, reveal, clock.frames);
    for (let i = 0; i < NAVIGATION_RETRY_FRAMES + 2; i++) clock.step();
    expect(reveal).toHaveBeenCalledOnce();
    expect(clock.pending()).toBe(0);
  });

  it("does nothing once cancelled", () => {
    const clock = fakeFrames();
    const reveal = vi.fn();
    const cancel = revealWhenLoaded(() => 1, 40, reveal, clock.frames);
    clock.step();
    cancel();
    for (let i = 0; i < 10; i++) clock.step();
    expect(reveal).not.toHaveBeenCalled();
    expect(clock.pending()).toBe(0);
  });
});
