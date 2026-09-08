import { describe, expect, it } from "vitest";
import {
  EMA_SEED_MS,
  MAX_FADE_MS,
  MIN_FADE_MS,
  commonPrefix,
  fadeDuration,
  nextCadence,
  playbackRate,
} from "./streamVeil";

describe("nextCadence", () => {
  it("blends 70% old and 30% new", () => {
    expect(nextCadence(160, 60)).toBeCloseTo(160 * 0.7 + 60 * 0.3, 9);
  });

  it("caps a long gap at one second", () => {
    expect(nextCadence(160, 5000)).toBeCloseTo(160 * 0.7 + 1000 * 0.3, 9);
  });

  it("settles on a steady cadence", () => {
    let ema = EMA_SEED_MS;
    for (let i = 0; i < 40; i++) ema = nextCadence(ema, 50);
    expect(ema).toBeCloseTo(50, 3);
  });
});

describe("fadeDuration", () => {
  it("is three times the cadence inside the clamp", () => {
    expect(fadeDuration(100)).toBe(300);
  });

  it("clamps to 120–400 ms", () => {
    expect(fadeDuration(10)).toBe(MIN_FADE_MS);
    expect(fadeDuration(1000)).toBe(MAX_FADE_MS);
  });

  it("uses the seed for the first chunk", () => {
    expect(fadeDuration(EMA_SEED_MS)).toBe(MAX_FADE_MS);
  });
});

describe("playbackRate", () => {
  it("stays at 1 until three chunks overlap", () => {
    expect(playbackRate(0)).toBe(1);
    expect(playbackRate(2)).toBe(1);
  });

  it("speeds up by 0.3 per chunk beyond two", () => {
    expect(playbackRate(3)).toBeCloseTo(1.3, 9);
    expect(playbackRate(5)).toBeCloseTo(1.9, 9);
  });
});

describe("commonPrefix", () => {
  it("returns the shared length for an append", () => {
    expect(commonPrefix("abc", "abcdef")).toBe(3);
  });

  it("stops at the first change for a rewrite", () => {
    expect(commonPrefix("abcdef", "abXdef")).toBe(2);
  });

  it("handles empty strings", () => {
    expect(commonPrefix("", "abc")).toBe(0);
    expect(commonPrefix("abc", "abc")).toBe(3);
  });
});
