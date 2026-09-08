import { describe, expect, it } from "vitest";
import {
  FLOOR_CPS,
  MAX_LAG,
  TAU_DRAIN_MS,
  TAU_STREAM_MS,
  advanceReveal,
  isRewrite,
} from "./smoothText";

describe("advanceReveal", () => {
  it("reveals remaining × (1 − e^(−dt/τ)) while streaming", () => {
    const next = advanceReveal(0, 1000, TAU_STREAM_MS, true);
    expect(next).toBeCloseTo(1000 * (1 - Math.exp(-1)), 6);
  });

  it("drains faster once the stream ends", () => {
    const live = advanceReveal(0, 1000, 50, true);
    const drain = advanceReveal(0, 1000, 50, false);
    expect(drain).toBeGreaterThan(live);
    expect(drain).toBeCloseTo(1000 * (1 - Math.exp(-50 / TAU_DRAIN_MS)), 6);
  });

  it("never moves slower than the 25 chars/s floor", () => {
    // 2 chars left: exponential step would be tiny; the floor wins.
    const next = advanceReveal(98, 100, 16, true);
    expect(next - 98).toBeCloseTo((16 * FLOOR_CPS) / 1000, 9);
  });

  it("never overshoots the live end", () => {
    expect(advanceReveal(99.9, 100, 1000, false)).toBe(100);
    expect(advanceReveal(100, 100, 16, true)).toBe(100);
  });

  it("skips ahead when the lag exceeds the cap", () => {
    const next = advanceReveal(0, 5000, 16, true);
    expect(5000 - next).toBe(MAX_LAG);
  });

  it("converges to the end in a bounded number of frames", () => {
    let pos = 0;
    let frames = 0;
    while (pos < 400 && frames < 1000) {
      pos = advanceReveal(pos, 400, 16, true);
      frames++;
    }
    expect(pos).toBe(400);
    // Exponential toward the tail then the floor: well under a second of frames.
    expect(frames).toBeLessThan(300);
  });
});

describe("isRewrite", () => {
  it("treats an append as no rewrite", () => {
    expect(isRewrite("hello", "hello world", 5)).toBe(false);
  });

  it("flags a change inside the revealed prefix", () => {
    expect(isRewrite("hello", "jello world", 5)).toBe(true);
  });

  it("ignores changes past the revealed position", () => {
    // "hello " is shared; the first differing glyph sits at index 6.
    expect(isRewrite("hello world", "hello there", 6)).toBe(false);
    expect(isRewrite("hello world", "hello there", 6.9)).toBe(false);
    expect(isRewrite("hello world", "hello there", 7)).toBe(true);
  });
});
